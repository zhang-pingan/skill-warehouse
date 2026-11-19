import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PersonalAgentService } from '../lib/service.js'
import { resolveConfig } from '../lib/config.js'

async function setup(t, overrides = {}, context = null) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pac-memory-initialization-'))
  const service = new PersonalAgentService(resolveConfig({ dataDir: path.join(root, 'data'), codexHome: path.join(root, 'codex'), historyRead: false, ...overrides }), { context, logger: { warn() {} } })
  t.after(async () => { await service.dispose(); rmSync(root, { recursive: true, force: true }) })
  await service.initialize()
  return { service, root, db: service.database.db }
}

function evidence(service, text = 'Atlas uses SQLite.') {
  return service.ledger.ingestSource({ sourceSystem: 'dsh', sourceKind: 'message', sourceUri: 'dsh://fixture', sourceLocator: text, sourceIdentity: text, text, authorRole: 'user' })
}
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n

function completedExecution(service, root) {
  const { ledger } = service
  const project = ledger.upsertProject({ name: 'Atlas', canonicalPath: root })
  const task = ledger.createTask({ objective: 'Old task', projectId: project.projectId, sourceKey: 'old-task' })
  const lease = ledger.acquireLease({ resourceKey: `workspace:${root}`, locationId: project.locationId })
  const baseline = ledger.saveBaseline(project.locationId, { capturedAt: new Date().toISOString(), gitHead: null, gitIndexTree: null, statusPorcelain: '', dirtyPaths: [], pathHashes: {}, captureComplete: true })
  const execution = ledger.planExecution({ taskId: task.taskId, executorKind: 'internal', method: 'internal/test', params: {}, dispatch: false, locationId: project.locationId, baselineId: baseline, leaseId: lease.leaseId })
  ledger.transitionExecution(execution.executionId, 'cancelled')
  const source = ledger.ingestSource({ sourceSystem: 'dsh', sourceKind: 'message', sourceUri: 'dsh://old-task', sourceLocator: '1', sourceIdentity: 'old-task', text: 'Old execution result', taskId: task.taskId, executionId: execution.executionId })
  const at = new Date().toISOString()
  service.database.db.prepare("INSERT INTO artifacts(artifact_id,task_id,execution_id,kind,path_or_uri,created_at,verification_evidence_id) VALUES('artifact',?,?,'file',?,?,?)").run(task.taskId, execution.executionId, path.join(root, 'output.txt'), at, source.evidenceId)
  service.database.db.prepare("INSERT INTO execution_usage VALUES(?,'usage','fixture','model','{}',?)").run(execution.executionId, at)
  service.database.db.prepare("INSERT INTO approvals(approval_id,execution_id,adapter_instance_id,connection_epoch,external_request_id,kind,scope_json,risk_summary,approval_state,requested_at) VALUES('approval',?,'fixture',1,'request','command','{}','fixture','denied',?)").run(execution.executionId, at)
  return execution
}

