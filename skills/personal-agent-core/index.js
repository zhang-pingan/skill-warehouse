import { randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolveConfig } from './lib/config.js'
import { PersonalAgentService } from './lib/service.js'

export const Config = { '~standard': { version: 1, vendor: 'personal-agent', validate(input) {
  try { return { value: resolveConfig(input) } } catch (error) { return { issues: [{ message: error.message }] } }
} } }

export const inject = ['webServer', 'connection', 'tools', 'commands', 'timer', 'appReady', 'sessionPersistence', 'sessionController', 'llm', 'agentDefaultModel', 'workingDirectory', 'agentPresets', 'workspaceRegistry', 'agents', 'subagents']
const BASE = '/api/personal-agent'
const failureText = error => String(error?.message ?? error).slice(0, 1000)

export const ASSISTANT_CONTEXT = `Act as the user's top-level private assistant in this DSH session.
Use the personal_agent tool whenever persistent tasks, prior actions, historical context, approvals, or cited evidence can improve the answer. Cite the returned source keys or evidence identifiers for historical claims.
Historical conversation tasks are separate from the persistent execution ledger. memory_search recalls task summaries and original-message matches grouped and paginated by historical task; search_history searches hot and archived task history together. Use concise topical terms and explicit from/to dates when needed. Inspect coverage and unresolved messages before concluding that no matching history was found. Absence from list_tasks never establishes absence from historical conversations. Read a result using memory_get with sessionTaskId, then page its original messages with offset and open exact evidenceId sources, including surrounding conversation. Task summaries and assistant claims are leads, not independent verification. Cite original evidence. Archive temperature changes neither relevance nor credibility.
Your main session uses the standard preset for clarification, retrieval, routing, task tracking, and reporting. Handle ordinary questions, progress checks, and brief work directly when that is sufficient; create or associate a persistent Task only when the user has a durable objective. Delegate substantive or long-running execution to workers instead of performing it in the main session.
For durable tasks, dispatch DSH and Codex workers through personal_agent execute so Task, Execution and workspace coordination remain linked. For DSH workers, select an explicit agentPreset: standard for general research, analysis, and ordinary implementation; cordis for developing or configuring Harness plugins, bundles, tools, and presets; ptc for tasks that need PTC; minimal only for a small task whose required tools are available there. Give each worker a self-contained objective, workspace, constraints, and acceptance criteria. Use spawn when a DSH worker needs a different preset; the fork provider inherits the main session's standard preset and cannot select an independent mode. A Codex worker has no DSH mode. Assess the returned evidence before reporting completion: a successful turn is not Task completion without acceptance evidence.
Treat Codex as a managed subordinate capability when its connection and execution routes are enabled. Ask personal_agent to route Codex work and follow its deterministic resume, fork, or new-session decision instead of asking the user to manage Codex sessions. When Codex execution is disabled, use a DSH worker rather than attempting a disabled route.
For direct work on a persistent Task, call execute with worker internal before using tools, then finish_execution with the recorded work after it completes. cancel_execution retains a recovery hold until the outcome is reconciled. Use memory_search for prior conversations, preferences, decisions, entities, and evidence; candidate memories are leads, not facts. Use remember only for text stated in the current user message, and use correct_memory, confirm_memory, confirm_entity, retract_memory, or forget_memory only when the user explicitly requests that action. Respect all feature flags, approvals, workspace baselines, leases, and recovery holds. Never claim a protected action completed unless the tool result confirms it.
Answer the user's visible request directly. Do not mention this injected context unless the user asks how the private assistant works.`

export function assistantContextMessage() {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    source: Object.freeze({
      kind: 'agent-instructions',
      form: 'instructions',
      changes: Object.freeze([Object.freeze({ action: 'add', scope: 'session', path: 'personal-assistant' })]),
    }),
    content: Object.freeze([Object.freeze({ type: 'text', text: ASSISTANT_CONTEXT })]),
  })
}

