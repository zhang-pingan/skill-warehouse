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
import { pendingQuestionEndpoint, snapshotWorkspace, compareWorkspaces } from './autonomy-observation.js'

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
  await ctx.workspaceRegistry.initializeDefault(async () => path.join(root, 'workspace'))
  const mainProjection = await ctx.sessionProjections.register(wechatProjection)
  const workerProjection = await ctx.sessionProjections.register(executionProjection)
  let fixture = null
  let receipts = []
  const tool = ctx.tools.register({ ...TOOL, execute: async (args, execution) => {
    if (!fixture) throw new Error('No native measurement is active')
    const service = fixture.service
    const callerWorkspaceRoot = execution.agent && !service.isAssistantSession(execution.agent.session.id) ? await ctx.workingDirectory.ensure(execution.agent, execution.signal) : null
    const started = performance.now()
    const value = await service.operate({ ...args, ...(args.action === 'execute' && !args.requestId ? { requestId: execution.callId } : {}) },
      { actor: 'assistant', callerWorkspaceRoot, codexMutationAuthority: false, featureAuthority: false, approvalAuthority: false, agent: execution.agent, signal: execution.signal })
    receipts.push({ args, result: value, elapsedMs: performance.now() - started, sessionId: execution.agent?.session.id })
    return value
  } })
  const eventDispose = ctx.on('session/event', (session, event) => {
    const service = fixture?.service
    if (!service?.database.db) return
    if (event.type === 'tool/result') service.trackOperation(() => service.results.observeToolResult(session, event), 'worker tool receipt')
    if (event.type === 'turn/end' && service.database.db.prepare('SELECT 1 FROM dsh_execution_runs WHERE session_id=? AND terminal_json IS NULL').get(session.id)) {
      service.results.captureTerminal(session)
      if (service.database.db.prepare('SELECT mode FROM dsh_execution_runs WHERE session_id=? ORDER BY start_seq DESC LIMIT 1').get(session.id)?.mode !== 'subagent') void service.results.kick()
    }
  })
  const subagentDispose = ctx.on('subagent/end', () => { if (fixture?.service.results) void fixture.service.results.kick() })
  const runCase = async options => {
    if (options.purpose !== 'autonomy' || typeof options.input?.query !== 'string') throw new Error('Invalid autonomy measurement')
    const input = options.input
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(options.budgetMs)])
    fixture = await createFixture(input.corpus ?? {datasetId: 'autonomy-empty', families: []}, { analysisInputChars: 100000 })
    const service = fixture.service
    service.context = ctx; service.analysisRuns.context = ctx
    service.results = new ExecutionResults(service, workerProjection)
    service.mainSession = new MainSession(service, mainProjection)
    service.database.clock = Date.now; service.ledger.clock = Date.now
    receipts = []
    let target, codexStarted = false, codexAuth = null, codexRoot = null, seed = null, measurementStarted = null, measurementBoundary = null, measurement = null
    let workspaceInitial = null, workspaceMeasured = null, endpoint = null
    const questionRequests = []
    let questionDispose = () => {}
    const observeQuestionRequest = async (request, next) => {
      if (!target || request.agent?.session.id !== target.sessionId) return next()
      const observation = { sessionId: target.sessionId, callId: request.wait?.callId ?? null, questions: structuredClone(request.questions),
        signal: request.signal, settled: false, observedAt: new Date().toISOString() }
      questionRequests.push(observation)
      try { return await next() } finally { observation.settled = true }
    }
    const started = performance.now()
    const cancel = () => target?.agent.cancel({kind:'user'})
    signal.addEventListener('abort', cancel, {once:true})
    const workspace = path.join(root, 'workspace', randomUUID())
    await mkdir(workspace)
    const sourceText = JSON.stringify(input.source ?? {}, null, 2) + '\n'
    const snapshot = async () => {
      const db = service.database.db
      const executions = db.prepare('SELECT * FROM executions ORDER BY started_at,attempt_no').all()
      const sessions = db.prepare('SELECT * FROM session_refs').all()
      const workers = []
      for (const session of sessions.filter(s => s.session_ref_id && s.external_id !== target.sessionId)) {
        if (!db.prepare('SELECT 1 FROM task_sessions WHERE session_ref_id=?').get(session.session_ref_id)) continue
        try {
          if (session.system === 'codex') workers.push({sourceSystem:'codex',sessionId:session.external_id,native:await service.adapter.request('thread/read',{threadId:session.external_id,includeTurns:true})})
          else workers.push({sourceSystem:'dsh',sessionId:session.external_id,observation:await observe(ctx,session.external_id)})
        } catch (error) { workers.push({sessionId:session.external_id,error:error.message}) }
      }
      const analyses=[]
      for (const id of new Set(db.prepare('SELECT session_id,parent_session_id FROM analysis_runs').all().flatMap(r=>[r.session_id,r.parent_session_id]).filter(Boolean))) {
        try {analyses.push(await observe(ctx,id))} catch(error){analyses.push({sessionId:id,error:error.message})}
      }
      let sourceUnchanged=false, sourceReadError=null
      try {sourceUnchanged=await readFile(path.join(workspace,'source.json'),'utf8')===sourceText}
      catch(error){sourceReadError={code:error.code,message:error.message}}
      let workspaceChanges=null,measuredWorkspaceChanges=null,workspaceReadError=null
      try {
        const current=await snapshotWorkspace(workspace)
        if(workspaceInitial)workspaceChanges=compareWorkspaces(workspaceInitial,current)
        if(workspaceMeasured)measuredWorkspaceChanges=compareWorkspaces(workspaceMeasured,current)
      }catch(error){workspaceReadError={code:error.code??null,message:error.message}}
      return {observation:await observe(ctx,target.sessionId),analyses,measurementBoundary,receipts,seed,executions,sessions,workers,executionSessions:db.prepare('SELECT * FROM execution_sessions').all(),
        tasks:service.ledger.listTasks({limit:200}).data.map(t=>({...service.ledger.getTask(t.taskId),verification:service.ledger.acceptanceStatus(t.taskId)})),
        results:db.prepare('SELECT * FROM execution_results').all(),
        sourceUnchanged,sourceReadError,workspaceChanges,measuredWorkspaceChanges,workspaceReadError,endpoint,
        usage:service.executionEvaluation().usage}
    }
    const settle = async () => {
      for (;;) {
        signal.throwIfAborted()
        const idle=target.agent.whenIdle().then(()=>true)
        for (;;) {
          signal.throwIfAborted()
          if(questionRequests.some(request=>!request.settled&&!request.signal?.aborted)) {
            const observation=await observe(ctx,target.sessionId)
            const seeded=new Set(measurementBoundary.seedExecutionIds)
            const newExecutionCount=service.database.db.prepare('SELECT execution_id FROM executions').all().filter(row=>!seeded.has(row.execution_id)).length
            endpoint=pendingQuestionEndpoint(observation,questionRequests,{mainSeq:measurementBoundary.mainSeq,newExecutionCount})
            if(endpoint)return
          }
          if(await Promise.race([idle,delay(100,undefined,{signal}).then(()=>false)]))break
        }
        signal.throwIfAborted()
        await service.results.kick()
        const active = service.database.db.prepare("SELECT COUNT(*) AS n FROM executions WHERE execution_state IN ('planned','dispatch_pending','running','dispatch_unknown','reconciling')").get().n
        const undelivered = service.database.db.prepare("SELECT COUNT(*) AS n FROM execution_results WHERE delivery_state IN ('pending','delivering')").get().n
        if (!active && !undelivered && target.agent.status !== 'running' && !target.agent.inbox.nextTurn.length && !target.agent.inbox.nextStep.length) {endpoint={kind:'completed'};return}
        await delay(100,undefined,{signal})
      }
    }
    try {
      questionDispose=ctx.on('user-questions/request',observeQuestionRequest,{prepend:true})
      target = await service.mainSession.ensure()
      target.agent.model.select(selection)
      service.config = Object.freeze({...service.config,allowedWorkspaceRoots:[...service.config.allowedWorkspaceRoots,workspace]})
      service.database.config = service.config
      await writeFile(path.join(workspace,'source.json'),sourceText)
      workspaceInitial=await snapshotWorkspace(workspace)
      const backend = input.backend ?? 'dsh'
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
      if (input.seedObjective) {
        const main = service.mainSession
        service.mainSession = null
        try {
          seed = await service.executeObjective({objective:input.seedObjective,requestId:randomUUID(),intent:'new',workspacePath:workspace,
            modelProvider:backend==='codex'?'evaluation':selection.provider,model:selection.model,mutatesWorkspace:false,
            acceptance:['Return exact source aggregation while preserving source.json.']},{agent:target.agent,signal})
          for (;;) {
            signal.throwIfAborted()
            await service.results.kick()
            const row=service.database.db.prepare('SELECT execution_state FROM executions WHERE task_id=? ORDER BY attempt_no DESC LIMIT 1').get(seed.taskId)
            if (!row || ['failed','cancelled','interrupted','waiting_approval','waiting_user'].includes(row.execution_state)) throw new Error('Seed worker failed')
            if(row.execution_state==='succeeded')break
            await delay(100,undefined,{signal})
          }
          service.database.db.prepare("UPDATE execution_results SET delivery_state='delivered',delivered_at=?").run(new Date().toISOString())
        } finally {service.mainSession=main}
        await target.agent.whenIdle()
      }
      if (input.defaultAfterSeed) service.updateRuntimeSettings({defaultWorkerPriority:input.defaultAfterSeed})
      if (input.ambiguousTasks) for (const name of ['project-ruby','project-sapphire']) {
        const dir=path.join(workspace,name);await mkdir(dir,{recursive:true})
        const project=service.ledger.upsertProject({name,canonicalPath:dir})
        service.ledger.createTask({objective:input.ambiguousTasks,projectId:project.projectId,acceptance:['Return verified report']})
      }
      // Fixture-only project directories belong to setup, not worker output.
      if(input.ambiguousTasks)workspaceInitial=await snapshotWorkspace(workspace)
      workspaceMeasured=await snapshotWorkspace(workspace)
      measurementBoundary = {mainSeq:(await observe(ctx,target.sessionId)).events.length,seedExecutionIds:service.database.db.prepare('SELECT execution_id FROM executions').all().map(r=>r.execution_id)}
      if(seed?.childId)measurementBoundary.dshWorkerSeq={sessionId:seed.childId,seq:(await observe(ctx,seed.childId)).events.length}
      if(seed?.threadId)measurementBoundary.codexSeedTurnIds=(await service.adapter.request('thread/read',{threadId:seed.threadId,includeTurns:true})).thread.turns.map(t=>t.id)
      receipts = []
      measurementStarted = performance.now()
      const query=input.query.replaceAll('{workspace}',workspace)
      await ctx.sessionController.prompt({sessionId:target.sessionId,requestId:randomUUID(),mode:'queue',clientTimeZone:'UTC',content:[{type:'text',text:query}]},signal)
      await settle()
      const state=await snapshot()
      if(endpoint?.kind==='waiting_user') {
        const seeded=new Set(measurementBoundary.seedExecutionIds)
        const confirmed=pendingQuestionEndpoint(state.observation,questionRequests,{mainSeq:measurementBoundary.mainSeq,
          newExecutionCount:state.executions.filter(row=>!seeded.has(row.execution_id)).length})
        if(!confirmed)throw new Error('Clarification request stopped waiting before endpoint capture')
        state.endpoint=endpoint=confirmed
      }
      return measurement = {ok:!signal.aborted&&(endpoint?.kind==='waiting_user'||state.observation.endings.at(-1)?.kind==='completed'),purpose:options.purpose,
        elapsedMs:performance.now()-measurementStarted,setupMs:measurementStarted-started,...state}
    } catch(error) {
      cancel()
      await target?.agent.whenIdle()
      let state
      try {state=target?await snapshot():{receipts,seed}} catch(snapshotError){state={receipts,seed,snapshotError:snapshotError.message}}
      return measurement = {ok:false,elapsedMs:performance.now()-(measurementStarted??started),setupMs:measurementStarted?measurementStarted-started:null,
        error:{name:error.name,message:error.message},...state}
    } finally {
      signal.removeEventListener('abort',cancel)
      if(target&&(endpoint?.kind==='waiting_user'||target.agent.status==='running')){cancel();await target.agent.whenIdle()}
      questionDispose()
      const cleanupErrors=[]
      const clean=async(label,operation)=>{try{await operation();return true}catch(error){cleanupErrors.push({step:label,name:error.name,message:error.message});return false}}
      await clean('dispose-service',()=>service.dispose())
      let daemonStopped=!codexStarted,logsCopied=!codexStarted
      if(codexStarted){
        daemonStopped=await clean('stop-codex-daemon',()=>exec(service.config.codexBinary,['app-server','daemon','stop'],{env:{...process.env,CODEX_HOME:service.config.codexHome},timeout:30000}))
        logsCopied=await clean('archive-codex-sessions',async()=>{
          try {await cp(path.join(service.config.codexHome,'sessions'),path.join(root,'codex-sessions',randomUUID()),{recursive:true})}
          catch(error){if(error.code!=='ENOENT')throw error}
        })
      }
      if(codexAuth)await clean('remove-codex-credential',async()=>{try{await unlink(codexAuth)}catch(error){if(error.code!=='ENOENT')throw error}})
      await clean('close-fixture',()=>fixture.close())
      if(codexRoot&&daemonStopped&&logsCopied)await clean('remove-codex-root',()=>rm(codexRoot,{recursive:true}))
      if(measurement){measurement.cleanup={errors:cleanupErrors,daemonStopped,logsCopied,cancelledAfterObservation:endpoint?.kind==='waiting_user',retainedCodexRoot:codexRoot&&(!daemonStopped||!logsCopied)?codexRoot:null};if(cleanupErrors.length)measurement.ok=false}
      fixture=null
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
    route(); lifetime.abort(); await Promise.allSettled([...pending]); tool(); eventDispose(); subagentDispose(); await mainProjection.dispose(); await workerProjection.dispose()
  })
  const ready = path.join(root, 'ready.json')
  await writeFile(ready + '.tmp', JSON.stringify({ endpoint: `http://127.0.0.1:${ctx.webServer.port}/api/evaluation/infer`, model: selection }) + '\n', { mode: 0o600, flag: 'wx' })
  await rename(ready + '.tmp', ready)
}
