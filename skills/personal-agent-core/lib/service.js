import { performance } from 'node:perf_hooks'
import { setImmediate } from 'node:timers/promises'
import { BackgroundJobs } from './background-jobs.js'
import { executionEvaluation } from './evaluation.js'
import { criteriaOf, requireCriteria } from './acceptance.js'
import { resolveWorkerPolicy } from './worker-policy.js'
import { AnalysisRuns } from './analysis-runs.js'
import { backgroundLanguage } from './session-history.js'
import { MemorySystem } from './memory-system.js'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { LedgerDatabase } from './database.js'
import { Ledger } from './ledger.js'
import { FeatureFlags } from './feature-flags.js'
import { CodexHistoryImporter } from './codex-history.js'
import { DshHistoryImporter } from './dsh-history.js'
import { CodexDaemonManager } from './codex-daemon.js'
import { CodexAppServerAdapter } from './codex-adapter.js'
import { OutboxDispatcher } from './outbox-dispatcher.js'
import { ApprovalService, APPROVAL_METHODS } from './approvals.js'
import { captureWorkspaceBaseline } from './workspace-baseline.js'
import { route } from './router.js'
import { answerWithCitations } from './citations.js'
import { retrievalInfo } from './fts.js'
import { cleanText, decodeRpcId, newId, nowIso, parseJson, sha256 } from './ids.js'
import { historyCheckpoint } from './history-work.js'
import { clearCodexHistory, historyWindow } from './history-retention.js'
import { defaultRuntimeSettings, resolveRuntimeSettings } from './runtime-settings.js'

const objectiveTokens = text => new Set((String(text ?? '').toLocaleLowerCase().match(/[\p{Script=Han}]|[\p{L}\p{N}_]+/gu) ?? []).filter(token => token.length > 0))

const objectiveScore = (left, right) => {
  const a = objectiveTokens(left)
  const b = objectiveTokens(right)
  if (!a.size || !b.size) return 0
  if (String(left).trim().toLocaleLowerCase() === String(right).trim().toLocaleLowerCase()) return 1
  let overlap = 0
  for (const token of a) if (b.has(token)) overlap += 1
  return (2 * overlap) / (a.size + b.size)
}

const ASSISTANT_TASK_SOURCE = `(source_key LIKE 'assistant-session:%' OR source_key LIKE 'native-request:%' OR source_key LIKE 'native:%')`
const DEFAULT_ACCEPTANCE = ['Verify the result against the objective and record evidence']
const TERMINAL_TASK_STATES = new Set(['completed', 'cancelled', 'merged'])
const RETRYABLE_CODEX_NOTIFICATION_METHODS = ['turn/started', 'turn/completed', 'item/completed', 'thread/tokenUsage/updated']

const dashboardTask = row => ({
  id: row.task_id,
  title: row.objective,
  state: row.task_state,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at,
  workerCount: Number(row.worker_count ?? 0),
  ...(row.acceptance_json === undefined ? {} : { acceptance: parseJson(row.acceptance_json, []) }),
})

export class PersonalAgentService {
  constructor(config, { context = null, logger = console } = {}) {
    this.config = config
    this.initialConfig = config
    this.context = context
    this.logger = logger
    this.database = new LedgerDatabase(config)
    this.ledger = null
    this.flags = null
    this.codexImporter = null
    this.dshImporter = null
    this.daemon = null
    this.adapter = null
    this.dispatcher = null
    this.approvals = null
    this.memory = null
    this.importing = null
    this.codexToggleOperation = null
    this.memoryInitializationOperation = null
    this.codexHistoryScans = new Set()
    this.inboxRetryOperation = null
    this.historyLifetime = new AbortController()
    this.workerLifetime = new AbortController()
    this.dshActivations = new Set()
    this.workerHandles = new Map()
    this.workerTimers = new Map()
    this.activeInternalExecutions = new Map()
    this.executingRequests = new Map()
    this.inFlightOperations = new Set()
    this.publicOperations = new Set()
    this.threadEpochs = new Map()
    this.assistantSessionIds = new Set()
    this.lastImport = null
    this.lastBackup = null
    this.recovery = null
    this.disposed = false
    this.runtimeSettings = defaultRuntimeSettings(config)
    this.historyConfig = config
  }

  trackOperation(operation, label = 'background operation') {
    const tracked = Promise.resolve().then(() => typeof operation === 'function' ? operation() : operation).catch(error => {
      if (this.historyLifetime.signal.aborted && error?.name === 'AbortError') return null
      this.logger?.warn?.(`Personal-agent ${label} failed`, error)
      return null
    })
    this.inFlightOperations.add(tracked)
    tracked.finally(() => this.inFlightOperations.delete(tracked)).catch(() => {})
    return tracked
  }

  async initialize() {
    this.database.open()
    this.backgroundJobs = new BackgroundJobs(this.database.db)
    this.analysisRuns = new AnalysisRuns(this.database.db, this.context, { signal: this.historyLifetime.signal })
    this.ledger = new Ledger(this.database)
    this.ledger.history.service = this
    this.flags = new FeatureFlags(this.database)
    this.loadRuntimeSettings()
    this.historyConfig = this.resolveHistoryConfig(this.runtimeSettings)
    this.codexImporter = new CodexHistoryImporter(this.ledger, this.historyConfig)
    this.dshImporter = new DshHistoryImporter(this.ledger)
    this.daemon = new CodexDaemonManager(this.config, { logger: this.logger })
    this.adapter = new CodexAppServerAdapter(this.config, { ledger: this.ledger, logger: this.logger, authorizeMutation: method => this.isCodexMutationAuthorized(method) })
    this.dispatcher = new OutboxDispatcher(this.ledger, this.adapter, { logger: this.logger })
    this.approvals = new ApprovalService(this.ledger, this.adapter)
    this.memory = new MemorySystem(this)
    this.recovery = this.database.recoverLocalState()
    this.adapter.on('serverRequest', request => { if (!this.disposed && !this.memoryInitializationOperation) this.trackOperation(() => this.onServerRequest(request), 'server request') })
    this.adapter.on('notification', notification => { if (!this.disposed && !this.memoryInitializationOperation) this.projectCodexNotification(notification) })
    this.applyConfiguredFlags()
    this.invalidateStaleServerRequests()
    if (this.config.inboxRetryEnabled && !this.disposed) await this.retryInboxProjections()
    if (this.flags.enabled('codex.daemon.connect')) await this.connectCodex()
    return this.health()
  }

  /** Reject new requests while destructive memory maintenance owns the ledger. */
  assertMemoryAvailable() {
    if (this.disposed) throw new Error('Personal-agent service is disposed')
    if (this.memoryInitializationOperation) throw Object.assign(new Error('记忆正在初始化，请等待操作完成后重试。'), { code: 'MEMORY_INITIALIZING', statusCode: 409 })
  }

  /** Track accepted HTTP work so initialization waits for its final database access. */
  request(operation) {
    this.assertMemoryAvailable()
    const pending = Promise.resolve().then(operation).finally(() => this.publicOperations.delete(pending))
    this.publicOperations.add(pending)
    return pending
  }

  /** Return initialization progress, including an interrupted run after Host restart. */
  memoryInitializationView() {
    const status = this.backgroundJobs.state('memory-initialization')
    return { ...status, state: status.lastError ? 'failed' : status.state ?? 'idle', running: !!this.memoryInitializationOperation }
  }

  /** Reject clearing an execution whose external outcome is still unknown. */
  assertMemoryWorkersIdle() {
    const active = this.database.db.prepare("SELECT execution_id FROM executions WHERE execution_state NOT IN ('succeeded','failed','cancelled','interrupted') LIMIT 1").get()
    if (active || this.executingRequests.size || this.dshActivations.size || this.workerHandles.size || this.activeInternalExecutions.size) {
      throw Object.assign(new Error('仍有执行中或待对账的任务，请先结束任务并完成对账，再初始化记忆。'), { code: 'MEMORY_WORKERS_ACTIVE', statusCode: 409 })
    }
  }

  /** Start a user-confirmed reset; repeated submissions share the accepted operation. */
  initializeMemory({ confirmed = false } = {}) {
    if (confirmed !== true) throw new TypeError('初始化记忆需要确认清空范围。')
    if (this.memoryInitializationOperation) return this.memoryInitializationView()
    this.assertMemoryAvailable()
    this.assertMemoryWorkersIdle()
    this.backgroundJobs.save({ name: 'memory-initialization', state: 'running', phase: 'draining', running: true, startedAt: nowIso(), cleared: false, lastError: null })
    this.memoryInitializationOperation = Promise.resolve().then(() => this.resetMemory()).catch(error => {
      this.backgroundJobs.save({ ...this.backgroundJobs.state('memory-initialization'), state: 'failed', running: false, finishedAt: nowIso(), lastError: String(error?.message ?? error) })
      this.logger?.warn?.('Personal-agent memory initialization failed', error)
    }).finally(() => { this.memoryInitializationOperation = null })
    return this.memoryInitializationView()
  }

  /** Drain old writers, clear local records, restore bindings and import source history once. */
  async resetMemory() {
    const phase = value => this.backgroundJobs.save({ ...this.backgroundJobs.state('memory-initialization'), phase: value })
    let reconnectCodex = false
    this.historyLifetime.abort()
    try {
      const pending = () => [...this.publicOperations, ...this.inFlightOperations, ...this.codexHistoryScans,
        ...this.backgroundJobs.running.values(), this.importing, this.memory.running, this.codexToggleOperation, this.inboxRetryOperation].filter(Boolean)
      while (pending().length) await Promise.allSettled(pending())
      if (this.disposed) throw new Error('Host 已停止，记忆初始化已取消。')
      this.assertMemoryWorkersIdle()
      reconnectCodex = this.adapter.initialized
      await this.adapter.close()
      if (this.disposed) throw new Error('Host 已停止，记忆初始化已取消。')
      const sessions = this.database.db.prepare("SELECT external_id,first_seen_at,last_seen_at FROM session_refs WHERE system='dsh' AND source_kind='personal_assistant'").all()
      const jobs = this.backgroundJobs.list().filter(job => job.name !== 'memory-initialization')
      phase('clearing')
      this.database.clearManagedBackups()
      const status = this.backgroundJobs.state('memory-initialization')
      this.database.transaction(() => {
        const removed = this.database.clearMemoryData()
        for (const session of sessions) this.ledger.upsertSession({ system: 'dsh', externalId: session.external_id, sourceKind: 'personal_assistant', durability: 'durable', firstSeenAt: session.first_seen_at, lastSeenAt: session.last_seen_at })
        for (const job of jobs) this.backgroundJobs.configure(job.name, !!job.enabled, job.intervalMs)
        this.backgroundJobs.save({ ...status, cleared: true, removed })
      })
      this.lastImport = null
      this.lastBackup = null
      this.threadEpochs.clear()
      for (const timer of this.workerTimers.values()) clearTimeout(timer)
      this.workerTimers.clear()
      this.recovery = this.database.recoverLocalState()
    } finally {
      if (!this.disposed) {
        this.historyLifetime = new AbortController()
        this.analysisRuns = new AnalysisRuns(this.database.db, this.context, { signal: this.historyLifetime.signal })
        if (reconnectCodex) {
          phase('reconnecting')
          await this.connectCodex()
        }
      }
    }
    phase('importing')
    const history = this.flags.enabled('history.read')
      ? await this.backgroundJobs.run('history', () => this.importHistory({ initialization: true, full: true }))
      : { skipped: true, reason: 'history-disabled' }
    const importError = this.flags.enabled('history.read') ? this.backgroundJobs.state('history').lastError : null
    if (importError) throw new Error(`本地记录已清空，但历史导入需要处理：${importError}`)
    phase('indexing')
    this.memory.rebuildIndex()
    this.backgroundJobs.save({ ...this.backgroundJobs.state('memory-initialization'), state: 'succeeded', phase: 'done', running: false, finishedAt: nowIso(), history, lastError: null })
  }

  loadRuntimeSettings() {
    const row = this.database.db.prepare('SELECT settings_json FROM runtime_settings WHERE singleton=1').get()
    if (row) {
      const persisted = JSON.parse(row.settings_json)
      let removed = false
      for (const key of ['knowledgeEnabled','knowledgeIntervalMs','knowledgeBatchSize','knowledgeRetryLimit','hourlyScanEnabled','hourlyScanIntervalMs','reviewDiscoveryRecords','reviewBatchSize','reviewRetryLimit','reviewOverlapMs']) {
        if (Object.hasOwn(persisted, key)) { delete persisted[key]; removed = true }
      }
      this.runtimeSettings = resolveRuntimeSettings(persisted, defaultRuntimeSettings(this.config))
      if (removed) this.database.db.prepare('UPDATE runtime_settings SET settings_json=?,updated_at=? WHERE singleton=1').run(JSON.stringify(this.runtimeSettings), nowIso())
    }
    this.config = Object.freeze({ ...this.config, ...this.runtimeSettings })
    this.database.config = this.config
  }

  resolveHistoryConfig(settings) {
    return Object.freeze({
      ...this.config,
      historyRetentionDays: settings.historyRetentionDays,
      historyBatchSize: settings.historyBatchSize,
      historyBatchMs: settings.historyBatchMs,
      historyReadBytes: settings.historyReadBytes,
      maxImportFileBytes: settings.maxImportFileBytes,
      maxHistoryRecordBytes: settings.maxHistoryRecordBytes,
    })
  }

  runtimeSettingsView() {
    const defaults = { ...defaultRuntimeSettings(this.initialConfig) }
    return {
      settings: { ...this.runtimeSettings },
      defaults,
      source: this.database.db.prepare('SELECT 1 FROM runtime_settings WHERE singleton=1').get() ? 'saved-settings' : 'profile-config',
      jobs: this.backgroundJobs?.list().filter(job => job.name !== 'memory-initialization') ?? [],
      progress: { history: this.lastImport, memory: this.memory.status(), inbox: this.inboxRetryStatus() },
    }
  }

  /** Validate and save runtime-editable preferences without bypassing Codex side effects.
   * @param input - submitted runtime settings.
   * @returns the previous and current settings with their source and job status.
   */
  updateRuntimeSettings(input) {
    this.assertMemoryAvailable()
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Settings must be a JSON object')
    if (this.codexToggleOperation) throw new Error('Codex settings are currently being changed')
    if (Object.hasOwn(input, 'codexWorkerEnabled') && input.codexWorkerEnabled !== this.runtimeSettings.codexWorkerEnabled) {
      throw new Error('Use the Codex settings switch to change Codex history and worker availability')
    }
    const submitted = input
    if (Object.hasOwn(submitted, 'historySyncEnabled') && !Object.hasOwn(submitted, 'historyStartupSyncEnabled')) submitted.historyStartupSyncEnabled = submitted.historySyncEnabled
    if (Object.hasOwn(submitted, 'historySyncEnabled') && !Object.hasOwn(submitted, 'historyPeriodicSyncEnabled')) submitted.historyPeriodicSyncEnabled = submitted.historySyncEnabled
    const next = resolveRuntimeSettings(submitted, this.runtimeSettings)
    const previous = this.runtimeSettingsView().settings
    this.persistRuntimeSettings(next)
    return { previous, ...this.runtimeSettingsView() }
  }

  /** Persist already-validated settings and replace the importer's effective configuration.
   * @param next - complete validated runtime settings.
   * @param options - reserved for runtime persistence behavior.
   * @returns nothing.
   * @private
   */
  persistRuntimeSettings(next) {
    this.database.transaction(() => {
      this.database.db.prepare(`INSERT INTO runtime_settings(singleton,settings_json,updated_at) VALUES(1,?,?)
        ON CONFLICT(singleton) DO UPDATE SET settings_json=excluded.settings_json,updated_at=excluded.updated_at`)
        .run(JSON.stringify(next), nowIso())
    })
    this.runtimeSettings = next
    this.config = Object.freeze({ ...this.config, ...next, dshWorkerEnabled: next.dshWorkerEnabled, codexWorkerEnabled: next.codexWorkerEnabled, dshWorkerPresets: Object.freeze([...next.dshWorkerPresets]), defaultDshPreset: next.defaultDshPreset, workerBudgetMs: next.workerBudgetMs, routeResumeThreshold: next.routeResumeThreshold })
    this.database.config = this.config
    this.historyConfig = this.resolveHistoryConfig(next)
    this.codexImporter = new CodexHistoryImporter(this.ledger, this.historyConfig)
  }

  /** Apply the Codex history and worker setting through its serialized side effects.
   * @param enabled - whether Codex history and worker routing should be enabled.
   * @returns the import or cleanup result and the resulting setting.
   */
  setCodexEnabled(enabled) {
    this.assertMemoryAvailable()
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean')
    if (this.disposed) return Promise.reject(new Error('Personal-agent service is disposed'))
    if (this.codexToggleOperation) throw new Error('Codex settings are currently being changed')
    let operation
    operation = Promise.resolve().then(() => this.changeCodexEnabled(enabled)).finally(() => {
      if (this.codexToggleOperation === operation) this.codexToggleOperation = null
      this.publicOperations.delete(operation)
    })
    this.codexToggleOperation = operation
    this.publicOperations.add(operation)
    return operation
  }