export const TOOL = {
  name: 'personal_agent',
  description: '私人助理核心：按需检索带来源的经历、实体与记忆，查看和维护持久任务，解释路由并检查执行状态。',
  parameters: { type: 'object', properties: {
    sessionId:{type:'string'}, sort:{type:'string',enum:['recent','relevance']}, version:{type:'string',description:'Return the version from the previous task detail page to detect changed history.'},
    historyMessageId: {type:'string',description:'Read staged or unassigned original message without fabricating evidence or a task.'},
    sessionTaskId: {type:'string',description:'Stable historical session task id; memory_get reads its overview and paginated original messages.'},
    offset: {type:'integer',minimum:0,description:'Task-level query or message-page offset.'},
    action: { type: 'string', enum: ['health','import_history','search_history','memory_search','memory_get','remember','correct_memory','confirm_memory','confirm_entity','retract_memory','forget_memory','retry_memory_extraction','list_tasks','get_task','create_task','create_step','list_steps','transition_step','transition_task','record_acceptance','finish_execution','cancel_execution','link_project_location','route','route_feedback','execute','list_approvals','feature_flags','backup','verify_backup'] },
    query: { type: 'string', description: 'Concise topical terms. Historical matches are grouped and paginated by session task across hot and archived sources. Read coverage before interpreting no matches; use memory_get with sessionTaskId then evidenceId for original sources.' }, content: { type: 'string' }, projectId: { type: 'string' }, taskId: { type: 'string' }, memoryId: { type: 'string' }, entityId: { type: 'string' }, edgeId: { type: 'string' }, evidenceId: { type: 'string' }, predicate: { type: 'string' }, value: { type: 'object', additionalProperties: true }, entityName: { type: 'string' }, entityType: { type: 'string', enum: ['user','project','repository','person','tool','task','session','artifact','other'] }, kind: { type: 'string', enum: ['fact','reflection','decision','summary','objective','correction','follow_up'] }, includeCandidates: { type: 'boolean' }, includeHistory: { type: 'boolean', description: 'memory_search only: include task-index and raw-message recall grouped by historical task, default true. list_tasks always reads only the persistent task ledger.' }, sourceSystem: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, asOf: { type: 'string', description: 'Recall facts valid at this ISO timestamp with timezone; defaults to now. from/to filter source or record dates.' }, limit: { type: 'integer', minimum: 1, maximum: 200 },
    stepId: { type: 'string' }, constraints: { type: 'array', items: { type: 'string' } }, requiredArtifacts: { type: 'array', items: { type: 'string' } },
    objective: { type: 'string' }, sourceKey: { type: 'string' }, parentTaskId: { type: 'string' }, state: { type: 'string', description: 'Target task state for transition_task.' }, expectedState: { type: 'string', description: 'Current task state required by transition_task.' },
    dependencies: { type: 'array', maxItems: 32, items: { type: 'string' } }, correction: { type: 'object', additionalProperties: true }, outcome: { type: 'string', enum: ['accepted','corrected','rejected'] }, routeDecisionId: { type: 'string' },
    input: { type: 'object', additionalProperties: true }, full: { type: 'boolean' },
    method: { type: 'string' }, params: { type: 'object', additionalProperties: true },
    workspacePath: { type: 'string' }, projectName: { type: 'string' }, relevantPaths: { type: 'array', maxItems: 200, items: { type: 'string' } },
    requestId: { type: 'string' }, sourceMessageId: { type: 'string' }, forceNew: { type: 'boolean' }, forceFork: { type: 'boolean' },
    worker: { type: 'string', enum: ['codex','dsh_subagent','internal'] }, provider: { type: 'string' }, agentPreset: { type: 'string' }, label: { type: 'string' }, name: { type: 'string' }, output: { type: 'string' }, result: { type: 'string' }, mutatesWorkspace: { type: 'boolean' }, acceptance: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string' } }, acceptanceState: { type: 'string', enum: ['passed','failed','pending'] }, acceptanceSummary: { type: 'string' }, criterionId: { type: 'string' }, evidenceIds: { type: 'array', maxItems: 32, items: { type: 'string' } }, executionId: { type: 'string' }, includeTemporary: { type: 'boolean' },
    model: { type: 'string' }, modelProvider: { type: 'string' }, effort: { type: 'string' }, personality: { type: 'string' }, developerInstructions: { type: 'string' },
    requestedCapabilities: { type: 'array', maxItems: 50, items: { type: 'string' } },
    verify: { type: 'boolean' }, backupName: { type: 'string' },
  }, required: ['action'], additionalProperties: false },
  output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
  isConcurrencySafe: args => ['health','search_history','memory_search','memory_get','list_tasks','get_task','list_approvals','feature_flags','verify_backup'].includes(args?.action),
}

