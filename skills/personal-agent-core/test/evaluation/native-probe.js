/** Isolated native main-session and worker measurements; corpus labels stay in the caller. */
import { timingSafeEqual, randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createFixture, loadJson } from './fixture.js'
import { TOOL } from '../../index.js'
import { MainSession } from '../../lib/main-session.js'
import { wechatProjection } from '../../lib/wechat-projection.js'
import { executionProjection } from '../../lib/execution-projection.js'
import { ExecutionResults } from '../../lib/execution-results.js'

export const inject = ['webServer', 'agents', 'subagents', 'agentPresets', 'agentDefaultModel', 'sessionPersistence', 'sessionProjections', 'sessionController', 'sessionQuery', 'sessionTitle', 'workspaceRegistry', 'workspaceController', 'workingDirectory', 'tools', 'credentials']
const exec = promisify(execFile)

async function observe(ctx, sessionId) {
  await ctx.sessionPersistence.flush()
  const handle = await ctx.sessionPersistence.open(sessionId, 'read')
  const events = []
  try {
    while (true) {
      const page = await handle.read(events.length, 256)
      if (!page.events.length) break
      events.push(...page.events)
    }
  } finally { await handle.close() }
  const messages = events.filter(event => event.type === 'assistant/message' && event.surfaceOp === 'append')
  const final = messages.filter(event => !event.data.message.content.some(block => block.type === 'tool-call')).at(-1)
  const attempts = events.filter(event => ['assistant/message', 'assistant/attempt'].includes(event.type)).map(event => ({ seq: event.seq, type: event.type,
    usage: event.data.usage ?? event.data.stream?.findLast(record => record.type === 'chunk' && record.chunk.type === 'usage')?.chunk.usage ?? null }))
  return { sessionId, text: final?.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? '',
    endings: events.filter(event => event.type === 'turn/end').map(event => event.data.reason), attempts,
    toolCalls: messages.flatMap(event => event.data.message.content.filter(block => block.type === 'tool-call')),
    events }
}