  /** Complete the serialized Codex import, enablement, or cleanup operation.
   * @param enabled - desired Codex availability.
   * @returns the import or cleanup result.
   * @private
   */
  async changeCodexEnabled(enabled) {
    if (this.disposed) throw new Error('Personal-agent service is disposed')
    const previous = this.runtimeSettings.codexWorkerEnabled
    if (previous === enabled) return { enabled, unchanged: true }
    if (enabled) {
      this.flags.assert('history.read')
      await this.waitForHistoryImport()
      const config = this.historyConfig
      const checkpoint = historyCheckpoint(config, this.historyLifetime.signal)
      try {
        const history = await this.codexImporter.run({
          totalByteBudget: config.maxImportFileBytes,
          checkpoint,
          window: historyWindow(config),
        })
        this.persistRuntimeSettings(resolveRuntimeSettings({ codexWorkerEnabled: true }, this.runtimeSettings))
        this.lastImport = { at: nowIso(), codex: history, dsh: null, reason: 'codex-enabled' }
        return { enabled: true, history }
      } catch (error) {
        try { await clearCodexHistory(this.ledger) }
        catch (cleanupError) { error.cleanupError = cleanupError }
        throw error
      }
    }

    this.persistRuntimeSettings(resolveRuntimeSettings({ codexWorkerEnabled: false }, this.runtimeSettings))
    try {
      await this.waitForHistoryImport()
      await this.waitForCodexHistoryScans()
      const checkpoint = historyCheckpoint(this.historyConfig, this.historyLifetime.signal)
      const history = await clearCodexHistory(this.ledger, { checkpoint })
      return { enabled: false, history }
    } catch (error) {
      this.persistRuntimeSettings(resolveRuntimeSettings({ codexWorkerEnabled: previous }, this.runtimeSettings))
      throw error
    }
  }

  /** Wait for the active shared import to settle before changing its source set.
   * @returns nothing.
   * @private
   */
  async waitForHistoryImport() {
    if (!this.importing) return
    try { await this.importing }
    catch (error) {
      if (error?.name !== 'AbortError') this.logger?.warn?.('Personal-agent history import failed while changing Codex settings', error)
    }
  }

  /** Run and track one Codex rollout scan so disabling waits for its file reads to finish.
   * @param operation - Codex history scan to run.
   * @returns the scan result, or zero when Codex is disabled.
   */
  runCodexHistoryScan(operation) {
    if (!this.config.codexWorkerEnabled || !this.flags.enabled('history.read')) return Promise.resolve(0)
    const scan = Promise.resolve().then(operation)
    this.codexHistoryScans.add(scan)
    scan.then(() => this.codexHistoryScans.delete(scan), () => this.codexHistoryScans.delete(scan))
    return scan
  }

  /** Drain active Codex rollout scans before their mirrors are removed.
   * @returns nothing.
   * @private
   */
  async waitForCodexHistoryScans() {
    while (this.codexHistoryScans.size) await Promise.allSettled([...this.codexHistoryScans])
  }

  isCodexMutationAuthorized(method) {
    if (method === 'thread/start') return this.flags.enabled('codex.new_thread.execute')
    if (method === 'thread/resume') return this.flags.enabled('routing.resume')
    if (method === 'thread/fork') return this.flags.enabled('routing.fork')
    if (method === 'turn/start') return ['codex.new_thread.execute','routing.resume','routing.fork'].some(flag => this.flags.enabled(flag))
    if (method === 'turn/interrupt') return this.flags.enabled('task.native') && this.flags.enabled('codex.daemon.connect')
    if (method === 'turn/steer') return this.flags.enabled('control.steer')
    // Queued turns need their own baseline and lease handoff before this can be enabled safely.
    if (method.startsWith('thread/queue/')) return false
    return false
  }

  applyConfiguredFlags() {
    const desired = {
      'history.read': this.config.historyRead,
      'task.native': this.config.taskNative,
      'codex.daemon.connect': this.config.codexConnect,
      'codex.new_thread.execute': this.config.codexMutations,
      'routing.resume': this.config.routingResume,
      'routing.fork': this.config.routingFork,
    }
    const current = this.database.db.prepare('SELECT flag_name,enabled,source FROM feature_flags').all()
    for (const row of current) {
       if (['default','plugin_config'].includes(row.source) && desired[row.flag_name] !== undefined && !!row.enabled !== desired[row.flag_name]) {
         this.flags.set(row.flag_name, desired[row.flag_name], { actor: 'plugin_config' })
       }
     }
  }

  async connectCodex() {
    this.flags.assert('codex.daemon.connect')
    const daemon = await this.daemon.ensureStarted()
    const server = await this.adapter.connect()
    this.invalidateStaleApprovals()
    this.invalidateStaleServerRequests()
    const reconciliation = await this.reconcileExecutions()
    return { daemon, server, reconciliation, adapterInstanceId: this.adapter.adapterInstanceId, connectionEpoch: this.adapter.connectionEpoch }
  }

  invalidateStaleApprovals() {
    const stale = this.database.db.prepare(`SELECT approval_id,execution_id FROM approvals
      WHERE approval_state='pending' AND (adapter_instance_id<>? OR connection_epoch<>?)`)
      .all(this.adapter.adapterInstanceId, this.adapter.connectionEpoch)
    if (!stale.length) return 0
    const ids = stale.map(row => row.execution_id)
    const placeholders = ids.map(() => '?').join(',')
    return this.database.transaction(() => {
      const at = nowIso()
      this.database.db.prepare(`UPDATE approvals SET approval_state='invalidated',decided_at=?
        WHERE approval_state='pending' AND (adapter_instance_id<>? OR connection_epoch<>?)`)
        .run(at, this.adapter.adapterInstanceId, this.adapter.connectionEpoch)
      this.database.db.prepare(`UPDATE executions SET execution_state='reconciling'
        WHERE execution_state='waiting_approval' AND execution_id IN (${placeholders})`).run(...ids)
      this.database.db.prepare(`UPDATE leases SET lease_state='recovery_hold',heartbeat_at=?,release_reason=COALESCE(release_reason,'approval connection lost')
        WHERE mode='write' AND lease_state='active' AND execution_id IN (${placeholders})`).run(at, ...ids)
      this.database.db.prepare(`UPDATE attention_items SET state='resolved',updated_at=?
        WHERE state='open' AND kind='approval_required' AND execution_id IN (${placeholders})`).run(at, ...ids)
      return stale.length
    })
  }

  invalidateStaleServerRequests() {
    const methods = [...APPROVAL_METHODS]
    const placeholders = methods.map(() => '?').join(',')
    return this.database.db.prepare(`UPDATE inbox SET processed_at=?,process_error=NULL
      WHERE processed_at IS NULL AND method IN (${placeholders})
        AND (adapter_instance_id<>? OR connection_epoch<>?)`)
      .run(nowIso(), ...methods, this.adapter.adapterInstanceId, this.adapter.connectionEpoch).changes
  }

  async reconcileExecutions() {
    const rows = this.database.db.prepare(`SELECT e.* FROM executions e WHERE e.executor_kind='codex' AND e.execution_state IN ('dispatch_unknown','reconciling')`).all()
    const summary = { examined: rows.length, running: 0, terminal: 0, unresolved: 0 }
    for (const row of rows) {
      const execution = row.execution_state === 'dispatch_unknown'
        ? this.ledger.transitionExecution(row.execution_id, 'reconciling', { expectedState: row.execution_state })
        : row
      const refs = this.database.db.prepare(`SELECT sr.external_id,sr.source_kind FROM execution_sessions es JOIN session_refs sr USING(session_ref_id) WHERE es.execution_id=?`).all(execution.execution_id)
      const threadId = refs.find(ref => ref.source_kind !== 'app_server_turn')?.external_id
      const turnId = refs.find(ref => ref.source_kind === 'app_server_turn')?.external_id
      if (!threadId) { summary.unresolved += 1; continue }
      try {
        const result = await this.adapter.request('thread/read', { threadId, includeTurns: true })
        const turns = result?.thread?.turns ?? []
        const turn = turnId ? turns.find(candidate => candidate.id === turnId) : turns.at(-1)
        if (!turn) { summary.unresolved += 1; continue }
        this.projectCodexNotification({ method: turn.status === 'inProgress' ? 'turn/started' : 'turn/completed', params: { threadId, turn } })
        if (turn.status === 'inProgress') summary.running += 1
        else summary.terminal += 1
      } catch (error) {
        summary.unresolved += 1
        this.openAttention({ taskId: execution.task_id, executionId: execution.execution_id, kind: 'reconciliation_failed', severity: 'high', summary: `Could not reconcile Codex execution ${execution.execution_id}`, detail: { threadId, turnId, error: cleanText(error?.message ?? error, 1000) } })
      }
    }
    return summary
  }

  /** Retry projections cooperatively; an in-flight transport reply settles before the batch stops. */
  retryInboxProjections() {
    if (this.memoryInitializationOperation) return Promise.resolve({ skipped: true, reason: 'memory-initializing' })
    if (this.inboxRetryOperation) return this.inboxRetryOperation
    if (this.disposed) return Promise.reject(new Error('Personal-agent service is disposed'))
    const operation = this.retryInboxBatch().finally(() => {
      this.inboxRetryOperation = null
      this.inFlightOperations.delete(operation)
    })
    this.inboxRetryOperation = operation
    this.inFlightOperations.add(operation)
    return operation
  }

  inboxRetryStatus() {
    const limit = this.config.inboxRetryLimit
    return {
      counts: this.database.db.prepare("SELECT CASE WHEN processed_at IS NOT NULL THEN 'processed' WHEN retry_attempts>=? THEN 'exhausted' WHEN process_error IS NOT NULL THEN 'error' ELSE 'pending' END AS state,COUNT(*) AS count FROM inbox GROUP BY state").all(limit),
      errors: this.database.db.prepare(`SELECT inbox_id,method,retry_attempts,process_error FROM inbox
        WHERE processed_at IS NULL AND (process_error IS NOT NULL OR retry_attempts>=?) ORDER BY received_at,inbox_id LIMIT 10`).all(limit),
      recovery: 'Inspect the source and execution state; an authenticated operator can reset one record with retry_inbox and sourceKey=inbox_id. This never grants approval.',
    }
  }

  async retryInboxBatch() {
    const config = this.config
    const signal = this.historyLifetime.signal
    const deadline = performance.now() + config.inboxRetryBudgetMs
    const options = { limit: config.inboxBatchSize, maxAttempts: config.inboxRetryLimit }
    const notificationRows = this.ledger.pendingInbox({ ...options, methods: RETRYABLE_CODEX_NOTIFICATION_METHODS })
    const approvalRows = this.adapter.initialized
      ? this.ledger.pendingInbox({ ...options, methods: [...APPROVAL_METHODS], adapterInstanceId: this.adapter.adapterInstanceId, connectionEpoch: this.adapter.connectionEpoch })
      : []
    const rows = [...notificationRows, ...approvalRows].sort((a,b) => a.retry_attempts - b.retry_attempts || a.received_at.localeCompare(b.received_at) || a.inbox_id.localeCompare(b.inbox_id)).slice(0, config.inboxBatchSize)
    let examined = 0
    let completed = 0
    let failed = 0
    let budgetExceeded = false
    for (const row of rows) {
      await setImmediate(undefined, { signal })
      signal.throwIfAborted()
      if (performance.now() >= deadline) { budgetExceeded = true; break }
      const claimed = this.database.db.prepare(`UPDATE inbox SET retry_attempts=retry_attempts+1,last_attempt_at=?
        WHERE inbox_id=? AND processed_at IS NULL AND retry_attempts<?`).run(nowIso(), row.inbox_id, config.inboxRetryLimit)
      if (!claimed.changes) continue
      examined += 1
      try {
        if (APPROVAL_METHODS.has(row.method)) {
          await this.onServerRequest({
            handle: { adapterInstanceId: row.adapter_instance_id, connectionEpoch: row.connection_epoch, externalRequestId: decodeRpcId(row.external_event_id) },
            method: row.method, params: parseJson(row.payload_json, {}), inboxId: row.inbox_id,
          })
        } else this.projectCodexNotification({ method: row.method, params: parseJson(row.payload_json, {}), inboxId: row.inbox_id })
      } catch (error) { this.ledger.failInbox(row.inbox_id, error.message) }
      const result = this.database.db.prepare('SELECT processed_at,process_error FROM inbox WHERE inbox_id=?').get(row.inbox_id)
      if (result?.processed_at) completed += 1
      else {
        failed += 1
        if (!result?.process_error) this.ledger.failInbox(row.inbox_id, 'Projection did not confirm completion; inspect the execution before retrying')
      }
    }
    return { examined, completed, failed, budgetExceeded, ...this.inboxRetryStatus() }
  }

  async onServerRequest(request) {
    const complete = () => { if (request.inboxId) this.ledger.completeInbox(request.inboxId) }
    if (!APPROVAL_METHODS.has(request.method)) {
      try {
        await this.adapter.replyToServerRequest(request.handle, { error: { code: -32601, message: `Unsupported client request: ${request.method}` } })
        complete()
      } catch (error) {
        if (request.inboxId) this.ledger.failInbox(request.inboxId, error.message)
      }
      return
    }
    const params = request.params ?? {}
    const execution = this.findExecution(params, { claimPendingTurn: true })
    if (!execution) {
      try {
        await this.adapter.replyToServerRequest(request.handle, { error: { code: -32001, message: 'No authorized execution owns this request' } })
        complete()
      } catch (error) {
        if (request.inboxId) this.ledger.failInbox(request.inboxId, error.message)
      }
      return
    }
    try {
      this.database.transaction(() => {
        const approval = this.approvals.capture({ executionId: execution.execution_id, handle: request.handle, method: request.method, params })
        const current = this.database.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(execution.execution_id)
        if (current.execution_state !== 'waiting_approval') this.ledger.transitionExecution(execution.execution_id, 'waiting_approval', { expectedState: current.execution_state })
        const attention = this.database.db.prepare(`SELECT attention_id FROM attention_items
          WHERE execution_id=? AND kind='approval_required' AND state='open' AND json_extract(detail_json,'$.approvalId')=?`).get(execution.execution_id, approval.approvalId)
        if (!attention) this.openAttention({ taskId: execution.task_id, executionId: execution.execution_id, kind: 'approval_required', severity: 'high', summary: `Codex approval required: ${request.method}`, detail: { approvalId: approval.approvalId } })
        this.database.db.prepare(`UPDATE attention_items SET state='resolved',updated_at=?
          WHERE execution_id=? AND kind='projection_failed' AND state='open' AND json_extract(detail_json,'$.method')=?`).run(nowIso(), execution.execution_id, request.method)
        complete()
      })
    } catch (error) {
      if (request.inboxId) this.ledger.failInbox(request.inboxId, error.message)
      // Keep the inbox retryable. Sending a terminal error here would make a later projection retry duplicate the JSON-RPC response.
      this.openAttention({ taskId: execution.task_id, executionId: execution.execution_id, kind: 'projection_failed', severity: 'high', summary: 'Codex approval projection failed', detail: { error: cleanText(error?.message ?? error, 1000), method: request.method } })
    }
  }