async function requestJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > 262_144) throw new Error('Request body too large')
    chunks.push(bytes)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Request must be a JSON object')
  return value
}

function requestRejection(connection, req) {
  if (typeof connection?.requestRejection !== 'function') return 503
  return connection.requestRejection(req)
}

function authorizedOperator(req, configuredToken) {
  if (!configuredToken) return false
  const value = req.headers?.authorization
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return false
  const supplied = Buffer.from(value.slice(7), 'utf8')
  const expected = Buffer.from(configuredToken, 'utf8')
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

function json(res, status, value) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.end(JSON.stringify(value))
}

export function apply(ctx, pluginConfig = {}) {
  ctx.effect(function* () {
    const config = resolveConfig(pluginConfig)
    const assets = [
      { name: 'starmap_bg.mp4', type: 'video/mp4', body: readFileSync(new URL('./assets/starmap_bg.mp4', import.meta.url)) }
    ]
    const service = new PersonalAgentService(config, { context: ctx, logger: ctx.logger ?? console })
    const ready = service.initialize()
    const disposers = []
    const backgroundTimers = new Map()
    let backgroundStarted = false
    let syncBackgroundTimers = null
    const route = (routePath, method, handler, { beforeReady = null } = {}) => ctx.webServer.register({ kind: 'exact', path: `${BASE}${routePath}`, handler: async (req, res) => {
      const rejection = requestRejection(ctx.connection, req)
      if (rejection !== undefined) { res.statusCode = rejection; res.end(); return }
      const methods = Array.isArray(method) ? method : [method]
      if (!methods.includes(req.method)) { res.setHeader('Allow', methods.join(', ')); json(res, 405, { error: `Method must be ${methods.join(' or ')}` }); return }
      try {
        if (beforeReady) await beforeReady(req)
        await ready
        const maintenance = routePath === '/memory/initialization' || routePath === '/memory/extraction'
        json(res, 200, await (maintenance ? handler(req) : service.request(() => handler(req))))
      } catch (error) { json(res, error.statusCode ?? 400, { error: failureText(error), code: error.code ?? null }) }
    } })
    for (const asset of assets) disposers.push(ctx.webServer.register({ kind: 'exact', path: BASE + '/assets/' + asset.name, handler: (req, res) => {
      const rejection = requestRejection(ctx.connection, req)
      if (rejection !== undefined) { res.statusCode = rejection; res.end(); return }
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.setHeader('Allow', 'GET, HEAD')
        res.statusCode = 405
        res.end()
        return
      }
      const body = asset.body
      const size = body.length
      const headers = {
        'Content-Type': asset.type,
        'Cache-Control': 'no-store',
        'Accept-Ranges': 'bytes',
        'X-Content-Type-Options': 'nosniff'
      }
      const range = req.headers?.range
      let status = 200
      let start = 0
      let end = size - 1
      if (range !== undefined) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
        start = match?.[1] ? Number(match[1]) : 0
        end = match?.[2] ? Number(match[2]) : size - 1
        if (match && !match[1] && match[2]) {
          start = Math.max(0, size - Number(match[2]))
          end = size - 1
        }
        if (!match || !match[1] && !match[2] || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end || size === 0) {
          for (const [name, value] of Object.entries({ ...headers, 'Content-Range': 'bytes */' + size })) res.setHeader(name, value)
          res.statusCode = 416
          res.end()
          return
        }
        end = Math.min(end, size - 1)
        status = 206
        headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size
      }
      headers['Content-Length'] = String(end - start + 1)
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
      res.statusCode = status
      res.end(req.method === 'HEAD' ? undefined : body.subarray(start, end + 1))
    } }))
    disposers.push(route('/dashboard', ['GET', 'POST'], async req => {
      if (req.method === 'GET') return service.dashboard()
      const body = await requestJson(req)
      if (body.action !== 'create-task') throw new TypeError('action must be create-task')
      return { task: service.createAssistantTask(body) }
    }))
    const settingsView = async () => ({ ...service.runtimeSettingsView(), presets: await ctx.agentPresets.list() })
    disposers.push(route('/settings', ['GET', 'PUT'], async req => {
      if (req.method === 'GET') return settingsView()
      const updated = service.updateRuntimeSettings(await requestJson(req))
      syncBackgroundTimers?.({ historyBecameEnabled: !updated.previous.historyPeriodicSyncEnabled && updated.settings.historyPeriodicSyncEnabled })
      return settingsView()
    }))
    disposers.push(route('/settings/codex', 'POST', async req => {
      const body = await requestJson(req)
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.enabled !== 'boolean') throw new TypeError('enabled must be the only boolean setting')
      const codexChange = await service.setCodexEnabled(body.enabled)
      return { ...await settingsView(), codexChange }
    }))
    disposers.push(route('/memory', ['GET','POST'], async req => {
      if (req.method === 'POST') return service.manageMemory(await requestJson(req), { actor: 'operator' })
      const params = new URL(req.url, 'http://localhost').searchParams
      return service.manageMemory({ action: 'list', type: params.get('type') ?? 'all', query: params.get('query') ?? '', state: params.get('state'),
        version:params.get('version'), rawSearch: params.get('rawSearch') === 'true', sourceSystem: params.get('source'), entityId: params.get('entityId'), from: params.get('from'), to: params.get('to'),
        limit: Number(params.get('limit') ?? 50), offset: Number(params.get('offset') ?? 0) })
    }))
    disposers.push(route('/memory/extraction', 'GET', req => service.memoryExtractionView({cursor:new URL(req.url,'http://localhost').searchParams.get('cursor')})))
    disposers.push(route('/memory/initialization', ['GET', 'POST'], async req => {
      if (req.method === 'GET') return service.memoryInitializationView()
      const body = await requestJson(req)
      if (!body || Object.keys(body).length !== 1 || body.confirmed !== true) throw new TypeError('confirmed must be the only field and must be true')
      return service.initializeMemory(body)
    }))
    disposers.push(route('/memory/item', 'GET', async req => {
      const params = new URL(req.url, 'http://localhost').searchParams
      return service.manageMemory({ action: 'get', memoryId: params.get('memoryId'), entityId: params.get('entityId'), evidenceId: params.get('evidenceId'), taskId: params.get('taskId'), historyMessageId:params.get('historyMessageId'), sessionTaskId: params.get('sessionTaskId'), offset:Number(params.get('offset')??0), version:params.get('version'), edgeId: params.get('edgeId') })
    }))
    disposers.push(route('/task', 'GET', async req => {
      const taskId = new URL(req.url, 'http://localhost').searchParams.get('id')
      if (!taskId) throw new TypeError('id is required')
      return service.dashboardTaskDetail(taskId)
    }))
    disposers.push(route('/session', 'GET', async req => {
      const sessionId = new URL(req.url, 'http://localhost').searchParams.get('id')
      if (!sessionId) {
        const target = await service.assistantSessionTarget()
        if (!target) return { sessionId: null, agentPreset: null }
        const resolved = await ctx.sessionController.resolveAgent(target)
        if (!resolved || 'error' in resolved) throw new Error(`Unable to load the private-assistant session: ${resolved?.error?.message ?? 'Unknown error'}`)
        return { sessionId: target, agentPreset: ctx.agentPresets.presetForSession(resolved.agent.session) }
      }
      return { assistant: service.isAssistantSession(sessionId) }
    }))
    const requireOperator = req => {
      if (authorizedOperator(req, config.operatorToken)) return
      const error = new Error('Authenticated operator token is required')
      error.code = 'OPERATOR_AUTH_REQUIRED'
      error.statusCode = 403
      throw error
    }
    disposers.push(route('/operate', 'POST', async req => {
      return service.operate(await requestJson(req), { actor: 'operator', codexMutationAuthority: true, featureAuthority: true, approvalAuthority: true })
    }, { beforeReady: requireOperator }))
    disposers.push(ctx.commands.register({
      name: 'personal-assistant',
      description: 'Load the persistent private-assistant role into the current DSH session.',
      handler: async ({ agent, signal }) => {
        await ready
        signal?.throwIfAborted?.()
        if (ctx.agentPresets.presetForSession(agent.session) !== 'standard') await ctx.agentPresets.select(agent, 'standard')
        service.registerAssistantSession(agent.session.id)
        agent.inject(assistantContextMessage())
        await ctx.sessionPersistence.flush()
        return { kind: 'success', text: '私人助理上下文已载入。' }
      },
    }))
    disposers.push(ctx.tools.register({ ...TOOL, execute: async (args, exec) => {
      await ready
      exec?.signal?.throwIfAborted?.()
      const sessionId = exec?.agent?.session?.id
      const callerWorkspaceRoot = exec?.agent && !service.isAssistantSession(sessionId)
        ? await ctx.workingDirectory.ensure(exec.agent, exec.signal)
        : null
      return service.operate(args, { actor: 'assistant', callerWorkspaceRoot, codexMutationAuthority: false, featureAuthority: false, approvalAuthority: false, agent: exec?.agent ?? null, signal: exec?.signal ?? null })
    } }))
    for (const dispose of disposers) yield dispose
    let disposed = false
    const replaceInterval = (name, enabled, intervalMs, callback) => {
      const current = backgroundTimers.get(name)
      if (enabled && current?.intervalMs === intervalMs) return false
      if (!enabled && !current) { service.backgroundJobs?.configure(name, false, intervalMs); return false }
      service.backgroundJobs?.configure(name, enabled, intervalMs)
      current?.stop()
      backgroundTimers.delete(name)
      if (!enabled) return true
      const stop = ctx.timer?.interval(() => {
        if (!service.memoryInitializationOperation) service.trackOperation(() => service.memoryInitializationOperation ? null : service.backgroundJobs.tick(name, callback), name)
      }, intervalMs)
      backgroundTimers.set(name, { enabled, intervalMs, stop: typeof stop === 'function' ? stop : () => {} })
      return true
    }
    syncBackgroundTimers = ({ startup = false, historyBecameEnabled = false } = {}) => {
      if (!backgroundStarted || disposed) return
      const settings = service.runtimeSettingsView().settings
      replaceInterval('history', settings.historyPeriodicSyncEnabled, settings.importIntervalMs,
        async () => { await service.importHistory(); if(service.config.memoryExtractionEnabled) await service.memory.run() })
      replaceInterval('worker-heartbeat', settings.workerHeartbeatEnabled, settings.workerHeartbeatMs, () => service.heartbeatWorkers())
      replaceInterval('inbox', settings.inboxRetryEnabled, settings.inboxRetryIntervalMs,
        () => service.retryInboxProjections())
      replaceInterval('memory-extraction', settings.memoryExtractionEnabled, settings.memoryExtractionIntervalMs,
        () => service.memory.run())
      replaceInterval('cleanup', settings.cleanupEnabled, settings.cleanupIntervalMs,
        () => service.ledger.history.archive())
      replaceInterval('backup', settings.backupEnabled, settings.backupIntervalMs,
        () => service.createBackup())
      if ((startup && settings.historyStartupSyncEnabled) || historyBecameEnabled) {
        service.trackOperation(async () => { await service.backgroundJobs.run('history', () => service.importHistory({full:startup})); if(service.config.memoryExtractionEnabled && !disposed) await service.backgroundJobs.run('memory-extraction', () => service.memory.run()) }, 'history import')
      }
    }
    const startup = Promise.withResolvers()
    const stopStartup = ctx.appReady.onReady(() => startup.resolve())
    const backgroundReady = Promise.all([ready, startup.promise]).then(() => {
      if (disposed) return
      backgroundStarted = true
      syncBackgroundTimers({ startup: true })
    }).catch(error => ctx.logger?.error?.('Personal-agent initialization failed', error))
    return async () => {
      disposed = true
      stopStartup()
      startup.resolve()
      service.cancelHistory()
      for (const { stop } of backgroundTimers.values()) stop()
      backgroundTimers.clear()
      await ready.catch(() => {})
      await backgroundReady
      await service.dispose()
    }
  }, 'Personal-agent ledger, history retrieval, router, controlled Codex adapter, and recovery')
}

export { resolveConfig, PersonalAgentService }