function reply(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

export async function apply(ctx) {
  const root = await realpath(process.env.DSH_EVALUATION_ROOT)
  if (await realpath(process.env.DSH_HOME) !== path.join(root, 'harness-home') || await realpath(process.env.CODEX_HOME) !== path.join(root, 'codex-home')) throw new Error('Native evaluation requires isolated homes')
  const selection = JSON.parse(process.env.DSH_EVALUATION_SELECTION)
  const provider = JSON.parse(process.env.DSH_EVALUATION_PROVIDER)
  const token = Buffer.from(`Bearer ${process.env.DSH_EVALUATION_TOKEN}`)
  const lifetime = new AbortController()
  const pending = new Set()
  const corpus = loadJson('corpus.json')
  const visible = { ...corpus, families: corpus.families.filter(family => family.split !== 'holdout') }
  await ctx.workspaceRegistry.initializeDefault(async () => path.join(root, 'workspace'))
  const mainProjection = await ctx.sessionProjections.register(wechatProjection)
  const workerProjection = await ctx.sessionProjections.register(executionProjection)
  let fixture = null
  const tool = ctx.tools.register({ ...TOOL, execute: async (args, execution) => {
    if (!fixture) throw new Error('No native measurement is active')
    const service = fixture.service
    const callerWorkspaceRoot = execution.agent && !service.isAssistantSession(execution.agent.session.id) ? await ctx.workingDirectory.ensure(execution.agent, execution.signal) : null
    return service.operate({ ...args, ...(args.action === 'execute' && !args.requestId ? { requestId: execution.callId } : {}) },
      { actor: 'assistant', callerWorkspaceRoot, codexMutationAuthority: false, featureAuthority: false, approvalAuthority: false, agent: execution.agent, signal: execution.signal })
  } })
  const eventDispose = ctx.on('session/event', (session, event) => {
    const service = fixture?.service
    if (service?.database.db && event.type === 'turn/end') service.results.captureTerminal(session)
  })
  const runCase = async options => {
    if (!['native-main', 'native-worker'].includes(options.purpose) || typeof options.input?.query !== 'string') throw new Error('Invalid native measurement')
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(options.budgetMs)])
    fixture = await createFixture(visible, { analysisInputChars: 100000 })
    const service = fixture.service
    service.context = ctx
    service.analysisRuns.context = ctx
    service.results = new ExecutionResults(service, workerProjection)
    service.mainSession = new MainSession(service, mainProjection)
    const tools = []
    let target, codexStarted = false, codexAuth = null, codexRoot = null
    const started = performance.now()
    const cancel = () => target?.agent.cancel({ kind: 'user' })
    signal.addEventListener('abort', cancel, { once: true })
    try {
      target = await service.mainSession.ensure()
      target.agent.model.select(selection)
      if (options.purpose === 'native-main') {
        const prompt = `${options.input.query}\n\n时间条件：问题中的日期时间均为 UTC；本次资料观测时点为 ${options.input.observedAt}，查询指定时点为 ${options.input.asOf}。`
        await ctx.sessionController.prompt({ sessionId: target.sessionId, requestId: randomUUID(), mode: 'queue', clientTimeZone: 'UTC', content: [{ type: 'text', text: prompt }] }, signal)
        await target.agent.whenIdle()
        const observation = await observe(ctx, target.sessionId)
        return { ok: observation.endings.at(-1)?.kind === 'completed' && !signal.aborted, purpose: options.purpose,
          elapsedMs: performance.now() - started, ...observation, evidenceMap: Object.fromEntries(fixture.maps.evidence) }
      }
      const backend = options.input.backend
      if (!['dsh', 'codex'].includes(backend)) throw new Error('Unknown worker backend')
      // Worker measurements stop at the execution result; autonomous main-session reporting is a separate workload.
      service.mainSession = null
      const workspace = path.join(root, 'workspace')
      service.config = Object.freeze({ ...service.config, allowedWorkspaceRoots: [...service.config.allowedWorkspaceRoots, workspace] })
      service.database.config = service.config
      await writeFile(path.join(workspace, 'source.json'), JSON.stringify(options.input.source, null, 2) + '\n')
      if (backend === 'codex') {
        codexRoot = await realpath(await mkdtemp('/tmp/pa-codex-eval-'))
        service.config = Object.freeze({ ...service.config, codexHome: codexRoot, codexSocketPath: path.join(codexRoot, 'app-server-control', 'app-server-control.sock'),
          ...(process.env.DSH_EVALUATION_CODEX_EXPERIMENTAL === undefined ? {} : { experimentalCodexApi: process.env.DSH_EVALUATION_CODEX_EXPERIMENTAL === 'true' }) })
        service.daemon.config = service.config
        service.adapter.config = service.config
        service.codexImporter.config = { ...service.codexImporter.config, codexHome: codexRoot }
        service.historyConfig = { ...service.historyConfig, codexHome: codexRoot }
        await mkdir(service.config.codexHome, { recursive: true, mode: 0o700 })
        const installedCodex = await realpath(process.env.DSH_EVALUATION_CODEX_INSTALL)
        await mkdir(path.join(codexRoot, 'packages', 'standalone'), { recursive: true })
        await cp(installedCodex, path.join(codexRoot, 'packages', 'standalone', 'current'), { recursive: true, dereference: true })
        const credential = await ctx.credentials.resolve(provider.apiKeyEnv)
        if (!credential?.value) throw new Error('Selected provider credential unavailable')
        codexAuth = path.join(service.config.codexHome, 'auth.json')
        await writeFile(codexAuth, JSON.stringify({ OPENAI_API_KEY: credential.value }), { mode: 0o600, flag: 'wx' })
        await writeFile(path.join(service.config.codexHome, 'config.toml'), `model_provider = "evaluation"\nmodel = ${JSON.stringify(selection.model)}\npreferred_auth_method = "apikey"\napproval_policy = "never"\nsandbox_mode = "workspace-write"\n[model_providers.evaluation]\nname = "Isolated evaluation"\nbase_url = ${JSON.stringify(provider.baseURL)}\nwire_api = "responses"\nrequires_openai_auth = true\n`, { mode: 0o600, flag: 'wx' })
        service.database.clock = Date.now
        service.ledger.clock = Date.now
        await service.setCodexEnabled(true)
        service.updateRuntimeSettings({ defaultWorkerPriority: 'codex' })
        codexStarted = true
        await service.connectCodex()
      }
      const runWorker = async (query, prior, overrides = {}, operator = false) => {
        const value = await service.executeObjective({ objective: query, requestId: randomUUID(), intent: prior ? 'continue' : 'new',
          ...(prior ? { taskId: prior.taskId } : { modelProvider: backend === 'codex' ? 'evaluation' : selection.provider, model: selection.model }),
          workspacePath: workspace, mutatesWorkspace: false, acceptance: ['Return the requested JSON, respecting the source constraints.'], ...overrides }, operator ? { codexMutationAuthority:true, signal } : { agent: target.agent, signal })
        if (value.blocked || value.clarificationRequired || (!value.childId && !value.threadId)) return { dispatch: value, ok: false }
        if (backend === 'dsh') {
          if (value.accepted) {
            while (true) {
              signal.throwIfAborted()
              const observed = await observe(ctx, value.childId)
              if (observed.endings.length > 1) return { dispatch: value, ok: observed.endings.at(-1)?.kind === 'completed', observation: observed }
              await delay(100, undefined, { signal })
            }
          }
          const observation = await observe(ctx, value.childId)
          return { dispatch: value, ok: observation.endings.at(-1)?.kind === 'completed', observation }
        }
        while (true) {
          signal.throwIfAborted()
          const row = service.database.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(value.executions.at(-1).executionId)
          if (['succeeded','failed','interrupted','cancelled','waiting_approval','waiting_user'].includes(row.execution_state)) {
            const native = await service.adapter.request('thread/read', { threadId: value.threadId, includeTurns: true })
            return { dispatch: value, ok: row.execution_state === 'succeeded', state: row.execution_state, native }
          }
          await delay(100, undefined, { signal })
        }
      }
      const first = await runWorker(options.input.query, null)
      tools.push(first)
      if (first.ok && options.input.continuation) tools.push(await runWorker(options.input.continuation, first.dispatch))
      let directoryParity = null
      if (backend === 'codex' && options.input.directoryParity && tools.every(turn=>turn.ok)) {
        const removed=path.join(workspace,'removed-directory'),requested=path.join(workspace,'requested-directory')
        await mkdir(removed);await mkdir(requested)
        const seed=await service.adapter.request('thread/fork',{threadId:first.dispatch.threadId,cwd:removed,runtimeWorkspaceRoots:[removed],excludeTurns:true,deferGoalContinuation:true})
        await rm(removed,{recursive:true})
        const continued=await runWorker('Reply with exactly {"directory":"switched"}. Do not use tools or modify files.',null,
          {sessionId:seed.thread.id,sourceSystem:'codex',intent:'continue',workspacePath:requested})
        if (!continued.ok) throw new Error(`Codex directory continuation failed: ${JSON.stringify(continued.dispatch)}`)
        const settings=await service.adapter.request('thread/resume',{threadId:continued.dispatch.threadId,excludeTurns:true})
        const executionId=continued.dispatch.executions.at(-1).executionId
        const ownership=service.database.db.prepare(`SELECT l.canonical_path,e.workspace_location_id AS executionLocation,b.workspace_location_id AS baselineLocation,k.workspace_location_id AS leaseLocation FROM executions e JOIN project_locations l ON l.location_id=e.workspace_location_id JOIN workspace_baselines b ON b.baseline_id=e.workspace_baseline_id JOIN leases k USING(execution_id) WHERE e.execution_id=?`).get(executionId)
        directoryParity={continued,settings,ownership,sameThread:continued.dispatch.threadId===seed.thread.id}
        if (!directoryParity.sameThread || settings.cwd!==requested || ownership.canonical_path!==requested || ownership.executionLocation!==ownership.baselineLocation || ownership.executionLocation!==ownership.leaseLocation) throw new Error(`Codex directory parity failed: ${JSON.stringify(directoryParity)}`)
      }
      let operationsAudit = null
      if (backend === 'codex' && options.input.operationsAudit && tools.every(turn => turn.ok)) {
        const moved = path.join(workspace,'moved'), extra = path.join(workspace,'extra')
        await mkdir(moved);await mkdir(extra)
        const seed = await service.adapter.request('thread/fork',{threadId:first.dispatch.threadId,cwd:moved,runtimeWorkspaceRoots:[moved,extra],excludeTurns:true,deferGoalContinuation:true})
        const adopted = await runWorker('Reply with exactly {"audit":"adopted"}. Do not use tools or modify files.',null,
          {sessionId:seed.thread.id,sourceSystem:'codex',intent:'continue',workspacePath:undefined})
        if (!adopted.ok) throw new Error(`Codex audit adoption failed: ${JSON.stringify(adopted.dispatch)}`)
        const forked = await runWorker('Reply with exactly {"audit":"forked"}. Do not use tools or modify files.',adopted.dispatch,
          {sessionAction:'fork',workspacePath:undefined},true)
        if (!forked.ok) throw new Error(`Codex audit fork failed: ${JSON.stringify(forked.dispatch)}`)
        const forkSettings = await service.adapter.request('thread/resume',{threadId:forked.dispatch.threadId,excludeTurns:true})
        await service.adapter.close()
        await service.connectCodex()
        const continued = await runWorker('Reply with exactly {"audit":"reconnected"}. Do not use tools or modify files.',forked.dispatch,{workspacePath:undefined})
        const sourceAfter = await service.adapter.request('thread/read',{threadId:adopted.dispatch.threadId,includeTurns:true})
        const executions = service.database.db.prepare(`SELECT e.execution_id,l.canonical_path FROM executions e JOIN project_locations l ON l.location_id=e.workspace_location_id WHERE e.task_id=? ORDER BY e.attempt_no`).all(forked.dispatch.taskId)
        operationsAudit = { adopted, forked, continued, forkSettings, executions,
          inheritedRoots:JSON.stringify(forkSettings.runtimeWorkspaceRoots)===JSON.stringify([moved,extra]),
          sourceUnchanged:JSON.stringify(adopted.native.thread.turns)===JSON.stringify(sourceAfter.thread.turns),
          forkedFromSource:forked.native.thread.forkedFromId===adopted.dispatch.threadId,
          sameThreadAfterReconnect:continued.dispatch.threadId===forked.dispatch.threadId }
        if (!continued.ok || !operationsAudit.inheritedRoots || !operationsAudit.sourceUnchanged || !operationsAudit.forkedFromSource || !operationsAudit.sameThreadAfterReconnect || executions.some(row=>row.canonical_path!==moved)) throw new Error(`Codex operations audit failed: ${JSON.stringify(operationsAudit)}`)
      }
      return { directoryParity, operationsAudit, ok: tools.length === 2 && tools.every(turn => turn.ok), purpose: options.purpose, backend, elapsedMs: performance.now() - started, turns: tools,
        sourceUnchanged: await readFile(path.join(workspace, 'source.json'), 'utf8') === JSON.stringify(options.input.source, null, 2) + '\n',
        usage: service.executionEvaluation().usage, sameSession: tools.length === 2 && (tools[0].dispatch.childId ?? tools[0].dispatch.threadId) === (tools[1].dispatch.childId ?? tools[1].dispatch.threadId) }
    } catch (error) { return { ok: false, elapsedMs: performance.now() - started, error: { name: error.name, message: error.message }, turns: tools } }
    finally {
      signal.removeEventListener('abort', cancel)
      if (target?.agent.status === 'running') { cancel(); await target.agent.whenIdle() }
      try {
        await service.dispose()
        if (codexStarted) {
          await exec(service.config.codexBinary, ['app-server','daemon','stop'], { env: { ...process.env, CODEX_HOME: service.config.codexHome }, timeout: 30000 })
          try { await cp(path.join(service.config.codexHome, 'sessions'), path.join(root, 'codex-sessions', randomUUID()), { recursive: true }) }
          catch (error) { if (error.code !== 'ENOENT') throw error }
        }
      } finally {
        if (codexAuth) await unlink(codexAuth)
        await fixture.close()
        if (codexRoot) await rm(codexRoot, { recursive: true })
        fixture = null
      }
    }
  }
  const route = ctx.webServer.register({ kind: 'exact', path: '/api/evaluation/infer', handler: async (req, res) => {
    const actual = Buffer.from(String(req.headers.authorization ?? ''))
    if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || actual.length !== token.length || !timingSafeEqual(actual, token)) return reply(res, 403, { error: 'Unauthorized' })
    if (req.method !== 'POST' || lifetime.signal.aborted || pending.size) return reply(res, 409, { error: 'Native measurements must run sequentially' })
    const operation = (async () => {
      try {
        const chunks = []; let bytes = 0
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 1048576) throw new Error('Request too large'); chunks.push(chunk) }
        const options = JSON.parse(Buffer.concat(chunks).toString())
        if (!Number.isInteger(options.budgetMs) || options.budgetMs < 1000 || options.budgetMs > 600000) throw new Error('Invalid request budget')
        reply(res, 200, await runCase(options))
      } catch (error) { reply(res, 500, { ok: false, error: { name: error.name, message: error.message } }) }
    })()
    pending.add(operation)
    try { await operation } finally { pending.delete(operation) }
  } })
  ctx.effect(() => async () => {
    route(); lifetime.abort(); await Promise.allSettled([...pending]); tool(); eventDispose(); await mainProjection.dispose(); await workerProjection.dispose()
  })
  const ready = path.join(root, 'ready.json')
  await writeFile(ready + '.tmp', JSON.stringify({ endpoint: `http://127.0.0.1:${ctx.webServer.port}/api/evaluation/infer`, model: selection }) + '\n', { mode: 0o600, flag: 'wx' })
  await rename(ready + '.tmp', ready)
}