  projectCodexNotification(notification = {}) {
    const { method, params = {}, inboxId = null } = notification ?? {}
    let execution = null
    let turnId = params?.turn?.id ?? params?.turnId ?? null
    const complete = () => this.database.transaction(() => {
      if (execution) this.database.db.prepare(`UPDATE attention_items SET state='resolved',updated_at=?
        WHERE execution_id=? AND kind='projection_failed' AND state='open' AND json_extract(detail_json,'$.method')=?`).run(nowIso(), execution.execution_id, method)
      if (inboxId) this.ledger.completeInbox(inboxId)
      return true
    })
    try {
      if (method === 'thread/tokenUsage/updated') {
        execution = this.findExecution(params)
        if (execution && params.tokenUsage) this.database.db.prepare('INSERT OR REPLACE INTO execution_usage VALUES(?,?,?,?,?,?)')
          .run(execution.execution_id, 'codex-turn-tokens', null, null, JSON.stringify(params.tokenUsage), nowIso())
      }
      if (method === 'item/completed') {
        execution = this.findExecution(params)
        if (execution && params.item) this.ledger.ingestSource({ sourceSystem: 'codex', sourceKind: 'worker_item', externalId: params.threadId, sourceUri: `codex://thread/${params.threadId}`, sourceLocator: `turn:${params.turnId}:item:${params.item.id}`, sourceIdentity: sha256(JSON.stringify(params.item)), text: JSON.stringify(params.item), taskId: execution.task_id, executionId: execution.execution_id, trustLevel: 'local' })
      }
      if (!['turn/started','turn/completed'].includes(method)) {
        return complete()
      }
      if (!turnId) throw new Error('Codex turn notification has no turn id')
      execution = this.findExecution(params, { claimPendingTurn: method === 'turn/started' })
      if (!execution) throw new Error(`No execution is attached to Codex turn ${turnId}`)
      this.ledger.heartbeatExecution(execution.execution_id, this.config.leaseTtlMs)
      if (method === 'turn/started' && ['dispatch_pending','dispatch_unknown','reconciling'].includes(execution.execution_state)) {
        this.ledger.transitionExecution(execution.execution_id, 'running', { expectedState: execution.execution_state, startedAt: params.turn?.startedAt ? new Date(params.turn.startedAt * 1000).toISOString() : undefined })
        return complete()
      }
      if (method !== 'turn/completed') return complete()
      const timer = this.workerTimers.get(execution.execution_id)
      if (timer) { clearTimeout(timer); this.workerTimers.delete(execution.execution_id) }
      const status = params.turn?.status
      const next = status === 'completed' ? 'succeeded' : status === 'interrupted' ? 'interrupted' : status === 'failed' ? 'failed' : null
      if (!next) return complete()
      if (['succeeded','failed','cancelled','interrupted'].includes(execution.execution_state)) {
        if (execution.execution_state !== next) throw new Error(`Codex turn terminal state conflicts with execution state ${execution.execution_state}`)
        const lease = this.database.db.prepare(`SELECT lease_id FROM leases WHERE execution_id=? AND lease_state IN ('active','recovery_hold')`).get(execution.execution_id)
        if (lease) this.ledger.releaseLease(lease.lease_id, 'terminal')
        if (next === 'succeeded') {
          const task = this.database.db.prepare('SELECT task_state FROM tasks WHERE task_id=?').get(execution.task_id)
          if (task && ['open','active'].includes(task.task_state)) this.ledger.transitionTask(execution.task_id, 'waiting', task.task_state)
        }
        return complete()
      }
      if (!['dispatch_pending','dispatch_unknown','running','reconciling','waiting_approval','waiting_user'].includes(execution.execution_state)) return complete()
      if (['dispatch_pending','dispatch_unknown'].includes(execution.execution_state)) {
        const running = this.ledger.transitionExecution(execution.execution_id, 'running', { expectedState: execution.execution_state })
        execution.execution_state = running.execution_state
      }
      this.ledger.ingestSource({ sourceSystem: 'codex', sourceKind: 'worker_terminal', externalId: params.threadId, sourceUri: `codex://thread/${params.threadId}`, sourceLocator: `turn:${turnId}:terminal`, sourceIdentity: sha256(JSON.stringify(params.turn)), text: JSON.stringify(params.turn), taskId: execution.task_id, executionId: execution.execution_id, trustLevel: 'local' })
      this.ledger.transitionExecution(execution.execution_id, next, {
        expectedState: execution.execution_state,
        resultClass: status,
        failureCode: params.turn?.error?.codexErrorInfo ?? (status === 'failed' ? 'codex_turn_failed' : null),
        failureDetail: params.turn?.error ? JSON.stringify(params.turn.error) : null,
        finishedAt: params.turn?.completedAt ? new Date(params.turn.completedAt * 1000).toISOString() : undefined,
      })
      const lease = this.database.db.prepare(`SELECT lease_id FROM leases WHERE execution_id=? AND lease_state IN ('active','recovery_hold')`).get(execution.execution_id)
      if (lease) this.ledger.releaseLease(lease.lease_id, 'terminal')
      if (next === 'succeeded') {
        const task = this.database.db.prepare('SELECT task_state FROM tasks WHERE task_id=?').get(execution.task_id)
        if (task && ['open','active'].includes(task.task_state)) this.ledger.transitionTask(execution.task_id, 'waiting', task.task_state)
      }
      return complete()
    } catch (error) {
      const message = cleanText(error?.message ?? error, 1000)
      let failureRecorded = false
      if (inboxId) {
        try { failureRecorded = this.ledger.failInbox(inboxId, message) }
        catch (recordError) { this.logger?.error?.('Unable to persist Codex notification projection failure', recordError) }
      }
      try { execution ??= this.findExecution(params) }
      catch (lookupError) { this.logger?.warn?.('Unable to identify the execution for a failed Codex notification', lookupError) }
      let attentionRecorded = false
      if (execution) {
        try {
          this.openAttention({ taskId: execution.task_id, executionId: execution.execution_id, kind: 'projection_failed', severity: 'high', summary: `Codex notification projection failed: ${method}`, detail: { error: message, method, turnId } })
          attentionRecorded = true
        } catch (attentionError) { this.logger?.error?.('Unable to persist Codex notification attention', attentionError) }
      }
      if (!failureRecorded && !attentionRecorded) this.logger?.warn?.(`Codex notification projection failed: ${method}`, error)
      return false
    }
  }

  findExecution(params, { claimPendingTurn = false } = {}) {
    const turnId = params.turn?.id ?? params.turnId ?? null
    if (turnId) {
      const byTurn = this.database.db.prepare(`SELECT e.* FROM executions e
        JOIN execution_sessions es USING(execution_id)
        JOIN session_refs sr USING(session_ref_id)
        WHERE sr.system='codex' AND sr.source_kind='app_server_turn' AND sr.external_id=?
        ORDER BY e.attempt_no DESC LIMIT 1`).get(turnId)
      if (byTurn) return byTurn
      if (!claimPendingTurn || !params.threadId) return null
      const candidates = this.database.db.prepare(`SELECT DISTINCT e.* FROM executions e
        JOIN execution_sessions es USING(execution_id)
        JOIN session_refs sr USING(session_ref_id)
        JOIN outbox o USING(execution_id)
        WHERE sr.system='codex' AND sr.source_kind='app_server_thread' AND sr.external_id=?
          AND o.method='turn/start'
          AND e.execution_state IN ('dispatch_pending','dispatch_unknown','reconciling')
          AND NOT EXISTS (
            SELECT 1 FROM execution_sessions turn_es
            JOIN session_refs turn_sr USING(session_ref_id)
            WHERE turn_es.execution_id=e.execution_id AND turn_sr.system='codex' AND turn_sr.source_kind='app_server_turn'
          )
        ORDER BY e.attempt_no DESC LIMIT 2`).all(params.threadId)
      if (candidates.length !== 1) return null
      const turn = this.ledger.upsertSession({ system: 'codex', externalId: turnId, sourceKind: 'app_server_turn', durability: 'durable' })
      this.ledger.attachExecutionSession(candidates[0].execution_id, turn.sessionRefId, { role: 'executor' })
      return candidates[0]
    }
    if (params.threadId) return this.database.db.prepare(`SELECT e.* FROM executions e
      JOIN execution_sessions es USING(execution_id)
      JOIN session_refs sr USING(session_ref_id)
      WHERE sr.system='codex' AND sr.source_kind='app_server_thread' AND sr.external_id=?
        AND e.execution_state NOT IN ('succeeded','failed','cancelled','interrupted')
      ORDER BY e.attempt_no DESC LIMIT 1`).get(params.threadId)
    return null
  }

  openAttention({ taskId = null, executionId = null, kind, severity, summary, detail = {} }) {
    const attentionId = newId('attention')
    const at = nowIso()
    this.database.db.prepare('INSERT INTO attention_items(attention_id,task_id,execution_id,kind,severity,state,summary,detail_json,created_at,updated_at) VALUES(?,?,?,?,?,\'open\',?,?,?,?)')
      .run(attentionId, taskId, executionId, kind, severity, cleanText(summary, 500), JSON.stringify(detail), at, at)
    return attentionId
  }

  /**
   * Synchronize history cooperatively, sharing an existing import with concurrent callers.
   * @param options - `full` removes the total rollout byte budget for a newly started import.
   * @returns Import summaries; rejects on cancellation before the database is closed.
   */
  async importHistory({ full = false, initialization = false } = {}) {
    this.historyLifetime.signal.throwIfAborted()
    if (!initialization) this.assertMemoryAvailable()
    this.flags.assert('history.read')
    if (this.codexToggleOperation) {
      try { await this.codexToggleOperation }
      catch (error) { this.logger?.warn?.('Personal-agent Codex settings change failed before history sync', error) }
      return this.importHistory({ full })
    }
    if (this.importing) return this.importing
    this.importing = (async () => {
      const config = this.historyConfig
      const importer = this.codexImporter
      const checkpoint = historyCheckpoint(config, this.historyLifetime.signal)
      await checkpoint(true)
      const window = { ...historyWindow(config), cutoff: -8640000000000000 }
      let codex = config.codexWorkerEnabled
        ? await importer.run({ totalByteBudget: full ? Number.MAX_SAFE_INTEGER : config.maxImportFileBytes, checkpoint, window })
        : { skipped: true, reason: 'codex-disabled' }
      if(full && config.codexWorkerEnabled) {
        let imported=codex.rollouts.evidenceImported,bytesRead=codex.rollouts.bytesRead
        while(!codex.rollouts.complete && !codex.rollouts.warnings.length) {
          await checkpoint(true)
          if(!codex.rollouts.bytesRead)throw new Error('History import made no progress; inspect source warnings and retry')
          codex=await importer.run({totalByteBudget:Number.MAX_SAFE_INTEGER,checkpoint,window})
          imported+=codex.rollouts.evidenceImported;bytesRead+=codex.rollouts.bytesRead
        }
        codex.rollouts.evidenceImported=imported;codex.rollouts.bytesRead=bytesRead
      }
      const dsh = await this.dshImporter.importFromPersistence(this.context?.sessionPersistence, { checkpoint, window, prune: this.config.cleanupEnabled })
      this.historyLifetime.signal.throwIfAborted()
      this.lastImport = { at: nowIso(), cutoff: new Date(window.cutoff).toISOString(), retentionDays: config.historyRetentionDays, codex, dsh }
      return this.lastImport
    })().finally(() => { this.importing = null })
    return this.importing
  }

  createAssistantTask({ sessionId, objective } = {}) {
    this.assertMemoryAvailable()
    const externalId = cleanText(sessionId, 500)
    const title = cleanText(objective, 8_000)
    if (!externalId) throw new TypeError('sessionId is required')
    if (!title) throw new TypeError('objective is required')
    return this.database.transaction(() => {
      const session = this.ledger.upsertSession({
        system: 'dsh',
        externalId,
        sourceKind: 'personal_assistant',
        durability: 'durable',
        nativeStatus: 'active',
      })
      const task = this.ledger.createTask({ objective: title, sourceKey: `native-request:${newId('request')}`, state: 'active', confidence: 1, acceptance: DEFAULT_ACCEPTANCE })
      this.ledger.attachTaskSession(task.taskId, session.sessionRefId, { relation: 'primary', confidence: 1 })
      return { ...dashboardTask(this.database.db.prepare('SELECT * FROM tasks WHERE task_id=?').get(task.taskId)), sessionId: externalId }
    })
  }

  registerAssistantSession(sessionId) {
    this.assertMemoryAvailable()
    const normalized = cleanText(sessionId, 500)
    if (!normalized) throw new TypeError('A native DSH session id is required')
    this.assistantSessionIds.add(normalized)
    return this.ledger.upsertSession({ system: 'dsh', externalId: normalized, sourceKind: 'personal_assistant', durability: 'durable' })
  }

  async assistantSessionTarget() {
    const row = this.database.db.prepare(`SELECT external_id FROM session_refs WHERE system='dsh' AND source_kind='personal_assistant'
      ORDER BY last_seen_at DESC,first_seen_at DESC,external_id LIMIT 1`).get()
    return cleanText(row?.external_id, 500) || null
  }

  isAssistantSession(sessionId) {
    const normalized = cleanText(sessionId, 500)
    if (!normalized) return false
    if (this.assistantSessionIds.has(normalized)) return true
    const db = this.database?.db
    if (!db) return false
    const persisted = db.prepare(`SELECT 1 WHERE
      EXISTS(SELECT 1 FROM session_refs WHERE system='dsh' AND external_id=? AND source_kind='personal_assistant')
      OR EXISTS(SELECT 1 FROM tasks WHERE parent_task_id IS NULL AND source_key=?)`)
      .get(normalized, `assistant-session:${normalized}`)
    if (!persisted) return false
    this.assistantSessionIds.add(normalized)
    return true
  }

  health() {
    return {
      ok: true,
      database: this.database.health(),
      recovery: this.recovery,
      backgroundJobs: this.backgroundJobs?.list() ?? [],
      lastImport: this.lastImport,
      lastBackup: this.lastBackup,
      backups: this.database.listManagedBackups().slice(0, 3).map(({ name, bytes, mtimeMs }) => ({ name, bytes, createdAt: new Date(mtimeMs).toISOString() })),
      importing: !!this.importing,
      memory: this.memory?.status() ?? null,
      codex: { connected: !!this.adapter?.initialized, socketPath: this.config.codexSocketPath, epoch: this.adapter?.connectionEpoch ?? 0 },
      workers: this.workerCapabilities(),
      evaluation: this.executionEvaluation(),
    }
  }

  dashboard() {
    const tasks = this.database.db.prepare(`WITH RECURSIVE task_tree(root_task_id,task_id) AS (
        SELECT task_id,task_id FROM tasks WHERE parent_task_id IS NULL AND ${ASSISTANT_TASK_SOURCE}
        UNION ALL
        SELECT task_tree.root_task_id,child.task_id FROM tasks child JOIN task_tree ON child.parent_task_id=task_tree.task_id
      ), worker_counts AS (
        SELECT task_tree.root_task_id,COUNT(DISTINCT execution_sessions.session_ref_id) AS worker_count
        FROM task_tree
        JOIN executions ON executions.task_id=task_tree.task_id
        JOIN execution_sessions ON execution_sessions.execution_id=executions.execution_id
        GROUP BY task_tree.root_task_id
      )
      SELECT tasks.task_id,tasks.objective,tasks.task_state,tasks.created_at,tasks.updated_at,tasks.completed_at,tasks.acceptance_json,
        COALESCE(worker_counts.worker_count,0) AS worker_count
      FROM tasks LEFT JOIN worker_counts ON worker_counts.root_task_id=tasks.task_id
      WHERE tasks.parent_task_id IS NULL AND ${ASSISTANT_TASK_SOURCE}
      ORDER BY tasks.updated_at DESC,tasks.task_id`).all().map(dashboardTask)
    return {
      codex: { connected: !!this.adapter?.initialized },
      workers: this.workerCapabilities(),
      evaluation: this.executionEvaluation(),
      tasks: {
        active: tasks.filter(task => !TERMINAL_TASK_STATES.has(task.state)),
        completed: tasks.filter(task => TERMINAL_TASK_STATES.has(task.state)),
      },
    }
  }

  /** Live extraction status and operational run history, separate from memory records. */
  memoryExtractionView(options = {}) {
    const job = this.backgroundJobs.state('memory-extraction')
    return { ...this.memory.status(), enabled: this.config.memoryExtractionEnabled,
      nextRunAt: job.nextRunAt ?? null, ...this.analysisRuns.failures(options) }
  }

  workerCapabilities() {
    const subagents = this.context?.get?.('subagents') ?? this.context?.subagents
    const providerCapability = name => {
      const provider = typeof subagents?.getProvider === 'function' ? subagents.getProvider(name) : null
      return provider
        ? { available: true, inheritsParentContext: !!provider.inheritsParentContext, capabilities: { ...provider.capabilities } }
        : { available: false, inheritsParentContext: null, capabilities: null }
    }
    return {
      dsh: { enabled: this.config.dshWorkerEnabled, available: !!subagents?.startActivation, presets: [...this.config.dshWorkerPresets], defaultPreset: this.config.defaultDshPreset, budgetMs: this.config.workerBudgetMs, providers: { spawn: providerCapability('spawn'), fork: providerCapability('fork') } },
      codex: { enabled: this.config.codexWorkerEnabled, available: this.config.codexWorkerEnabled && this.flags.enabled('codex.daemon.connect') && (this.flags.enabled('codex.new_thread.execute') || this.flags.enabled('routing.resume') || this.flags.enabled('routing.fork')), connected: !!this.adapter?.initialized, budgetMs: this.config.workerBudgetMs },
    }
  }

  async recordDshUsage(executionId, sessionId, fromSeq = 0, toSeq = Infinity) {
    const persistence = this.context?.sessionPersistence
    if (!persistence?.open) return
    await persistence.flush()
    const handle = await persistence.open(sessionId, 'read')
    try {
      let offset = fromSeq
      while (offset < toSeq) {
        const batch = await handle.read(offset, Math.min(256, toSeq - offset))
        for (const event of batch.events) if (event.type === 'assistant/message' && event.data.usage) this.database.db.prepare('INSERT OR IGNORE INTO execution_usage VALUES(?,?,?,?,?,?)')
          .run(executionId, `${sessionId}:${event.seq}`, event.data.message?.source?.provider ?? null, event.data.message?.source?.model ?? null, JSON.stringify(event.data.usage), nowIso())
        offset += batch.events.length
        if (batch.events.length < Math.min(256, toSeq - (offset - batch.events.length))) break
      }
    } finally { await handle.close() }
  }

  executionEvaluation() {
    return executionEvaluation(this.database.db)
  }

  dashboardTaskDetail(taskId) {
    const root = this.database.db.prepare(`SELECT task_id,project_id,objective,task_state,created_at,updated_at,completed_at,acceptance_json
      FROM tasks WHERE task_id=? AND parent_task_id IS NULL AND ${ASSISTANT_TASK_SOURCE}`).get(taskId)
    if (!root) {
      const error = new Error('Top-level assistant task does not exist')
      error.code = 'ASSISTANT_TASK_NOT_FOUND'
      error.statusCode = 404
      throw error
    }
    const rows = this.database.db.prepare(`WITH RECURSIVE task_tree(task_id) AS (
        SELECT task_id FROM tasks WHERE task_id=?
        UNION ALL SELECT child.task_id FROM tasks child JOIN task_tree ON child.parent_task_id=task_tree.task_id
      ) SELECT session.session_ref_id,session.system,session.external_id,session.native_status,
        execution.execution_state,execution.attempt_no,route.semantic_action,route.delivery_action,outbox.params_json
      FROM task_tree
      JOIN executions execution ON execution.task_id=task_tree.task_id
      JOIN execution_sessions mapping ON mapping.execution_id=execution.execution_id
      JOIN session_refs session ON session.session_ref_id=mapping.session_ref_id
      LEFT JOIN route_decisions route ON route.route_decision_id=execution.route_decision_id
      LEFT JOIN outbox ON outbox.execution_id=execution.execution_id
      WHERE mapping.role IN ('executor','fork_source')
      ORDER BY session.session_ref_id,execution.attempt_no DESC,COALESCE(execution.started_at,execution.finished_at) DESC`).all(taskId)
    const workers = new Map()
    for (const row of rows) {
      const params = parseJson(row.params_json, {})
      const route = row.semantic_action && row.delivery_action ? `${row.semantic_action}:${row.delivery_action}` : null
      let worker = workers.get(row.session_ref_id)
      if (!worker) {
        worker = {
          sessionId: row.external_id,
          system: row.system,
          status: row.native_status || row.execution_state || null,
          model: params.model ?? null,
          route,
        }
        workers.set(row.session_ref_id, worker)
        continue
      }
      worker.model ??= params.model ?? null
      worker.route ??= route
    }
    return {
      task: { ...dashboardTask(root), workerCount: workers.size, verification: this.ledger.acceptanceStatus(taskId), steps: this.ledger.listTaskSteps(taskId) },
      workers: [...workers.values()],
    }
  }