test('initialization empties memory and dependent records, preserves preferences and binding, and reimports upstream history', async t => {
  const now = Date.now()
  const events = [{ seq: 0, type: 'user/message', surfaceOp: 'append', time: now, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Retained upstream history about Atlas.' }] } }]
  const persistence = { identity: Symbol('initialization'), async list() { return [{ id: 'upstream', header: { id: 'upstream', createdAt: now, title: 'Upstream' }, revision: 'one', eventCount: 1 }] }, async open() { return { async read(offset) { return { events: offset ? [] : events } }, async close() {} } } }
  const { service, root, db } = await setup(t, { historyRead: true }, { sessionPersistence: persistence })
  db.prepare("INSERT INTO main_session_binding VALUES(1,'assistant-main',1,'ready','2026-11-16T00:00:00Z')").run()
  service.updateRuntimeSettings({ historyRetentionDays: 45, memoryExtractionEnabled: false })
  const preferences = service.runtimeSettingsView().settings
  const flags = service.database.featureFlags()
  completedExecution(service, root)
  const source = evidence(service)
  service.memory.createRecord({ kind: 'fact', content: 'Atlas uses SQLite.', evidence: [{ id: source.evidenceId, quote: 'Atlas uses SQLite.' }] })
  db.prepare("INSERT INTO import_cursors(importer_id,source_uri,source_instance_id,cursor_json,last_attempted_at) VALUES('old-import','old-source','old-file','{}','2026-11-12T00:00:00Z')").run()
  service.backgroundJobs.configure('memory-extraction', false, 4000)
  service.backgroundJobs.save({ name: 'old-job', lastError: 'stale failure' })
  const mainReset = { name: 'main-session-reset', archiveNumber: 3, state: 'succeeded', committed: true, oldSessionId: 'archived-main', newSessionId: 'assistant-main' }
  service.backgroundJobs.save(mainReset)
  service.database.backup(path.join(service.config.backupDir, 'ledger-2026-11-14T00.00.00.000Z.sqlite'))
  const personalBackup = path.join(service.config.backupDir, 'manual.sqlite')
  writeFileSync(personalBackup, 'unmanaged')
  writeFileSync(path.join(root, 'output.txt'), 'workspace output')
  const schema = db.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()
  assert.throws(() => service.initializeMemory(), /确认/)
  assert.equal(service.initializeMemory({ confirmed: true }).running, true)
  const operation = service.memoryInitializationOperation
  service.initializeMemory({ confirmed: true })
  assert.equal(service.memoryInitializationOperation, operation)
  await operation
  assert.equal(service.memoryInitializationView().state, 'succeeded', JSON.stringify(service.memoryInitializationView()))
  assert.equal(await service.assistantSessionTarget(), 'assistant-main')
  assert.deepEqual(service.runtimeSettingsView().settings, preferences)
  assert.deepEqual(service.database.featureFlags(), flags)
  for (const table of ['tasks','executions','artifacts','execution_usage','approvals','leases','workspace_baselines','projects','route_decisions','outbox','inbox','memory_records','memory_entities','memory_edges','memory_fts','analysis_runs']) assert.equal(count(db, table), 0, table)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM history_messages WHERE staged_text LIKE '%Retained upstream history%'").get().n, 1)
  assert.equal(count(db, 'evidence'), 0)
  assert.equal(count(db, 'memory_extraction_jobs'), 0)
  assert.equal(db.prepare("SELECT 1 FROM import_cursors WHERE source_uri='old-source'").get(), undefined)
  assert.equal(service.backgroundJobs.state('memory-extraction').enabled, false)
  assert.equal(service.backgroundJobs.state('old-job').lastError, undefined)
  assert.deepEqual(service.backgroundJobs.state('main-session-reset'), mainReset)
  assert.equal(service.database.listManagedBackups().length, 0)
  assert.ok(existsSync(personalBackup))
  assert.ok(existsSync(path.join(root, 'output.txt')))
  assert.deepEqual(events[0].data.content, [{ type: 'text', text: 'Retained upstream history about Atlas.' }])
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  assert.equal(service.database.integrityCheck().ok, true)
  assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all(), schema)
})

test('initialization drains cancelled writers and accepted requests before clearing, and blocks new work', async t => {
  const { service, db } = await setup(t)
  evidence(service)
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const previousSignal = service.historyLifetime.signal
  const oldWork = service.trackOperation(async () => {
    entered.resolve()
    await release.promise
    assert.equal(previousSignal.aborted, true)
    assert.equal(count(db, 'evidence'), 1)
    evidence(service, 'Late accepted write')
  })
  await entered.promise
  const analysis = Promise.withResolvers()
  service.memory.running = analysis.promise.finally(() => { service.memory.running = null })
  const analysisEntered = Promise.withResolvers()
  previousSignal.addEventListener('abort', () => analysisEntered.resolve(), { once: true })
  service.initializeMemory({ confirmed: true })
  const reset = service.memoryInitializationOperation
  await analysisEntered.promise
  assert.equal(service.memoryInitializationView().phase, 'draining')
  await assert.rejects(service.operate({ action: 'remember', content: 'Must not be written' }), { code: 'MEMORY_INITIALIZING' })
  assert.throws(() => service.request(() => evidence(service)), { code: 'MEMORY_INITIALIZING' })
  assert.throws(() => service.setCodexEnabled(true), { code: 'MEMORY_INITIALIZING' })
  assert.throws(() => service.updateRuntimeSettings({ historyRetentionDays: 10 }), { code: 'MEMORY_INITIALIZING' })
  assert.equal((await service.memory.run()).skipped, true)
  release.resolve(); await oldWork
  assert.equal(count(db, 'evidence'), 2)
  analysis.resolve()
  await reset
  assert.equal(count(db, 'evidence'), 0)
  assert.equal(service.historyLifetime.signal.aborted, false)
  assert.equal(service.memoryInitializationView().state, 'succeeded')
  evidence(service, 'Fresh write after initialization')
  assert.equal(count(db, 'evidence'), 1)
})

test('active or unreconciled workers prevent initialization without cancelling history or deleting records', async t => {
  const { service, root, db } = await setup(t)
  const execution = completedExecution(service, root)
  db.prepare("UPDATE executions SET execution_state='reconciling' WHERE execution_id=?").run(execution.executionId)
  assert.throws(() => service.initializeMemory({ confirmed: true }), { code: 'MEMORY_WORKERS_ACTIVE' })
  assert.equal(count(db, 'tasks'), 1)
  assert.equal(service.historyLifetime.signal.aborted, false)
  assert.equal(service.memoryInitializationOperation, null)
})

test('a cleanup failure leaves local data intact and permits retry', async t => {
  const { service, db } = await setup(t)
  evidence(service)
  writeFileSync(service.config.backupDir, 'not a directory')
  service.initializeMemory({ confirmed: true }); await service.memoryInitializationOperation
  assert.equal(service.memoryInitializationView().state, 'failed')
  assert.equal(service.memoryInitializationView().cleared, false)
  assert.equal(count(db, 'evidence'), 1)
  assert.equal(service.historyLifetime.signal.aborted, false)
  rmSync(service.config.backupDir); mkdirSync(service.config.backupDir)
  service.initializeMemory({ confirmed: true }); await service.memoryInitializationOperation
  assert.equal(service.memoryInitializationView().state, 'succeeded')
  assert.equal(count(db, 'evidence'), 0)
})

test('an import failure after clearing is reported distinctly and a retry creates a fresh history', async t => {
  let fail = true
  const persistence = { async list() { if (fail) throw new Error('History storage unavailable'); return [] }, async open() { throw new Error('No sessions') } }
  const { service, db } = await setup(t, { historyRead: true }, { sessionPersistence: persistence })
  evidence(service)
  service.initializeMemory({ confirmed: true }); await service.memoryInitializationOperation
  assert.equal(count(db, 'evidence'), 0)
  assert.equal(service.memoryInitializationView().cleared, true)
  assert.equal(service.memoryInitializationView().state, 'failed')
  assert.match(service.memoryInitializationView().lastError, /History storage unavailable/)
  fail = false
  service.initializeMemory({ confirmed: true }); await service.memoryInitializationOperation
  assert.equal(service.memoryInitializationView().state, 'succeeded')
})

test('failed SQL clearing rolls back every table without changing preferences', async t => {
  const { service, db } = await setup(t)
  const source = evidence(service)
  service.memory.createRecord({ kind: 'fact', content: 'Atlas uses SQLite.', evidence: [{ id: source.evidenceId, quote: 'Atlas uses SQLite.' }] })
  db.exec("CREATE TRIGGER block_clear BEFORE DELETE ON memory_records BEGIN SELECT RAISE(ABORT,'fixture failure'); END")
  const flags = service.database.featureFlags()
  service.initializeMemory({ confirmed: true }); await service.memoryInitializationOperation
  assert.equal(service.memoryInitializationView().state, 'failed')
  assert.equal(service.memoryInitializationView().cleared, false)
  assert.equal(count(db, 'evidence'), 1)
  assert.equal(count(db, 'memory_records'), 1)
  assert.deepEqual(service.database.featureFlags(), flags)
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
})

test('the Codex transport settles before clearing and its prior connection is restored', async t => {
  const { service, db } = await setup(t)
  const closeEntered = Promise.withResolvers(), closeReleased = Promise.withResolvers()
  const originalClose = service.adapter.close.bind(service.adapter)
  let connected = 0
  service.adapter.initialized = true
  t.mock.method(service.adapter, 'close', async () => { closeEntered.resolve(); await closeReleased.promise; evidence(service, 'Last transport write'); service.adapter.initialized = false })
  t.mock.method(service, 'connectCodex', async () => { connected++; assert.equal(count(db, 'evidence'), 0); service.adapter.initialized = true })
  t.after(() => { service.adapter.close = originalClose })
  service.initializeMemory({ confirmed: true })
  const pending = service.memoryInitializationOperation
  await closeEntered.promise
  assert.equal(service.memoryInitializationView().cleared, false)
  closeReleased.resolve(); await pending
  assert.equal(count(db, 'evidence'), 0)
  assert.equal(connected, 1)
  assert.equal(service.memoryInitializationView().state, 'succeeded')
})

test('Host disposal waits for initialization to stop without clearing accepted data', async t => {
  const { service, db } = await setup(t)
  const released = Promise.withResolvers()
  const oldWork = service.request(() => released.promise)
  evidence(service)
  service.initializeMemory({ confirmed: true })
  const pending = service.memoryInitializationOperation
  const stopping = service.dispose()
  assert.equal(service.database.closed, false)
  assert.equal(count(db, 'evidence'), 1)
  released.resolve(); await oldWork; await pending
  await stopping
  assert.equal(service.database.closed, true)
})

test('initialization preserves the canonical assistant when several past assistant bindings exist', async t => {
  const { service, db } = await setup(t)
  db.prepare("INSERT INTO main_session_binding VALUES(1,'current-assistant',1,'ready','2026-11-16T00:00:00Z')").run()
  service.ledger.upsertSession({ system: 'dsh', externalId: 'past-assistant', sourceKind: 'personal_assistant' })
  db.prepare("UPDATE session_refs SET first_seen_at='2026-10-01T00:00:00Z',last_seen_at='2026-10-01T00:00:00Z' WHERE external_id='past-assistant'").run()
  assert.equal(await service.assistantSessionTarget(), 'current-assistant')
  service.initializeMemory({ confirmed: true }); await service.memoryInitializationOperation
  assert.equal(await service.assistantSessionTarget(), 'current-assistant')
  assert.equal(service.isAssistantSession('past-assistant'), false)
  assert.equal(db.prepare("SELECT count(*) AS n FROM session_refs WHERE source_kind='personal_assistant'").get().n, 0)
})

test('an interrupted initialization remains visible after restart and does not resume deletion', async t => {
  const { service } = await setup(t)
  evidence(service)
  service.backgroundJobs.save({ name: 'memory-initialization', running: true, state: 'running', phase: 'draining', cleared: false })
  await service.dispose()
  const restarted = new PersonalAgentService(service.initialConfig, { logger: { warn() {} } })
  t.after(() => restarted.dispose())
  await restarted.initialize()
  assert.equal(restarted.memoryInitializationView().running, false)
  assert.equal(restarted.memoryInitializationView().state, 'failed')
  assert.equal(count(restarted.database.db, 'evidence'), 1)
})


test('initialization retains data and does not replace a reader whose termination failed', async t => {
  const { service, db } = await setup(t)
  evidence(service)
  const reader = service.queryReader
  const close = reader.close.bind(reader)
  reader.close = async () => { throw new Error('reader termination failed') }
  try {
    service.initializeMemory({ confirmed: true })
    await service.memoryInitializationOperation
    assert.equal(service.memoryInitializationView().state, 'failed')
    assert.equal(service.queryReader, reader)
    assert.equal(count(db, 'evidence'), 1)
  } finally { reader.close = close }
})

test('initialization closes the active read connection before clearing and recreates it lazily', async t => {
  const { service } = await setup(t)
  evidence(service)
  const reader = service.queryReader
  await service.readQuery('list', { type: 'memory' })
  assert.ok(reader.worker)
  service.initializeMemory({ confirmed: true })
  await service.memoryInitializationOperation
  assert.equal(service.memoryInitializationView().state, 'succeeded')
  assert.equal(reader.closed, true)
  assert.equal(reader.worker, null)
  assert.notEqual(service.queryReader, reader)
  assert.equal(service.queryReader.worker, null)
  await service.readQuery('list', { type: 'memory' })
})