  listTasks({ state = null, limit = 50 } = {}) {
    const clauses = []
    const args = []
    if (state) { clauses.push('task_state=?'); args.push(state) }
    return this.database.db.prepare(`SELECT task_id,project_id,objective,task_state,source_key,confidence,created_at,updated_at,completed_at FROM tasks ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ?`).all(...args, Math.min(200, Math.max(1, limit)))
  }

  createBackup({ verify = true } = {}) {
    const name = `ledger-${new Date().toISOString().replaceAll(':','-')}.sqlite`
    const backup = this.database.backup(this.database.backupPath(name))
    const verification = verify ? this.database.validateManagedBackup(name) : null
    const removed = this.database.pruneManagedBackups(this.runtimeSettings.backupRetention)
    this.lastBackup = { at: nowIso(), name, verified: verification?.ok === true, removed }
    return { backup, verification, removed }
  }

  approvalsPending() {
    return this.database.db.prepare(`SELECT approval_id,execution_id,kind,scope_json,risk_summary,requested_at,expires_at FROM approvals WHERE approval_state='pending' ORDER BY requested_at`).all()
      .map(row => ({ ...row, scope: parseJson(row.scope_json, {}) }))
  }

  buildCandidates({ objective, projectId = null, explicitTaskId = null, limit = 8 } = {}) {
    const rows = this.database.db.prepare(`SELECT t.task_id,t.project_id,t.objective,t.task_state,t.confidence,t.updated_at,
      sr.session_ref_id,sr.external_id,sr.source_kind,sr.cwd,sr.durability,sr.native_status,sr.last_seen_at
      FROM tasks t LEFT JOIN task_sessions ts ON ts.task_id=t.task_id
      LEFT JOIN session_refs sr ON sr.session_ref_id=ts.session_ref_id AND sr.system='codex' AND sr.durability='durable'
      WHERE (t.source_key IS NULL OR (t.source_key NOT LIKE 'dsh:%' AND t.source_key NOT LIKE 'codex-thread:%')) AND t.task_state NOT IN ('cancelled','merged') AND (t.project_id IS ? OR ? IS NOT NULL) AND (? IS NULL OR t.task_id=?)
      ORDER BY t.updated_at DESC,sr.last_seen_at DESC LIMIT ?`).all(projectId, explicitTaskId, explicitTaskId, explicitTaskId, Math.max(1, Math.min(50, limit * 4)))
    const byTask = new Map()
    for (const row of rows) {
      let candidate = byTask.get(row.task_id)
      if (!candidate) {
        const score = explicitTaskId === row.task_id ? 1 : objectiveScore(objective, row.objective)
        candidate = { taskId: row.task_id, projectId: row.project_id, objective: row.objective, state: row.task_state, score, objectiveCompatible: explicitTaskId === row.task_id || (row.project_id === projectId && score >= this.config.routeResumeThreshold), sessions: [] }
        byTask.set(row.task_id, candidate)
      }
      if (row.session_ref_id) candidate.sessions.push({ sessionRefId: row.session_ref_id, externalId: row.external_id, sourceKind: row.source_kind, cwd: row.cwd, durability: row.durability, nativeStatus: row.native_status, lastSeenAt: row.last_seen_at })
    }
    for (const candidate of byTask.values()) {
      const session = candidate.sessions.find(item => item.sourceKind === 'app_server_thread')
      if (session) {
        candidate.sessionRefId = session.sessionRefId
        candidate.threadId = session.externalId
        const completed = this.database.db.prepare(`SELECT turn.external_id AS turn_id FROM executions e
          JOIN execution_sessions ets ON ets.execution_id=e.execution_id AND ets.role='executor'
          JOIN session_refs thread ON thread.session_ref_id=ets.session_ref_id
          JOIN execution_sessions evs ON evs.execution_id=e.execution_id AND evs.role='executor'
          JOIN session_refs turn ON turn.session_ref_id=evs.session_ref_id AND turn.source_kind='app_server_turn'
          WHERE e.task_id=? AND thread.external_id=? AND e.execution_state='succeeded'
          ORDER BY e.finished_at DESC LIMIT 1`).get(candidate.taskId, session.externalId)
        candidate.lastCompletedTurnId = completed?.turn_id ?? null
      }
      delete candidate.sessions
    }
    return [...byTask.values()].sort((a, b) => b.score - a.score || a.taskId.localeCompare(b.taskId)).slice(0, limit)
  }

  backgroundModelSelection() {
    const policy = this.config.backgroundModelPolicy ? this.config.modelPolicies[this.config.backgroundModelPolicy] : null
    return policy ? { provider: policy.provider, model: policy.model, ...(policy.effort ? { reasoningEffort: policy.effort } : {}) } : this.context?.agentDefaultModel?.currentSelection?.()
  }

  async semanticCandidates({ objective, projectId = null, explicitTaskId, signal }) {
    const candidates = this.buildCandidates({ objective, projectId, explicitTaskId })
    if (explicitTaskId || !this.config.semanticRoutingEnabled || !candidates.length || !this.context?.sessionController) return candidates
    const analysis = await this.analysisRuns.run({
      selection: this.backgroundModelSelection(), purpose: 'task-association', defaultLanguage: this.config.defaultLanguage, instructions: 'Compare the request with candidate objectives. Return {"candidates":[{"taskId":"existing id","compatible":true,"confidence":0.0,"reason":"brief explanation"}]}. Different goals or projects must not merge. Ambiguous continuation is incompatible.',
      input: { objective, projectId, candidates: candidates.map(({ taskId, objective, projectId }) => ({ taskId, objective, projectId })) },
      signal, budgetMs: this.config.analysisBudgetMs, maxInputChars: this.config.analysisInputChars, maxOutputChars: this.config.analysisOutputChars,
    })
    if (!Array.isArray(analysis.value.candidates)) throw new Error('Invalid semantic candidate result')
    return candidates.map(candidate => {
      const inferred = analysis.value.candidates.find(item => item.taskId === candidate.taskId)
      if (!inferred || typeof inferred.compatible !== 'boolean' || !Number.isFinite(inferred.confidence) || inferred.confidence < 0 || inferred.confidence > 1 || typeof inferred.reason !== 'string') return { ...candidate, score: 0, objectiveCompatible: false }
      return { ...candidate, score: inferred.confidence, objectiveCompatible: inferred.compatible && candidate.projectId === projectId, semanticReason: inferred.reason.slice(0, 500), analysisSessionId: analysis.sessionId }
    }).sort((a, b) => b.score - a.score)
  }

  nativeRequestResult(triggerId) {
    const row = this.database.db.prepare(`SELECT e.execution_id,e.task_id,e.execution_state,e.executor_kind,r.route_decision_id FROM route_decisions r JOIN executions e ON e.route_decision_id=r.route_decision_id WHERE r.trigger_id=? ORDER BY e.attempt_no DESC LIMIT 1`).get(triggerId)
    return row ? { repeated: true, triggerId, routeDecisionId: row.route_decision_id, taskId: row.task_id, executionId: row.execution_id, executionState: row.execution_state, worker: row.executor_kind } : null
  }

  priorExecutionRequest(triggerId) {
    const decision = this.database.db.prepare(`SELECT route_decision_id,task_id,semantic_action,delivery_action,reason_codes_json,explanation,decided_at
      FROM route_decisions WHERE trigger_id=? ORDER BY decided_at DESC LIMIT 1`).get(triggerId)
    if (!decision) return null
    const executions = this.database.db.prepare(`SELECT execution_id,attempt_no,execution_state,result_class,failure_code,started_at,finished_at
      FROM executions WHERE route_decision_id=? ORDER BY attempt_no`).all(decision.route_decision_id)
    const retryable = executions.length === 0 || executions.every(item => ['failed','cancelled','interrupted'].includes(item.execution_state))
    if (retryable) return null
    return {
      repeated: true,
      triggerId,
      routeDecisionId: decision.route_decision_id,
      taskId: decision.task_id,
      decision: { semanticAction: decision.semantic_action, deliveryAction: decision.delivery_action, reasonCodes: parseJson(decision.reason_codes_json, []), explanation: decision.explanation },
      executions,
    }
  }

  activateTask(taskId) {
    let task = this.ledger.getTask(taskId)
    if (!task) throw new Error('Task does not exist')
    if (task.state === 'candidate') task = this.ledger.transitionTask(taskId, 'open', task.state)
    if (task.state === 'open' || task.state === 'waiting') task = this.ledger.transitionTask(taskId, 'active', task.state)
    return task
  }

  completeControlExecution(executionId) {
    const execution = this.database.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(executionId)
    if (execution?.execution_state === 'running') return this.ledger.transitionExecution(executionId, 'succeeded', { expectedState: execution.execution_state, resultClass: 'control_acknowledged' })
    return execution
  }

  async canonicalWorkspacePath(workspacePath, { requireAllowed = false } = {}) {
    if (!path.isAbsolute(workspacePath ?? '')) throw new Error('workspacePath must be absolute')
    const canonicalPath = await realpath(workspacePath)
    if (requireAllowed) {
      if (!this.config.allowedWorkspaceRoots.length) throw new Error('Codex workspace mutation requires an explicitly configured allowedWorkspaceRoots entry')
      let allowed = false
      for (const configuredRoot of this.config.allowedWorkspaceRoots) {
        const root = await realpath(configuredRoot)
        const relative = path.relative(root, canonicalPath)
        if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
          allowed = true
          break
        }
      }
      if (!allowed) throw new Error('workspacePath is outside the configured Codex workspace allowlist')
    }
    return canonicalPath
  }

  activeTurnWorkspaceAuthority({ taskId, threadId, turnId, workspacePath }) {
    if (!taskId || !threadId || !turnId || !workspacePath) return null
    return this.database.db.prepare(`SELECT e.execution_id,l.lease_id,pl.canonical_path
      FROM executions e
      JOIN outbox o ON o.execution_id=e.execution_id AND o.method='turn/start'
      JOIN workspace_baselines b ON b.baseline_id=e.workspace_baseline_id AND b.capture_complete=1
      JOIN project_locations pl ON pl.location_id=e.workspace_location_id AND pl.location_id=b.workspace_location_id
      JOIN leases l ON l.execution_id=e.execution_id AND l.workspace_location_id=e.workspace_location_id
        AND l.mode='write' AND l.lease_state='active' AND l.expires_at>? AND l.owner_instance_id=?
      JOIN execution_sessions thread_es ON thread_es.execution_id=e.execution_id
      JOIN session_refs thread_ref ON thread_ref.session_ref_id=thread_es.session_ref_id
        AND thread_ref.system='codex' AND thread_ref.source_kind='app_server_thread' AND thread_ref.external_id=?
      JOIN execution_sessions turn_es ON turn_es.execution_id=e.execution_id
      JOIN session_refs turn_ref ON turn_ref.session_ref_id=turn_es.session_ref_id
        AND turn_ref.system='codex' AND turn_ref.source_kind='app_server_turn' AND turn_ref.external_id=?
      WHERE e.task_id=? AND e.execution_state IN ('running','waiting_approval','waiting_user') AND pl.canonical_path=?
      ORDER BY e.attempt_no DESC LIMIT 1`).get(nowIso(), this.ledger.instanceId, threadId, turnId, taskId, workspacePath) ?? null
  }

  threadParams(args) {
    const params = { cwd: args.workspacePath ?? null, runtimeWorkspaceRoots: args.workspacePath ? [args.workspacePath] : undefined }
    for (const key of ['model','modelProvider','developerInstructions','personality']) if (args[key] !== undefined) params[key] = args[key]
    return params
  }

  turnParams(args, threadId) {
    const params = {
      threadId,
      input: [{ type: 'text', text: JSON.stringify({ objective: cleanText(args.objective, 8_000), taskId: args.taskId, stepId: args.stepId ?? null, constraints: args.constraints ?? [], acceptance: args.acceptance ?? this.ledger.getTask(args.taskId)?.acceptance ?? [], requiredArtifacts: args.requiredArtifacts ?? [] }), text_elements: [] }],
      cwd: args.workspacePath ?? undefined,
      runtimeWorkspaceRoots: args.workspacePath ? [args.workspacePath] : undefined,
      responsesapiClientMetadata: { personalAgentTaskId: args.taskId, personalAgentRouteDecisionId: args.routeDecisionId },
    }
    for (const key of ['model','effort','personality']) if (args[key] !== undefined) params[key] = args[key]
    return params
  }

  executionRequestFingerprint(args, { codexMutationAuthority = false, callerWorkspaceRoot = null, agent = null } = {}) {
    const fields = ['requestId','objective','taskId','stepId','projectId','workspacePath','worker','provider','agentPreset','model','modelProvider','effort','personality','developerInstructions','constraints','acceptance','requiredArtifacts','requestedCapabilities','mutatesWorkspace','forceNew','forceFork','kind','relevantPaths']
    return sha256(JSON.stringify({ request: Object.fromEntries(fields.map(key => [key, args[key] ?? null])), authority: codexMutationAuthority ? 'operator' : 'restricted', callerWorkspaceRoot, sessionId: agent?.session?.id ?? null }))
  }

  async executeObjective(args, { codexMutationAuthority = false, callerWorkspaceRoot = null, agent = null, signal = null } = {}) {
    if (this.disposed) throw new Error('Personal-agent service is disposed')
    const normalized = { ...args, requestId: args.requestId || newId('request') }
    const requestId = cleanText(normalized.requestId, 500)
    if (!requestId) throw new Error('requestId must not be empty')
    const keyFingerprint = this.executionRequestFingerprint(normalized, { codexMutationAuthority, callerWorkspaceRoot, agent })
    const key = `${codexMutationAuthority ? 'operator' : 'restricted'}:${agent?.session?.id ?? 'operator'}:${requestId}`
    if (this.executingRequests.has(key)) {
      const pending = this.executingRequests.get(key)
      if (pending.requestFingerprint !== keyFingerprint) throw new Error('Request id is already bound to a different payload or authority scope')
      return pending
    }
    const triggerId = this.ledger.recordTrigger({ kind: 'execute', sourceSessionRefId: this.bindCurrentSession(null, agent)?.sessionRefId ?? null, sourceMessageId: normalized.sourceMessageId ?? null, content: keyFingerprint, dedupeKey: `worker-request:${key}` })
    const prior = this.nativeRequestResult(triggerId)
    if (prior) return prior
    normalized._triggerId = triggerId
    const effectiveSignal = signal ? AbortSignal.any([this.workerLifetime.signal, signal]) : this.workerLifetime.signal
    const execution = this._executeObjective(normalized, { codexMutationAuthority, callerWorkspaceRoot, agent, signal: effectiveSignal }).finally(() => this.executingRequests.delete(key))
    execution.requestFingerprint = keyFingerprint
    this.executingRequests.set(key, execution)
    return execution
  }

  async _executeObjective(args, { codexMutationAuthority = false, callerWorkspaceRoot = null, agent = null, signal = null } = {}) {
    this.flags.assert('task.native')
    const objective = cleanText(args.objective, 8_000)
    if (!objective) throw new Error('execute requires an objective')
    if (args.worker === 'codex' && Object.hasOwn(args, 'agentPreset')) throw new Error('agentPreset is only valid for a DSH worker')
    if (Object.hasOwn(args, 'acceptance')) requireCriteria(args.acceptance)
    if (!args.workspacePath && args.mutatesWorkspace !== false) {
      const inherited = callerWorkspaceRoot ?? (agent && this.context?.workingDirectory ? await this.context.workingDirectory.ensure(agent, signal) : null)
      if (!inherited) throw new Error('Execution requires workspacePath or explicit mutatesWorkspace:false')
      args = { ...args, workspacePath: inherited }
    }
    if (args.taskId && args.stepId) this.ledger.assertStepReady(args.taskId, args.stepId)
    if (!args.taskId && !args.forceNew && args.worker !== 'codex') {
      const projectId = args.projectId ?? (args.workspacePath ? this.ledger.upsertProject({ canonicalPath: args.workspacePath }).projectId : null)
      const candidates = await this.semanticCandidates({ objective, projectId, signal })
      const qualified = candidates.filter(item => item.objectiveCompatible && item.score >= this.config.routeResumeThreshold)
      if (qualified.length > 1 && qualified[0].score - qualified[1].score < this.config.routeAmbiguityGap) return { clarificationRequired: true, candidates: qualified.slice(0, 3), reason: 'Several tasks fit this objective; select taskId or forceNew' }
      if (qualified[0] && !TERMINAL_TASK_STATES.has(qualified[0].state)) args = { ...args, taskId: qualified[0].taskId, association: qualified[0] }
    }
    if (args.worker === 'codex' && Object.hasOwn(args, 'agentPreset')) throw new Error('agentPreset is only valid for a DSH worker')
    if (args.stepId && !args.taskId) throw new Error('stepId requires an explicit taskId')
    if (args.taskId) args = this.withExecutionCriteria(args)
    if (args.worker !== 'internal') {
      const subagents = this.context?.get?.('subagents') ?? this.context?.subagents
      const policy = resolveWorkerPolicy(this.config, args, {
        dsh_subagent: this.config.dshWorkerEnabled && !!subagents?.startActivation,
        codex: this.config.codexWorkerEnabled && this.flags.enabled('codex.daemon.connect') && (this.flags.enabled('codex.new_thread.execute') || this.flags.enabled('routing.resume') || this.flags.enabled('routing.fork')),
      })
      const model = policy.model ?? {}
      args = { ...args, worker: policy.worker, ...(policy.agentPreset ? { agentPreset: policy.agentPreset } : {}), model: args.model ?? model.model, modelProvider: args.modelProvider ?? model.provider, effort: args.effort ?? model.effort, resolvedPolicy: policy }
    }
    const worker = args.worker
    if (!['codex', 'dsh_subagent', 'internal'].includes(worker)) throw new Error('worker must be codex, dsh_subagent, or internal')
    if (worker === 'internal') return this._beginInternalObjective({ ...args, objective }, { callerWorkspaceRoot, agent, signal })
    if (worker === 'codex' && !this.config.codexWorkerEnabled) throw new Error('Codex worker is disabled by plugin configuration')
    if (worker === 'dsh_subagent' && !this.config.dshWorkerEnabled) throw new Error('DSH worker is disabled by plugin configuration')
    if (worker === 'dsh_subagent') return this._executeDshObjective({ ...args, objective }, { callerWorkspaceRoot, agent, signal })
    if (args.agentPreset !== undefined) throw new Error('agentPreset is only valid for a DSH worker')
    const trustedAssistant = agent && this.isAssistantSession(agent.session.id)
    if (!codexMutationAuthority && !trustedAssistant && !callerWorkspaceRoot) throw new Error('Agent-bound caller workspace context is required for execution requests')
    if (args.workspacePath) args = { ...args, workspacePath: await this.canonicalWorkspacePath(args.workspacePath, { requireAllowed: true }) }
    if (!codexMutationAuthority && !trustedAssistant) {
      if (!args.workspacePath) throw new Error('workspacePath is required for caller-scoped execution requests')
      const callerRoot = await this.canonicalWorkspacePath(callerWorkspaceRoot, { requireAllowed: false })
      const relative = path.relative(callerRoot, args.workspacePath)
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('workspacePath is outside the caller workspace')
    }

    let projectId = args.projectId ?? null
    if (args.taskId) {
      const explicitTask = this.ledger.getTask(args.taskId)
      if (!explicitTask) throw new Error('Explicit task does not exist')
      if (projectId && explicitTask.projectId && projectId !== explicitTask.projectId) throw new Error('taskId does not belong to projectId')
      projectId ??= explicitTask.projectId
    }
    if (args.workspacePath) {
      const project = this.ledger.upsertProject({ name: args.projectName, canonicalPath: path.resolve(args.workspacePath) })
      if (projectId && projectId !== project.projectId) throw new Error('projectId does not match workspacePath')
      projectId = project.projectId
    }
    if (!args.workspacePath && projectId) {
      const location = this.database.db.prepare('SELECT canonical_path FROM project_locations WHERE project_id=? ORDER BY observed_at DESC LIMIT 1').get(projectId)
      if (location) args = { ...args, workspacePath: await this.canonicalWorkspacePath(location.canonical_path, { requireAllowed: true }) }
    }
    if (!args.workspacePath) throw new Error('A workspacePath or projectId with a known location is required for Codex execution')

    const requestKey = cleanText(args.requestId || newId('request'), 500)
     const requestFingerprint = sha256(JSON.stringify({ requestId: requestKey, objective, taskId: args.taskId ?? null, projectId, workspacePath: args.workspacePath ?? null, authority: codexMutationAuthority ? 'operator' : 'restricted', callerWorkspaceRoot: callerWorkspaceRoot ?? null }))
    const sourceSession = this.bindCurrentSession(null, agent)
    const triggerId = args._triggerId ?? this.ledger.recordTrigger({ kind: 'execute', sourceSessionRefId: sourceSession?.sessionRefId ?? null, sourceMessageId: args.sourceMessageId ?? null, content: JSON.stringify({ objective, requestFingerprint }), dedupeKey: `execute:${requestKey}:${requestFingerprint}` })
    const prior = this.priorExecutionRequest(triggerId)
    if (prior) return prior

    const candidates = await this.semanticCandidates({ objective, projectId, explicitTaskId: args.taskId ?? null, signal })
    let runtime = { loaded: false, externalWriter: false, turnState: 'idle', sameAdapterConnection: false, experimentalApi: this.config.experimentalCodexApi }
    const selected = candidates[0]
    if (codexMutationAuthority && selected?.threadId && this.flags.enabled('codex.daemon.connect')) {
      if (!this.adapter.initialized) await this.connectCodex()
      const [loadedResult, readResult] = await Promise.all([
        this.adapter.request('thread/loaded/list', { limit: 200 }),
        this.adapter.request('thread/read', { threadId: selected.threadId, includeTurns: true }),
      ])
      const loaded = loadedResult?.data ?? loadedResult?.threads ?? []
      const turns = readResult?.thread?.turns ?? []
      const active = turns.find(turn => turn.status === 'inProgress')
      const sameAdapterConnection = this.threadEpochs.get(selected.threadId) === this.adapter.connectionEpoch
      const activeExecution = sameAdapterConnection && active
        ? this.activeTurnWorkspaceAuthority({ taskId: selected.taskId, threadId: selected.threadId, turnId: active.id, workspacePath: args.workspacePath })
        : null
      runtime = {
        loaded: sameAdapterConnection && loaded.some(thread => thread.id === selected.threadId),
        externalWriter: active ? !sameAdapterConnection : false,
        turnState: active ? 'active' : 'idle',
        sameAdapterConnection,
        activeTurnId: active?.id ?? null,
        activeExecutionAuthorized: !!activeExecution,
        experimentalApi: false,
      }
    }

    const effectiveFlags = this.flags.list()
    effectiveFlags['control.queue'] = false
    if (!codexMutationAuthority && !trustedAssistant) {
      for (const key of ['codex.new_thread.execute','routing.resume','routing.fork','control.steer','control.queue']) effectiveFlags[key] = false
    }
    const input = {
      request: { mutates: true, explicitTaskId: args.taskId ?? null, forceNew: !!args.forceNew, forceFork: !!args.forceFork, kind: args.kind ?? 'objective' },
      candidates,
      runtime,
      flags: effectiveFlags,
    }
    const decision = route(input)
    if (!['wait','none'].includes(decision.deliveryAction)) {
      args = { ...args, workspacePath: await this.canonicalWorkspacePath(args.workspacePath, { requireAllowed: true }) }
    }
    let task
    if (decision.semanticAction === 'new_task') {
      task = this.ledger.createTask({ objective, projectId, state: decision.deliveryAction === 'wait' ? 'open' : 'active', confidence: 1, acceptance: args.acceptance ?? ['Verify the result against the objective and record evidence'], sourceKey: `native-request:${triggerId}` })
    } else if (decision.semanticAction === 'fork_task') {
      task = this.ledger.createTask({ objective, projectId, parentTaskId: decision.targetTaskId, state: decision.deliveryAction === 'wait' ? 'open' : 'active', confidence: 1, acceptance: args.acceptance ?? ['Verify the result against the objective and record evidence'], sourceKey: `native-request:${triggerId}` })
    } else {
      task = decision.deliveryAction === 'wait' ? this.ledger.getTask(decision.targetTaskId) : this.activateTask(decision.targetTaskId)
    }
    args = this.withExecutionCriteria({ ...args, taskId: task.taskId })
    this.bindCurrentSession(task.taskId, agent)
    const routeDecisionId = this.ledger.saveRouteDecision(decision, { triggerId, taskId: task.taskId, targetSessionRefId: decision.targetSessionRefId })
    const base = { triggerId, routeDecisionId, taskId: task.taskId, decision }
    if (decision.deliveryAction === 'wait' || decision.deliveryAction === 'none') return { ...base, executions: [] }
    if (!['start_thread','resume_thread','fork_thread','start_turn','steer_turn'].includes(decision.deliveryAction)) return { ...base, executions: [], attentionRequired: true }

    let threadId = selected?.threadId ?? null
    let threadSessionRefId = selected?.sessionRefId ?? null
    const executions = []
    if (decision.deliveryAction === 'steer_turn') {
      const input = [{ type: 'text', text: objective, text_elements: [] }]
      const method = 'turn/steer'
      const params = { threadId, expectedTurnId: runtime.activeTurnId, clientUserMessageId: requestKey, input, responsesapiClientMetadata: { personalAgentTaskId: task.taskId, personalAgentRouteDecisionId: routeDecisionId } }
      const controlSessions = [{ sessionRefId: threadSessionRefId, role: 'executor' }]
      if (sourceSession) controlSessions.push({ sessionRefId: sourceSession.sessionRefId, role: 'interaction' })
      const control = await this.dispatchCodex({ taskId: task.taskId, routeDecisionId, method, params, workspacePath: args.workspacePath, mutatesWorkspace: false, workerPolicy: this.workerPolicy(args, 'codex'), idempotencyKey: `execute:${requestKey}:control`, executionSessions: controlSessions }, { authorizedFeature: 'control.steer' })
      executions.push(control)
      const outcome = control.dispatch.outcomes.find(item => item.outboxId === control.outboxId)
      if (outcome?.state === 'acknowledged') this.completeControlExecution(control.executionId)
      return { ...base, threadId, executions }
    }
    if (decision.deliveryAction !== 'start_turn') {
      let method
      let params
      let authorizedFeature
      if (decision.deliveryAction === 'start_thread') {
        method = 'thread/start'
        params = this.threadParams(args)
        authorizedFeature = 'codex.new_thread.execute'
      } else if (decision.deliveryAction === 'resume_thread') {
        method = 'thread/resume'
        params = { threadId, ...this.threadParams(args), excludeTurns: true }
        authorizedFeature = 'routing.resume'
      } else {
        method = 'thread/fork'
        params = { threadId, lastTurnId: selected.lastCompletedTurnId, ...this.threadParams(args), excludeTurns: true, deferGoalContinuation: true }
        authorizedFeature = 'routing.fork'
      }
      const setupSessions = threadSessionRefId ? [{ sessionRefId: threadSessionRefId, role: decision.deliveryAction === 'fork_thread' ? 'fork_source' : 'executor' }] : []
      if (sourceSession) setupSessions.push({ sessionRefId: sourceSession.sessionRefId, role: 'interaction' })
      const setup = await this.dispatchCodex({ taskId: task.taskId, routeDecisionId, method, params, mutatesWorkspace: false, workerPolicy: this.workerPolicy(args, 'codex'), idempotencyKey: `execute:${requestKey}:thread`, executionSessions: setupSessions }, { authorizedFeature })
      executions.push(setup)
      const outcome = setup.dispatch.outcomes.find(item => item.outboxId === setup.outboxId)
      if (outcome?.state !== 'acknowledged') return { ...base, executions }
      this.completeControlExecution(setup.executionId)
      threadId = outcome.result?.thread?.id ?? outcome.result?.threadId ?? threadId
      if (!threadId) throw new Error('Codex thread control response did not include a thread id')
      this.threadEpochs.set(threadId, this.adapter.connectionEpoch)
      const session = this.ledger.upsertSession({ system: 'codex', externalId: threadId, sourceKind: ['start_thread','fork_thread'].includes(decision.deliveryAction) ? 'app_server_thread' : null, cwd: args.workspacePath ?? null, durability: 'durable' })
      threadSessionRefId = session.sessionRefId
      this.ledger.attachTaskSession(task.taskId, threadSessionRefId, { relation: 'executor', confidence: 1 })
    }

    const turnSessions = [{ sessionRefId: threadSessionRefId, role: 'executor' }]
    if (sourceSession) turnSessions.push({ sessionRefId: sourceSession.sessionRefId, role: 'interaction' })
    const turn = await this.dispatchCodex({
      taskId: task.taskId,
      routeDecisionId,
      method: 'turn/start',
      params: this.turnParams({ ...args, objective, taskId: task.taskId, routeDecisionId }, threadId),
      mutatesWorkspace: true,
      workspacePath: args.workspacePath,
      relevantPaths: args.relevantPaths ?? [],
      requestedCapabilities: args.requestedCapabilities ?? [],
      workerPolicy: this.workerPolicy(args, 'codex'), stepId: args.stepId ?? null,
      idempotencyKey: `execute:${requestKey}:turn`,
      executionSessions: turnSessions,
    }, { authorizedFeature: decision.semanticAction === 'new_task' ? 'codex.new_thread.execute' : decision.semanticAction === 'fork_task' ? 'routing.fork' : 'routing.resume' })
    executions.push(turn)
    return { ...base, threadId, executions }
  }

  /** Keep worker instructions aligned with the persisted Task or step being verified. */
  withExecutionCriteria(args) {
    const task = this.ledger.getTask(args.taskId)
    if (!task) throw new Error('Explicit task does not exist')
    if (args.stepId) this.ledger.assertStepReady(args.taskId, args.stepId)
    const definitions = args.stepId ? this.ledger.listTaskSteps(args.taskId).find(step => step.stepId === args.stepId)?.acceptance : task.acceptance
    requireCriteria(definitions)
    if (args.acceptance && JSON.stringify(criteriaOf(args.acceptance).map(item => item.text)) !== JSON.stringify(criteriaOf(definitions).map(item => item.text))) throw new Error('Execution acceptance must match the persisted Task or step criteria')
    return { ...args, acceptance: definitions }
  }

  workerPolicy(args, worker) {
    if (worker === 'dsh_subagent') return { worker, agentPreset: args.agentPreset ?? this.config.defaultDshPreset, ruleId: args.resolvedPolicy?.ruleId ?? null, model: args.model ?? null, provider: args.modelProvider ?? null, effort: args.effort ?? null }
    return { worker, ruleId: args.resolvedPolicy?.ruleId ?? null, modelProvider: args.modelProvider ?? null, model: args.model ?? null, effort: args.effort ?? null, personality: args.personality ?? null }
  }

  bindCurrentSession(taskId, agent) {
    const externalId = cleanText(agent?.session?.id, 500)
    if (!externalId) return null
    const isAssistant = this.isAssistantSession(externalId)
    const session = this.ledger.upsertSession({ system: 'dsh', externalId, sourceKind: isAssistant ? 'personal_assistant' : 'interaction', cwd: agent?.session?.header?.cwd ?? null, durability: 'durable', nativeStatus: 'active' })
    if (taskId) this.ledger.attachTaskSession(taskId, session.sessionRefId, { relation: isAssistant ? 'primary' : 'interaction', confidence: 1 })
    return session
  }

  async _beginInternalObjective(args, { callerWorkspaceRoot = null, agent = null, signal = null } = {}) {
    if (this.disposed) throw new Error('Personal-agent service is disposed')
    if (!agent?.session?.id) throw new Error('Internal execution requires the current DSH session')
    if (args.output !== undefined || args.result !== undefined) throw new Error('Internal execution results require finish_execution after the real work completes')
    signal?.throwIfAborted?.()
    if (args.workspacePath) args = { ...args, workspacePath: await this.canonicalWorkspacePath(args.workspacePath, { requireAllowed: false }) }
    if (callerWorkspaceRoot && args.workspacePath) {
      const callerRoot = await this.canonicalWorkspacePath(callerWorkspaceRoot, { requireAllowed: false })
      const relative = path.relative(callerRoot, args.workspacePath)
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('workspacePath is outside the caller workspace')
    }
    let projectId = args.projectId ?? null
    if (args.taskId) {
      const explicit = this.ledger.getTask(args.taskId)
      if (!explicit) throw new Error('Explicit task does not exist')
      if (projectId && explicit.projectId && projectId !== explicit.projectId) throw new Error('taskId does not belong to projectId')
      projectId ??= explicit.projectId
    }
    if (args.workspacePath) {
      const observed = this.ledger.upsertProject({ name: args.projectName, canonicalPath: args.workspacePath }).projectId
      if (projectId && observed !== projectId) throw new Error('projectId does not match workspacePath')
      projectId = observed
    }
    const requestKey = cleanText(args.requestId || newId('request'), 500)
    const sourceSession = this.bindCurrentSession(null, agent)
    const triggerId = args._triggerId ?? this.ledger.recordTrigger({ kind: 'execute', sourceSessionRefId: sourceSession.sessionRefId, sourceMessageId: args.sourceMessageId ?? null, content: JSON.stringify({ objective: args.objective, taskId: args.taskId ?? null, workspacePath: args.workspacePath ?? null, sessionId: agent.session.id, stepId: args.stepId ?? null }), dedupeKey: `execute:${requestKey}:internal` })
    const prior = this.nativeRequestResult(triggerId)
    if (prior) return prior
    if ([...this.activeInternalExecutions.values()].some(entry => entry.agent === agent)) throw new Error('Finish or reconcile the current internal execution before starting another')
    const task = args.taskId ? this.ledger.getTask(args.taskId) : this.ledger.createTask({ objective: args.objective, projectId, state: 'active', confidence: 1, acceptance: args.acceptance ?? DEFAULT_ACCEPTANCE, sourceKey: `native-request:${triggerId}` })
    if (!task) throw new Error('Explicit task does not exist')
    this.bindCurrentSession(task.taskId, agent)
    const routeDecisionId = this.ledger.saveRouteDecision({ semanticAction: args.taskId ? 'resume_task' : 'new_task', deliveryAction: 'none', snapshot: { worker: 'internal', taskId: task.taskId, association: args.association ?? null }, reasonCodes: ['worker.internal'], inputSnapshotHash: sha256(JSON.stringify({ objective: args.objective, taskId: task.taskId })), explanation: 'Recorded a top-level DSH execution.' }, { triggerId, taskId: task.taskId })
    let locationId = null
    let baselineId = null
    let leaseId = null
    const mutatesWorkspace = args.mutatesWorkspace === true || (args.mutatesWorkspace !== false && !!args.workspacePath)
    if (mutatesWorkspace) {
      if (!args.workspacePath) throw new Error('Mutating internal execution requires workspacePath')
      const project = this.ledger.upsertProject({ name: args.projectName, canonicalPath: args.workspacePath })
      locationId = this.database.db.prepare('SELECT location_id FROM project_locations WHERE project_id=? AND canonical_path=?').get(project.projectId, args.workspacePath)?.location_id
      const lease = this.ledger.acquireLease({ resourceKey: `workspace:${args.workspacePath}`, locationId, ttlMs: this.config.leaseTtlMs })
      leaseId = lease.leaseId
      try {
        const baseline = await captureWorkspaceBaseline(args.workspacePath, { relevantPaths: args.relevantPaths ?? [] })
        signal?.throwIfAborted?.()
        baselineId = this.ledger.saveBaseline(locationId, baseline)
        if (!baseline.captureComplete) throw new Error('Workspace baseline is incomplete')
      } catch (error) {
        this.ledger.releaseLease(leaseId, 'quiescent')
        throw error
      }
    }
    let planned
    try {
      planned = this.ledger.planExecution({ taskId: task.taskId, stepId: args.stepId ?? null, executorKind: 'internal', routeDecisionId, method: 'internal/execute', params: { objective: args.objective }, workerPolicy: { worker: 'internal', startSeq: agent.session.seq ?? 0 }, requestedCapabilities: args.requestedCapabilities ?? [], mutatesWorkspace, locationId, baselineId, leaseId, dispatch: false, idempotencyKey: `execute:${requestKey}:internal` })
      const interaction = this.bindCurrentSession(task.taskId, agent)
      if (interaction) this.ledger.attachExecutionSession(planned.executionId, interaction.sessionRefId, { role: 'interaction' })
      this.ledger.transitionExecution(planned.executionId, 'running')
      this.activeInternalExecutions.set(planned.executionId, { leaseId, agent })
      return { triggerId, routeDecisionId, taskId: task.taskId, worker: 'internal', executionId: planned.executionId, executionState: 'running', acceptanceRequired: true }
    } catch (error) {
      if (leaseId) {
        const state = this.database.db.prepare('SELECT lease_state FROM leases WHERE lease_id=?').get(leaseId)?.lease_state
        if (['active','recovery_hold'].includes(state)) this.ledger.releaseLease(leaseId, 'quiescent')
      }
      throw error
    }
  }

  async finishInternalExecution(args, { agent = null, signal = null } = {}) {
    if (this.disposed) throw new Error('Personal-agent service is disposed')
    if (!agent?.session?.id) throw new Error('Finishing internal execution requires the current DSH session')
    signal?.throwIfAborted?.()
    const execution = this.database.db.prepare(`SELECT e.*,t.project_id FROM executions e JOIN tasks t ON t.task_id=e.task_id WHERE e.execution_id=? AND e.executor_kind='internal'`).get(args.executionId)
    if (!execution) throw new Error('Internal execution does not exist')
    if (execution.execution_state !== 'running') throw new Error(`Internal execution is not running: ${execution.execution_state}`)
    const interaction = this.bindCurrentSession(execution.task_id, agent)
    const linked = this.database.db.prepare("SELECT 1 FROM execution_sessions WHERE execution_id=? AND session_ref_id=? AND role='interaction'").get(execution.execution_id, interaction?.sessionRefId)
    if (!linked) throw new Error('Internal execution belongs to another DSH session')
    const output = cleanText(args.output ?? args.result ?? '', 20_000)
    const startSeq = parseJson(execution.worker_policy_json, {}).startSeq ?? 0
    await this.context?.sessionPersistence?.flush()
    if (!this.context?.sessionPersistence?.open) throw new Error('Recorded Session persistence is required for internal results')
    const handle = await this.context.sessionPersistence.open(agent.session.id, 'read')
    const events = []
    const substantiveCalls = new Set()
    try {
      const endSeq = agent.session.seq
      let offset = startSeq
      while (offset < endSeq) {
        const batch = await handle.read(offset, Math.min(this.config.historyBatchSize, endSeq - offset))
        if (!batch.events.length) throw new Error('Recorded work is incomplete')
        for (const event of batch.events) {
          if (event.type === 'tool/call' && event.data.name !== 'personal_agent') substantiveCalls.add(event.data.callId)
          if (event.type === 'tool/result' && substantiveCalls.has(event.data.message?.source?.callId)) events.push(event)
          if (event.type === 'assistant/message' && event.data.message?.content?.some(item => item.type === 'text' && item.text.trim())) events.push(event)
        }
        offset += batch.events.length
        if (JSON.stringify(events).length > this.config.analysisInputChars) throw new Error('Recorded work exceeds evidence budget; finish a smaller execution')
      }
    } finally { await handle.close() }
    if (!events.length) throw new Error('Internal execution requires recorded Session work after begin')
    const recorded = JSON.stringify(events)
    try {
      await this.recordDshUsage(execution.execution_id, agent.session.id, startSeq, agent.session.seq)
      const evidenceId = this.ledger.ingestSource({ sourceSystem: 'dsh', sourceKind: 'internal_result', externalId: agent.session.id, sourceUri: `dsh://session/${agent.session.id}`, sourceLocator: `execution:${execution.execution_id}`, sourceIdentity: execution.execution_id, occurredAt: new Date().toISOString(), text: recorded, normalizedPayload: { worker: 'internal', summary: output, fromSeq: startSeq, toSeq: agent.session.seq }, trustLevel: 'local', sessionRefId: interaction.sessionRefId, taskId: execution.task_id, executionId: execution.execution_id, sourceType: 'internal_result' }).evidenceId
      const evidenceIds = [...new Set([...(Array.isArray(args.evidenceIds) ? args.evidenceIds : []), ...(evidenceId ? [evidenceId] : [])])]
      const current = this.database.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(execution.execution_id)
      this.database.transaction(() => {
        this.ledger.transitionExecution(execution.execution_id, 'succeeded', { expectedState: current.execution_state, resultClass: 'completed' })
        this.ledger.recordAcceptance(execution.execution_id, { state: 'pending', summary: 'Internal result requires explicit task verification', criterionId: args.criterionId, evidenceIds })
      })
      const lease = this.database.db.prepare("SELECT lease_id FROM leases WHERE execution_id=? AND lease_state IN ('active','recovery_hold')").get(execution.execution_id)
      if (lease) this.ledger.releaseLease(lease.lease_id, 'terminal')
      return { taskId: execution.task_id, worker: 'internal', executionId: execution.execution_id, executionState: 'succeeded', output, acceptanceRequired: true, evidenceId }
    } catch (error) {
      const current = this.database.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(execution.execution_id)
      if (current && !['succeeded','failed','cancelled','interrupted','reconciling'].includes(current.execution_state)) this.ledger.transitionExecution(execution.execution_id, 'failed', { expectedState: current.execution_state, failureCode: 'internal_execution_failed', failureDetail: cleanText(error?.message ?? error, 2_000) })
      const lease = this.database.db.prepare("SELECT lease_id FROM leases WHERE execution_id=? AND lease_state IN ('active','recovery_hold')").get(execution.execution_id)
      if (lease && this.database.db.prepare('SELECT lease_state FROM leases WHERE lease_id=?').get(lease.lease_id).lease_state === 'active') this.ledger.holdLease(lease.lease_id, 'internal_finish_failed')
      throw error
    } finally {
      this.activeInternalExecutions.delete(execution.execution_id)
    }
  }

  cancelInternalExecution(executionId, { reason = 'cancelled', allowDisposed = false, agent = null } = {}) {
    if (this.disposed && !allowDisposed) throw new Error('Personal-agent service is disposed')
    if (!allowDisposed && !agent?.session?.id) throw new Error('Cancelling internal execution requires the current DSH session')
    const execution = this.database.db.prepare("SELECT execution_state FROM executions WHERE execution_id=? AND executor_kind='internal'").get(executionId)
    if (!execution) throw new Error('Internal execution does not exist')
    if (['succeeded','failed','cancelled','interrupted'].includes(execution.execution_state)) {
      this.activeInternalExecutions.delete(executionId)
      return { executionId, executionState: execution.execution_state }
    }
    if (agent?.session?.id) {
      const session = this.bindCurrentSession(null, agent)
      const linked = this.database.db.prepare("SELECT 1 FROM execution_sessions WHERE execution_id=? AND session_ref_id=? AND role='interaction'").get(executionId, session?.sessionRefId)
      if (!linked) throw new Error('Internal execution belongs to another DSH session')
    }
    if (execution.execution_state !== 'reconciling') this.ledger.transitionExecution(executionId, 'reconciling', { expectedState: execution.execution_state, failureCode: 'internal_outcome_unknown', failureDetail: cleanText(reason, 2000) })
    const lease = this.database.db.prepare("SELECT lease_id,lease_state FROM leases WHERE execution_id=? AND lease_state IN ('active','recovery_hold')").get(executionId)
    if (lease?.lease_state === 'active') this.ledger.holdLease(lease.lease_id, 'internal_work_requires_reconciliation')
    this.activeInternalExecutions.delete(executionId)
    return { executionId, executionState: 'reconciling', attentionRequired: true }
  }

  async _executeDshObjective(args, { callerWorkspaceRoot = null, agent = null, signal = null } = {}) {
    const subagents = this.context?.get?.('subagents') ?? this.context?.subagents
    if (!subagents?.startActivation) throw new Error('DSH worker service is not available in this profile')
    if (!agent) throw new Error('DSH worker execution requires the current DSH agent')
    if (args.agentPreset !== undefined && typeof args.agentPreset !== 'string') throw new TypeError('agentPreset must be a string')
    const agentPreset = args.agentPreset ?? this.config.defaultDshPreset
    if (!this.config.dshWorkerPresets.includes(agentPreset)) throw new Error(`DSH worker preset is not allowed: ${agentPreset}`)
    if (this.context?.agentPresets?.list) {
      const presets = await this.context.agentPresets.list()
      if (!presets.some(preset => preset.id === agentPreset && !preset.broken)) throw new Error(`DSH preset is not registered or failed to load: ${agentPreset}`)
    }
    const provider = args.provider ?? 'spawn'
    const backend = subagents.getProvider?.(provider)
    if (subagents.getProvider && !backend) throw new Error(`DSH provider is unavailable: ${provider}`)
    if (provider !== 'fork' && backend && !backend.capabilities.agentPreset) throw new Error('DSH provider does not support independent preset selection')
    if ((args.model || args.modelProvider || args.effort) && backend && !backend.capabilities.agentOptions) throw new Error('DSH provider does not support model overrides')
    if (provider === 'fork' && agentPreset !== 'standard') throw Object.assign(new Error('The fork DSH provider inherits the current standard preset; use spawn for another preset'), { code: 'DSH_FORK_PRESET_UNSUPPORTED' })
    if (args.workspacePath) args = { ...args, workspacePath: await this.canonicalWorkspacePath(args.workspacePath, { requireAllowed: false }) }
    if (callerWorkspaceRoot && args.workspacePath) {
      const callerRoot = await this.canonicalWorkspacePath(callerWorkspaceRoot, { requireAllowed: false })
      const relative = path.relative(callerRoot, args.workspacePath)
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('workspacePath is outside the caller workspace')
    }
    let projectId = args.projectId ?? null
    if (args.taskId) {
      const explicit = this.ledger.getTask(args.taskId)
      if (!explicit) throw new Error('Explicit task does not exist')
      if (projectId && explicit.projectId && explicit.projectId !== projectId) throw new Error('taskId does not belong to projectId')
      projectId ??= explicit.projectId
    }
    if (args.workspacePath) {
      const observed = this.ledger.upsertProject({ name: args.projectName, canonicalPath: args.workspacePath }).projectId
      if (projectId && observed !== projectId) throw new Error('projectId does not match workspacePath')
      projectId = observed
    }
    const requestKey = cleanText(args.requestId || newId('request'), 500)
    const sourceSession = this.bindCurrentSession(null, agent)
    const triggerId = args._triggerId ?? this.ledger.recordTrigger({ kind: 'execute', sourceSessionRefId: sourceSession?.sessionRefId ?? null, sourceMessageId: args.sourceMessageId ?? null, content: JSON.stringify({ objective: args.objective, taskId: args.taskId ?? null, workspacePath: args.workspacePath ?? null, sessionId: agent.session.id, agentPreset, stepId: args.stepId ?? null }), dedupeKey: `execute:${requestKey}:dsh` })
    const prior = this.nativeRequestResult(triggerId)
    if (prior) return prior
    const createdTask = !args.taskId
    const task = args.taskId ? this.ledger.getTask(args.taskId) : this.ledger.createTask({ objective: args.objective, projectId, state: 'active', confidence: 1, acceptance: args.acceptance ?? DEFAULT_ACCEPTANCE, sourceKey: `native-request:${triggerId}` })
    if (!task) throw new Error('Explicit task does not exist')
    this.bindCurrentSession(task.taskId, agent)
    const routeDecisionId = this.ledger.saveRouteDecision({
      semanticAction: createdTask ? 'new_task' : 'resume_task', deliveryAction: 'none',
      snapshot: { worker: 'dsh_subagent', agentPreset, taskId: task.taskId, policy: args.resolvedPolicy ?? null, association: args.association ?? null }, reasonCodes: ['worker.dsh_subagent'],
      inputSnapshotHash: sha256(JSON.stringify({ objective: args.objective, taskId: task.taskId, agentPreset })),
      explanation: createdTask ? 'Created a durable task for a DSH worker.' : 'Dispatched a DSH worker for the explicitly selected task.',
    }, { triggerId, taskId: task.taskId })
    let locationId = null
    let baselineId = null
    let leaseId = null
    const mutatesWorkspace = args.mutatesWorkspace === true || (args.mutatesWorkspace !== false && !!args.workspacePath)
    if (mutatesWorkspace) {
      if (!args.workspacePath) throw new Error('Mutating DSH execution requires workspacePath')
      const project = this.ledger.upsertProject({ name: args.projectName, canonicalPath: args.workspacePath })
      locationId = this.database.db.prepare('SELECT location_id FROM project_locations WHERE project_id=? AND canonical_path=?').get(project.projectId, args.workspacePath)?.location_id
      const lease = this.ledger.acquireLease({ resourceKey: `workspace:${args.workspacePath}`, locationId, ttlMs: this.config.leaseTtlMs })
      leaseId = lease.leaseId
      try {
        const baseline = await captureWorkspaceBaseline(args.workspacePath, { relevantPaths: args.relevantPaths ?? [] })
        baselineId = this.ledger.saveBaseline(locationId, baseline)
        if (!baseline.captureComplete) throw new Error('Workspace baseline is incomplete')
      } catch (error) {
        this.ledger.releaseLease(leaseId, 'quiescent')
        throw error
      }
    }
    let planned
    try {
      planned = this.ledger.planExecution({ taskId: task.taskId, stepId: args.stepId ?? null, executorKind: 'dsh_subagent', routeDecisionId, method: 'subagent/start', params: { objective: args.objective, agentPreset }, workerPolicy: this.workerPolicy({ ...args, agentPreset }, 'dsh_subagent'), requestedCapabilities: args.requestedCapabilities ?? [], dispatch: false, mutatesWorkspace, locationId, baselineId, leaseId, idempotencyKey: `execute:${requestKey}:dsh` })
      this.ledger.transitionExecution(planned.executionId, 'running')
      if (sourceSession) this.ledger.attachExecutionSession(planned.executionId, sourceSession.sessionRefId, { role: 'interaction' })
    } catch (error) {
      if (leaseId) {
        const lease = this.database.db.prepare("SELECT lease_state FROM leases WHERE lease_id=?").get(leaseId)
        if (lease && ['active','recovery_hold'].includes(lease.lease_state)) this.ledger.releaseLease(leaseId, 'quiescent')
      }
      throw error
    }
    let activation = null
    let session = null
    let combinedSignal = null
    let disposePublished = null
    let activationDisposeError = null
    let disposal = null
    const localAbort = new AbortController()
    const cancelled = Promise.withResolvers()
    cancelled.promise.catch(() => {})
    try {
      const signals = [localAbort.signal, this.workerLifetime.signal, AbortSignal.timeout(this.config.workerBudgetMs)]
      if (signal) signals.push(signal)
      combinedSignal = AbortSignal.any(signals)
      activation = await subagents.startActivation({
        provider, label: cleanText(args.label ?? args.objective, 120), name: args.name,
        cwd: args.workspacePath, ...(provider === 'fork' ? {} : { agentPreset }),
        prompt: [{ type: 'text', text: JSON.stringify({ objective: args.objective, taskId: task.taskId, stepId: args.stepId ?? null, constraints: args.constraints ?? [], acceptance: args.acceptance ?? task.acceptance, requiredArtifacts: args.requiredArtifacts ?? [] }) }], parent: agent,
        ...((args.model || args.modelProvider || args.effort) ? { agentOptions: { ...(args.model ? { model: args.model } : {}), ...(args.modelProvider ? { provider: args.modelProvider } : {}), ...(args.effort ? { reasoningEffort: args.effort } : {}) } } : {}),
        signal: combinedSignal, delivery: 'caller',
      })
      this.dshActivations.add(activation)
      this.workerHandles.set(planned.executionId, { cancel: () => localAbort.abort(new DOMException('Worker cancelled', 'AbortError')) })
      disposePublished = () => {
        disposal ??= Promise.resolve().then(() => activation.dispose())
        disposal.then(() => cancelled.reject(combinedSignal.reason), error => { activationDisposeError = error; cancelled.reject(error) })
      }
      combinedSignal.addEventListener('abort', disposePublished, { once: true })
      if (combinedSignal.aborted) disposePublished()
      session = this.ledger.upsertSession({ system: 'dsh', externalId: activation.childId, sourceKind: 'subagent', cwd: args.workspacePath ?? null, durability: 'durable', nativeStatus: 'running' })
      this.ledger.attachExecutionSession(planned.executionId, session.sessionRefId, { role: 'executor' })
      const result = await Promise.race([activation.result, cancelled.promise])
      try { disposal ??= Promise.resolve().then(() => activation.dispose()); await disposal }
      catch (error) { activationDisposeError = error; throw error }
      await this.recordDshUsage(planned.executionId, activation.childId)
      const output = (result?.output ?? []).filter(item => item?.type === 'text').map(item => item.text).join('\n').trim()
      const terminal = result?.stopReason === 'completed' ? 'succeeded' : result?.stopReason === 'aborted' ? 'interrupted' : 'failed'
      const current = this.database.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(planned.executionId)
      this.ledger.transitionExecution(planned.executionId, terminal, { expectedState: current.execution_state, resultClass: result?.stopReason ?? terminal, failureCode: terminal === 'failed' ? 'dsh_worker_failed' : null })
      let evidenceId = null
      if (output) evidenceId = this.ledger.ingestSource({ sourceSystem: 'dsh', sourceKind: 'subagent_result', externalId: activation.childId, sourceUri: `dsh://subagent/${activation.childId}`, sourceLocator: `execution:${planned.executionId}`, sourceIdentity: planned.executionId, occurredAt: new Date().toISOString(), text: output, normalizedPayload: { stopReason: result?.stopReason ?? null }, trustLevel: 'local', sessionRefId: session.sessionRefId, taskId: task.taskId, executionId: planned.executionId, sourceType: 'subagent_result' }).evidenceId
      this.ledger.recordAcceptance(planned.executionId, { state: 'pending', summary: 'Worker result requires explicit task verification', evidenceIds: evidenceId ? [evidenceId] : [] })
      this.database.db.prepare('UPDATE session_refs SET native_status=?,last_seen_at=? WHERE session_ref_id=?').run(terminal, new Date().toISOString(), session.sessionRefId)
      return { triggerId, routeDecisionId, taskId: task.taskId, worker: 'dsh_subagent', executionId: planned.executionId, childId: activation.childId, stopReason: result?.stopReason ?? terminal, output, acceptanceRequired: true, evidenceId }
    } catch (error) {
      const current = this.database.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(planned.executionId)
      if (current && !['succeeded','failed','cancelled','interrupted'].includes(current.execution_state)) this.ledger.transitionExecution(planned.executionId, activationDisposeError ? 'reconciling' : combinedSignal?.aborted ? 'interrupted' : 'failed', { expectedState: current.execution_state, failureCode: 'dsh_worker_start_or_run_failed', failureDetail: cleanText(error?.message ?? error, 2_000) })
      if (session) this.database.db.prepare('UPDATE session_refs SET native_status=?,last_seen_at=? WHERE session_ref_id=?').run('failed', new Date().toISOString(), session.sessionRefId)
      throw error
    } finally {
      if (activation) {
        combinedSignal?.removeEventListener?.('abort', disposePublished)
        try { disposal ??= Promise.resolve().then(() => activation.dispose()); await disposal }
        catch (error) {
          activationDisposeError = error
          this.logger?.warn?.('DSH worker disposal failed', error)
        }
        this.dshActivations.delete(activation)
        this.workerHandles.delete(planned.executionId)
      }
      if (leaseId) {
        const lease = this.database.db.prepare("SELECT lease_id,lease_state FROM leases WHERE lease_id=?").get(leaseId)
        if (lease && ['active','recovery_hold'].includes(lease.lease_state)) {
          if (activationDisposeError) { if (lease.lease_state === 'active') this.ledger.holdLease(leaseId, 'worker_disposal_failed') }
          else this.ledger.releaseLease(leaseId, 'terminal')
        }
      }
    }
  }

  async dispatchCodex(args, { authorizedFeature = null } = {}) {
    if (args.method.startsWith('thread/queue/')) throw new Error('Codex queue mutations are disabled until queued turns have a baseline and lease handoff protocol')
    this.flags.assert('codex.daemon.connect')
    if (authorizedFeature) this.flags.assert(authorizedFeature)
    else if (args.method === 'thread/start') this.flags.assert('codex.new_thread.execute')
    else if (args.method === 'thread/resume' || args.method === 'turn/start') this.flags.assert('routing.resume')
    else if (args.method === 'thread/fork') this.flags.assert('routing.fork')
    if (args.method === 'turn/steer') this.flags.assert('control.steer')
    if (args.method === 'turn/steer') {
      const workspacePath = await this.canonicalWorkspacePath(args.workspacePath, { requireAllowed: true })
      const authority = this.activeTurnWorkspaceAuthority({ taskId: args.taskId, threadId: args.params?.threadId, turnId: args.params?.expectedTurnId, workspacePath })
      if (!authority) throw new Error('Codex steer requires an owned active turn with a complete baseline and active workspace lease')
    }
    if (!this.adapter.initialized) await this.connectCodex()
    let locationId = null
    let baselineId = null
    let leaseId = null
    const mutatesWorkspace = args.method === 'turn/start' || args.mutatesWorkspace === true
    if (mutatesWorkspace) {
      const workspacePath = await this.canonicalWorkspacePath(args.workspacePath, { requireAllowed: true })
      const project = this.ledger.upsertProject({ name: path.basename(workspacePath), canonicalPath: workspacePath })
      const location = this.database.db.prepare('SELECT location_id FROM project_locations WHERE project_id=? AND canonical_path=?').get(project.projectId, workspacePath)
      locationId = location.location_id
      const lease = this.ledger.acquireLease({ resourceKey: `workspace:${workspacePath}`, locationId, ttlMs: this.config.leaseTtlMs })
      leaseId = lease.leaseId
      try {
        const baseline = await captureWorkspaceBaseline(workspacePath, { relevantPaths: args.relevantPaths ?? [] })
        baselineId = this.ledger.saveBaseline(locationId, baseline)
        if (!baseline.captureComplete) throw new Error('Workspace baseline is incomplete')
      } catch (error) {
        this.ledger.releaseLease(leaseId, 'quiescent')
        throw error
      }
    }
    let planned
    try {
      planned = this.ledger.planExecution({ taskId: args.taskId, stepId: args.stepId ?? null, executorKind: 'codex', routeDecisionId: args.routeDecisionId ?? null, locationId, baselineId, leaseId, requestedCapabilities: args.requestedCapabilities ?? [], workerPolicy: args.workerPolicy ?? { worker: 'codex' }, method: args.method, params: args.params ?? {}, mutatesWorkspace, idempotencyKey: args.idempotencyKey ?? newId('intent') })
      for (const attachment of args.executionSessions ?? []) this.ledger.attachExecutionSession(planned.executionId, attachment.sessionRefId, { role: attachment.role ?? 'executor', confidence: attachment.confidence ?? 1 })
    } catch (error) {
      if (leaseId) {
        try { this.ledger.releaseLease(leaseId, 'quiescent') } catch {}
      }
      throw error
    }
    const result = await this.dispatcher.dispatchOnce(1, { outboxId: planned.outboxId })
    if (this.config.inboxRetryEnabled && !this.disposed) await this.retryInboxProjections()
    if (result.uncertain && leaseId) this.ledger.holdLease(leaseId, 'dispatch_unknown')
    if (result.failed && leaseId) this.ledger.releaseLease(leaseId, 'quiescent')
    if (args.method === 'turn/start' && !result.failed) this.scheduleWorkerDeadline(planned.executionId)
    return { ...planned, dispatch: result, leaseId, baselineId }
  }

  currentUserMessage(agent, requiredText = null) {
    const messages = agent?.session?.deriveMessages?.() ?? []
    const message = [...messages].reverse().find(item => item.role === 'user' && item.source?.kind === 'user')
    const text = message?.content?.filter(item => item.type === 'text').map(item => item.text).join('') ?? ''
    if (!message || !text.trim()) throw new Error('Memory writes require the current user-authored message')
    if (requiredText && !text.includes(requiredText)) throw new Error('Memory content must be quoted from the current user message')
    return { message, text }
  }

  recordMemoryOperation(sourceKind, text, details = {}, { agent = null, quotedText = null } = {}) {
    const id = newId('memory-operation')
    let externalId = id
    let sessionRefId = null
    let sourceUri = `personal-agent://memory/${id}`
    let sourceLocator = 'operation'
    if (agent) {
      const current = this.currentUserMessage(agent, quotedText)
      const sessionId = cleanText(agent.session?.id, 500)
      externalId = current.message.id ?? id
      sourceUri = `dsh://session/${sessionId}`
      sourceLocator = `user-message:${externalId}`
      if (sessionId) sessionRefId = this.ledger.upsertSession({ system: 'dsh', externalId: sessionId, sourceKind: 'personal_assistant', durability: 'durable' }).sessionRefId
      text = current.text
      details = { ...details, messageId: externalId, quotedText }
    }
    return this.ledger.ingestSource({ sourceSystem: agent ? 'dsh' : 'personal-agent', sourceKind, externalId,
      sourceUri, sourceLocator, sourceIdentity: sha256(text), text, normalizedPayload: details,
      trustLevel: 'user', authorRole: 'user', sessionRefId, sourceType: sourceKind, memory: 'temporary' })
  }

  async manageMemory(args = {}, { actor = 'operator', agent = null } = {}) {
    if (this.memoryInitializationOperation) this.assertMemoryAvailable()
    if (this.disposed) throw new Error('Personal-agent service is disposed')
    switch (args.action) {
      case 'list': return this.memory.list(args)
      case 'get': {
        if (args.historyMessageId) return this.ledger.history.message(args.historyMessageId)
        if (args.sessionTaskId) return this.ledger.history.get(args.sessionTaskId, {offset: args.offset ?? 0,limit: args.limit ?? 30,version:args.version})
        const memory = args.memoryId ? this.memory.get(args.memoryId) : null
        if (memory) return memory
        const entity = args.entityId ? this.memory.getEntity(args.entityId) : null
        if (entity) return entity
        const experience = args.evidenceId ? this.memory.getExperience(args.evidenceId) : null
        if (experience) return experience
        const relation = args.edgeId ? this.memory.getRelation(args.edgeId) : null
        if (relation) return relation
        if (!args.taskId) return null
        const detail = this.dashboardTaskDetail(args.taskId)
        return detail ? { type: 'task', id: detail.task.id, objective: detail.task.title, state: detail.task.state,
          createdAt: detail.task.createdAt, updatedAt: detail.task.updatedAt, task: detail.task, workers: detail.workers } : null
      }
      case 'search': return this.memory.search(args.query, args)
      case 'edit-record': {
        return this.database.transaction(() => {
          const sourceText = cleanText(args.content, 4_000)
          const evidence = this.recordMemoryOperation('memory_edit', sourceText, { memoryId: args.memoryId, changes: args })
          return this.memory.editRecord(args.memoryId, args, evidence.evidenceId)
        })
      }
      case 'edit-entity': {
        return this.database.transaction(() => {
          const sourceText = [args.name, args.type, ...(Array.isArray(args.tags) ? args.tags : []), ...(Array.isArray(args.aliases) ? args.aliases : []),
            ...Object.entries(args.attributes && typeof args.attributes === 'object' && !Array.isArray(args.attributes) ? args.attributes : {}).flatMap(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)])]
            .filter(value => typeof value === 'string' && cleanText(value, 1_000)).map(value => cleanText(value, 1_000)).join('\n')
            || `Updated entity ${cleanText(args.name, 240) || args.entityId} in memory settings.`
          const evidence = this.recordMemoryOperation('memory_edit', sourceText, { entityId: args.entityId, changes: args })
          return this.memory.editEntity(args.entityId, args, evidence.evidenceId, sourceText)
        })
      }
      case 'edit-experience': {
        return this.database.transaction(() => {
          const changes = { note: args.note, tags: args.tags, entityIds: args.entityIds }
          const sourceText = `Updated local annotations for experience ${args.evidenceId}.\n${JSON.stringify(changes)}`
          const evidence = this.recordMemoryOperation('memory_edit', sourceText, { evidenceId: args.evidenceId, changes })
          return this.memory.editExperience(args.evidenceId, changes, evidence.evidenceId)
        })
      }
      case 'edit-relation': {
        const current = args.edgeId ? this.memory.getRelation(args.edgeId) : null
        if (!current) throw new Error('Memory relationship does not exist')
        const label = cleanText(args.relation, 100)
        if (!label) throw new TypeError('Relationship label is required')
        const from = current.from.object?.name ?? current.from.id
        const to = current.to.object?.name ?? current.to.id
        return this.database.transaction(() => {
          const sourceText = `${from} ${label} ${to}`
          const evidence = this.recordMemoryOperation('memory_edit', sourceText, { edgeId: args.edgeId, relation: label })
          return this.memory.editRelation(args.edgeId, label, evidence.evidenceId)
        })
      }
      case 'confirm': {
        return this.database.transaction(() => {
          const evidence = this.recordMemoryOperation('memory_confirmation', `User confirmed memory ${args.memoryId}`, { memoryId: args.memoryId })
          return this.memory.confirm(args.memoryId, evidence.evidenceId)
        })
      }
      case 'confirm-entity': {
        return this.database.transaction(() => {
          const evidence = this.recordMemoryOperation('memory_confirmation', `User confirmed entity ${args.entityId}`, { entityId: args.entityId })
          return this.memory.confirmEntity(args.entityId, evidence.evidenceId)
        })
      }
      case 'transition-task': {
        const task = this.ledger.getTask(args.taskId)
        if (!task) throw new Error('Task does not exist')
        return this.ledger.transitionTask(args.taskId, args.state, args.expectedState ?? task.state)
      }
      case 'delete-session-task': return this.ledger.history.removeTask(args.sessionTaskId)
      case 'delete-task': return this.memory.deleteTask(args.taskId)
      case 'retract': {
        return this.database.transaction(() => {
          const evidence = this.recordMemoryOperation('memory_retraction', `User retracted memory ${args.memoryId}`, { memoryId: args.memoryId })
          return this.memory.retract(args.memoryId, evidence.evidenceId)
        })
      }
      case 'delete-memory': {
        this.recordMemoryOperation('memory_delete', `Deleted memory ${args.memoryId}`, { memoryId: args.memoryId })
        return this.memory.remove(args.memoryId)
      }
      case 'delete-entity': {
        this.recordMemoryOperation('memory_delete', `Deleted entity ${args.entityId}`, { entityId: args.entityId })
        return this.memory.removeEntity(args.entityId)
      }
      case 'delete-experience': {
        this.recordMemoryOperation('memory_delete', `Deleted local experience ${args.evidenceId}`, { evidenceId: args.evidenceId })
        return this.memory.removeExperience(args.evidenceId)
      }
      case 'delete-relation': {
        this.recordMemoryOperation('memory_delete', `Deleted relationship ${args.edgeId}`, { edgeId: args.edgeId })
        return this.memory.removeRelation(args.edgeId)
      }
      case 'rebuild-index': return this.memory.rebuildIndex()
      case 'retry-extraction': return this.memory.retry(args.evidenceId ?? null)
      case 'run-extraction': {
        this.trackOperation(this.memory.run(), 'memory extraction')
        return this.memoryExtractionView()
      }
      case 'remember':
      case 'correct': {
        return this.database.transaction(() => {
          const content = cleanText(args.content, 4_000)
          if (!content) throw new TypeError('Memory content is required')
          const source = this.recordMemoryOperation('memory_statement', content, { kind: args.kind ?? 'fact' }, { agent, quotedText: content })
          const entity = args.entityName ? this.memory.ensureEntity({ name: args.entityName, type: args.entityType ?? 'other', state: 'user-stated', evidenceId: source.evidenceId, quote: content }) : null
          return this.memory.createRecord({ kind: args.kind ?? 'fact', content, entityId: entity?.id ?? args.entityId ?? null,
            predicate: args.predicate ?? null, object: args.value ?? null, scope: args.scope ?? {}, state: 'user-stated', confidence: 1,
            createdBy: 'user', supersedesId: args.action === 'correct' ? args.memoryId : null,
            evidence: [{ id: source.evidenceId, quote: content, stance: 'supports' }] })
        })
      }
      case 'confirm-user-memory': {
        const current = this.currentUserMessage(agent)
        if (!/(?:确认|认可|同意|confirm|approve)/iu.test(current.text)) throw new Error('This memory action requires an explicit user request')
        const source = this.recordMemoryOperation('memory_confirmation', current.text, { memoryId: args.memoryId }, { agent })
        return this.memory.confirm(args.memoryId, source.evidenceId)
      }
      case 'confirm-user-entity': {
        const current = this.currentUserMessage(agent)
        if (!/(?:确认|认可|同意|confirm|approve)/iu.test(current.text)) throw new Error('This memory action requires an explicit user request')
        const source = this.recordMemoryOperation('memory_confirmation', current.text, { entityId: args.entityId }, { agent })
        return this.memory.confirmEntity(args.entityId, source.evidenceId)
      }
      case 'retract-user-memory':
      case 'forget-user-memory': {
        const current = this.currentUserMessage(agent)
        const action = args.action === 'forget-user-memory' ? /(?:忘记|删除|forget|delete)/iu : /(?:撤回|retract|withdraw)/iu
        if (!action.test(current.text)) throw new Error('This memory action requires an explicit user request')
        if (args.entityId) return this.memory.removeEntity(args.entityId)
        if (args.evidenceId) return this.memory.removeExperience(args.evidenceId)
        if (args.action === 'forget-user-memory') return this.memory.remove(args.memoryId)
        const source = this.recordMemoryOperation('memory_retraction', current.text, { memoryId: args.memoryId }, { agent })
        return this.memory.retract(args.memoryId, source.evidenceId)
      }
      default: throw new Error(`Unknown memory action: ${args.action}`)
    }
  }

  async reconcileNativeExecution(args, { operator = false } = {}) {
    if (!operator) throw new Error('Native recovery requires an authenticated operator and an inspected outcome')
    const execution = this.database.db.prepare("SELECT * FROM executions WHERE execution_id=? AND executor_kind IN ('internal','dsh_subagent')").get(args.executionId)
    if (!execution) throw new Error('Native execution does not exist')
    if (!['reconciling','failed','interrupted'].includes(execution.execution_state)) throw new Error('Execution is not awaiting recovery')
    if (!['quiescent','process_dead','isolated_worktree'].includes(args.proof) || !String(args.acceptanceSummary ?? '').trim()) throw new Error('Recovery requires explicit quiescence proof and inspection notes')
    if (this.workerHandles.has(execution.execution_id)) throw new Error('A worker is still owned by this runtime; cancel and drain it first')
    const links = this.database.db.prepare("SELECT s.external_id FROM execution_sessions es JOIN session_refs s USING(session_ref_id) WHERE es.execution_id=? AND s.system='dsh'").all(execution.execution_id)
    for (const link of links) {
      const live = this.context?.agents?.get?.(link.external_id)
      if (live) { live.cancel({ kind: 'user' }); await live.whenIdle() }
    }
    const location = execution.workspace_location_id ? this.database.db.prepare('SELECT canonical_path FROM project_locations WHERE location_id=?').get(execution.workspace_location_id) : null
    const baseline = location ? await captureWorkspaceBaseline(location.canonical_path) : null
    if (baseline && !baseline.captureComplete) throw new Error('Cannot reconcile an incomplete workspace inspection')
    return this.database.transaction(() => {
      const evidence = this.ledger.ingestSource({ sourceSystem: 'operator', sourceKind: 'recovery_inspection', sourceUri: `personal-agent://execution/${execution.execution_id}`, sourceLocator: newId('inspection'), sourceIdentity: newId('revision'), text: args.acceptanceSummary, normalizedPayload: { proof: args.proof, baseline }, trustLevel: 'user', authorRole: 'user', taskId: execution.task_id, executionId: execution.execution_id })
      if (execution.execution_state === 'reconciling') this.ledger.transitionExecution(execution.execution_id, 'interrupted', { expectedState: execution.execution_state, resultClass: 'inspected_interruption' })
      const lease = this.database.db.prepare("SELECT lease_id FROM leases WHERE execution_id=? AND lease_state IN ('active','recovery_hold')").get(execution.execution_id)
      if (lease) this.ledger.releaseLease(lease.lease_id, args.proof)
      this.ledger.appendEvent('execution', execution.execution_id, 'execution.reconciled', { proof: args.proof, evidenceId: evidence.evidenceId })
      return { executionId: execution.execution_id, evidenceId: evidence.evidenceId, retryRequiresNewExecution: true }
    })
  }

  heartbeatWorkers() {
    if (this.disposed) return
    const owned = this.database.db.prepare("SELECT DISTINCT e.execution_id FROM executions e JOIN leases l USING(execution_id) WHERE l.owner_instance_id=? AND l.lease_state='active' AND e.execution_state IN ('dispatch_pending','dispatch_unknown','running','waiting_approval','waiting_user')").all(this.ledger.instanceId)
    for (const row of owned) this.ledger.heartbeatExecution(row.execution_id, this.config.leaseTtlMs)
    return { renewed: owned.length }
  }

  scheduleWorkerDeadline(executionId) {
    if (this.disposed || this.workerTimers.has(executionId) || ['succeeded','failed','cancelled','interrupted'].includes(this.database.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(executionId)?.execution_state)) return
    const timer = setTimeout(() => {
      this.workerTimers.delete(executionId)
      if (!this.disposed) this.trackOperation(() => this.cancelWorker(executionId, { operator: true, reason: 'worker time budget exhausted' }), 'worker deadline')
    }, this.config.workerBudgetMs)
    timer.unref()
    this.workerTimers.set(executionId, timer)
  }

  async cancelWorker(executionId, { agent = null, operator = false, reason = 'cancelled' } = {}) {
    const execution = this.database.db.prepare('SELECT * FROM executions WHERE execution_id=?').get(executionId)
    if (!execution) throw new Error('Execution does not exist')
    if (!operator) {
      const session = this.bindCurrentSession(null, agent)
      if (!session || !this.database.db.prepare("SELECT 1 FROM execution_sessions WHERE execution_id=? AND session_ref_id=? AND role='interaction'").get(executionId, session.sessionRefId)) throw new Error('Execution belongs to another session')
    }
    if (execution.executor_kind === 'internal') return this.cancelInternalExecution(executionId, { agent, reason })
    if (['succeeded','failed','cancelled','interrupted'].includes(execution.execution_state)) return { executionId, state: execution.execution_state }
    const handle = this.workerHandles.get(executionId)
    if (handle) { handle.cancel(); return { executionId, cancellationRequested: true } }
    if (execution.executor_kind !== 'codex') throw new Error('Worker runtime is unavailable; reconcile its artifacts before retrying')
    const references = this.database.db.prepare(`SELECT s.* FROM execution_sessions es JOIN session_refs s USING(session_ref_id) WHERE es.execution_id=?`).all(executionId)
    const threadId = references.find(item => item.source_kind === 'app_server_thread')?.external_id
    const turnId = references.find(item => item.source_kind === 'app_server_turn')?.external_id
    if (!threadId || !turnId || !this.adapter.initialized) throw new Error('Worker outcome is unknown; reconnect and reconcile before retrying')
    await this.adapter.request('turn/interrupt', { threadId, turnId })
    const current = this.database.db.prepare('SELECT * FROM executions WHERE execution_id=?').get(executionId)
    if (!['succeeded','failed','cancelled','interrupted','reconciling'].includes(current.execution_state)) this.ledger.transitionExecution(executionId, 'reconciling', { expectedState: current.execution_state, failureDetail: reason })
    const lease = this.database.db.prepare("SELECT lease_id FROM leases WHERE execution_id=? AND lease_state='active'").get(executionId)
    if (lease) this.ledger.holdLease(lease.lease_id, 'awaiting_worker_terminal_confirmation')
    return { executionId, cancellationRequested: true, awaitingTerminalConfirmation: true }
  }

  operate(args = {}, options = {}) {
    try { this.assertMemoryAvailable() } catch (error) { return Promise.reject(error) }
    const operation = this._operate(args, options).finally(() => this.publicOperations.delete(operation))
    this.publicOperations.add(operation)
    return operation
  }

  async _operate(args = {}, { actor = 'assistant', callerWorkspaceRoot = null, codexMutationAuthority = false, featureAuthority = false, approvalAuthority = false, agent = null, signal = null } = {}) {
    switch (args.action) {
      case 'health': return this.health()
      case 'import_history': return this.importHistory({ full: !!args.full })
      case 'memory_search': {
        const filters = { includeCandidates: args.includeCandidates === true, includeHistory: args.includeHistory !== false,
          sourceSystem: args.sourceSystem ?? null, entityId: args.entityId ?? null, from: args.from ?? null, to: args.to ?? null, asOf: args.asOf ?? null }
        const result = this.memory.search(args.query, { limit: args.limit, offset: args.offset ?? 0, ...filters })
        const experienceMatch = result.experiences.find(item => item.matchMode)
        const match = experienceMatch ? { mode: experienceMatch.matchMode, matchedTerms: experienceMatch.matchedTerms,
          minimumTermMatches: experienceMatch.minimumTermMatches } : { mode: 'all-terms' }
        return { ...result, retrieval: retrievalInfo(args.query, ['memories','entities','relations','experiences','tasks','sessionTasks'].some(lane => result[lane].length), filters, match) }
      }
      case 'memory_get': return this.manageMemory({ action: 'get', memoryId: args.memoryId, entityId: args.entityId,
        evidenceId: args.evidenceId, taskId: args.taskId, sessionTaskId: args.sessionTaskId, historyMessageId: args.historyMessageId, offset: args.offset, limit: args.limit, version:args.version, edgeId: args.edgeId }, { actor, agent })
      case 'remember': return this.manageMemory({ ...args, action: 'remember' }, { actor, agent })
      case 'correct_memory': return this.manageMemory({ ...args, action: 'correct' }, { actor, agent })
      case 'confirm_memory': return this.manageMemory({ ...args, action: 'confirm-user-memory' }, { actor, agent })
      case 'confirm_entity': return this.manageMemory({ ...args, action: 'confirm-user-entity' }, { actor, agent })
      case 'retract_memory': return this.manageMemory({ ...args, action: 'retract-user-memory' }, { actor, agent })
      case 'forget_memory': return this.manageMemory({ ...args, action: 'forget-user-memory' }, { actor, agent })
      case 'search_history': {
        this.flags.assert('history.read')
        const filters = { sessionId:args.sessionId??null, sort:args.sort??'relevance', projectId: args.projectId ?? null, taskId: args.sessionTaskId ?? args.taskId ?? null, sourceSystem: args.sourceSystem ?? null,
          entityId: args.entityId ?? null, from: args.from ?? null, to: args.to ?? null, includeTemporary: args.includeTemporary === true }
        const page = this.ledger.history.list({query:args.query,rawSearch:true,limit:args.limit ?? 20,offset:args.offset ?? 0,...filters})
        const results = page.records
        const experienceMatch = results.find(item => item.matchMode)
        const match = experienceMatch ? { mode: experienceMatch.matchMode, matchedTerms: experienceMatch.matchedTerms,
          minimumTermMatches: experienceMatch.minimumTermMatches } : { mode: 'all-terms' }
        return { ...page, results, retrieval: retrievalInfo(args.query, results.length > 0 || page.supplementary.length > 0, filters, match) }
      }
      case 'list_tasks': return { tasks: this.listTasks(args), scope: 'persistent-task-ledger', historyIncluded: false,
        guidance: 'Imported DSH/Codex conversations do not create Task rows. Use memory_search or search_history to find conversation work, even when this ledger is empty.' }
      case 'get_task': { const task = this.ledger.getTask(args.taskId); return task ? { ...task, steps: this.ledger.listTaskSteps(args.taskId), verification: this.ledger.acceptanceStatus(args.taskId) } : null }
      case 'create_task': {
        this.flags.assert('task.native')
        if (Object.hasOwn(args, 'acceptance') && (!Array.isArray(args.acceptance) || args.acceptance.length === 0 || args.acceptance.some(item => typeof item !== 'string' || !item.trim()))) throw new TypeError('Public tasks require at least one acceptance criterion')
        if (args.state === 'completed') throw new Error('Public tasks cannot be created as completed')
        const sourceSession = this.bindCurrentSession(null, agent)
        const task = this.ledger.createTask({ objective: args.objective, projectId: args.projectId, sourceKey: args.sourceKey ?? `native:${newId('source')}`, parentTaskId: args.parentTaskId, state: args.state ?? 'open', confidence: 1, acceptance: args.acceptance ?? DEFAULT_ACCEPTANCE })
        this.bindCurrentSession(task.taskId, agent)
        if (sourceSession) this.ledger.recordTrigger({ kind: 'direct_request', sourceSessionRefId: sourceSession.sessionRefId, content: args.objective, dedupeKey: `task:${task.taskId}` })
        return task
      }
      case 'create_step': this.flags.assert('task.native'); return this.ledger.createTaskStep(args.taskId, { objective: args.objective, dependencies: args.dependencies, acceptance: args.acceptance })
      case 'list_steps': return this.ledger.listTaskSteps(args.taskId)
      case 'transition_step': return this.ledger.transitionTaskStep(args.taskId, args.stepId, args.state)
      case 'link_project_location': return this.ledger.linkProjectLocation(args.projectId, await this.canonicalWorkspacePath(args.workspacePath))
      case 'transition_task': this.flags.assert('task.native'); return this.ledger.transitionTask(args.taskId, args.state, args.expectedState)
      case 'record_acceptance': this.flags.assert('task.native'); return this.ledger.recordAcceptance(args.executionId, { state: args.acceptanceState, summary: args.acceptanceSummary, criterionId: args.criterionId, evidenceIds: args.evidenceIds })
      case 'finish_execution': this.flags.assert('task.native'); return this.finishInternalExecution(args, { agent, signal })
      case 'retry_inbox': {
        if (!codexMutationAuthority) throw new Error('Inbox retry reset requires an authenticated operator')
        if (typeof args.sourceKey !== 'string' || !args.sourceKey) throw new TypeError('sourceKey must identify one inbox record')
        const changed = this.database.db.prepare('UPDATE inbox SET retry_attempts=0,last_attempt_at=NULL WHERE inbox_id=? AND processed_at IS NULL').run(args.sourceKey)
        if (!changed.changes) throw new Error('Pending inbox record not found')
        this.ledger.appendEvent('inbox', args.sourceKey, 'inbox.retry_reset', { actor })
        return this.inboxRetryStatus()
      }
      case 'retry_memory_extraction': return this.memory.retry(args.evidenceId ?? null)
      case 'reconcile_execution': return this.reconcileNativeExecution(args, { operator: codexMutationAuthority })
      case 'cancel_execution': this.flags.assert('task.native'); return this.cancelWorker(args.executionId, { reason: args.acceptanceSummary ?? 'cancelled by caller', agent, operator: codexMutationAuthority })
      case 'route': {
        const decision = route({ ...args.input, flags: this.flags.list() })
        const routeDecisionId = this.ledger.saveRouteDecision(decision, { taskId: decision.targetTaskId, targetSessionRefId: decision.targetSessionRefId })
        return { routeDecisionId, ...decision }
      }
      case 'route_feedback': this.flags.assert('task.native'); return this.ledger.recordRouteFeedback(args.routeDecisionId, { outcome: args.outcome, correction: args.correction })
      case 'list_approvals': return { approvals: this.approvalsPending() }
      case 'decide_approval': {
        if (!approvalAuthority) throw new Error('Approval decisions require an authenticated operator')
        const result = await this.approvals.decide(args.approvalId, { state: args.decision, response: args.response }, { decidedBy: actor })
        const approval = this.database.db.prepare('SELECT execution_id FROM approvals WHERE approval_id=?').get(args.approvalId)
        const execution = approval && this.database.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(approval.execution_id)
        if (result.state === 'approved' && execution?.execution_state === 'waiting_approval') this.ledger.transitionExecution(approval.execution_id, 'running', { expectedState: execution.execution_state })
         if (result.state === 'denied' && execution?.execution_state === 'waiting_approval') this.ledger.transitionExecution(approval.execution_id, 'cancelled', { expectedState: execution.execution_state })
        this.database.db.prepare(`UPDATE attention_items SET state='resolved',updated_at=? WHERE kind='approval_required' AND json_extract(detail_json,'$.approvalId')=? AND state='open'`).run(nowIso(), args.approvalId)
        return result
      }
      case 'execute': return this.executeObjective(args, { codexMutationAuthority, callerWorkspaceRoot, agent, signal })
      case 'feature_flags': return this.flags.list()
      case 'set_feature': {
        if (!featureAuthority) throw new Error('Feature changes require an authenticated operator')
        if (args.key === 'control.queue' && args.enabled) throw new Error('control.queue is unavailable until queued turns have a baseline and lease handoff protocol')
        return this.flags.set(args.key, args.enabled, { actor })
      }
      case 'backup': return this.createBackup({ verify: args.verify !== false })
      case 'verify_backup': return this.database.validateManagedBackup(args.backupName)
      default: throw new Error(`Unknown personal-agent action: ${args.action}`)
    }
  }

  /** Stop history work at its next checkpoint without closing resources still in use. */
  cancelHistory() { this.historyLifetime.abort() }

  async dispose() {
    this.disposed = true
    this.cancelHistory()
    this.workerLifetime.abort()
    await this.memoryInitializationOperation
    for (const timer of this.workerTimers.values()) clearTimeout(timer)
    this.workerTimers.clear()
    this.assistantSessionIds.clear()
    await this.importing?.catch(() => {})
    await this.memory?.running?.catch(() => {})
    while (this.publicOperations.size) await Promise.allSettled([...this.publicOperations])
    while (this.inFlightOperations.size) await Promise.allSettled([...this.inFlightOperations])
    while (this.executingRequests.size) await Promise.allSettled([...this.executingRequests.values()])
    for (const executionId of [...this.activeInternalExecutions.keys()]) {
      try { this.cancelInternalExecution(executionId, { reason: 'service disposed', allowDisposed: true }) }
      catch (error) { this.logger?.warn?.(`Unable to reconcile internal execution ${executionId}`, error) }
    }
    const liveCodex = this.database.db?.prepare("SELECT execution_id,execution_state FROM executions WHERE executor_kind='codex' AND execution_state IN ('dispatch_unknown','running','waiting_approval','waiting_user')").all() ?? []
    for (const execution of liveCodex) {
      this.ledger.transitionExecution(execution.execution_id, 'reconciling', { expectedState: execution.execution_state, failureCode: 'service_disposed', failureDetail: 'Reconnect and reconcile the native worker before retrying' })
      this.database.db.prepare("UPDATE leases SET lease_state='recovery_hold',release_reason='service_disposed' WHERE execution_id=? AND lease_state='active'").run(execution.execution_id)
    }
    await this.adapter?.close()
    this.database.close()
  }
}
