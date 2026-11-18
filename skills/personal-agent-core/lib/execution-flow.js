/** Shared discovery and native preflight for execution and read-only route previews. */
import { nowIso } from './ids.js'
import path from 'node:path'
import { resolveWorkerPolicy } from './worker-policy.js'
import { discoverExecutionTargets } from './execution-discovery.js'

const activeStates = ['planned','dispatch_pending','dispatch_unknown','reconciling','running','waiting_approval','waiting_user']
const blocked = (code, reason, target, extra = {}) => ({ blocked:true, code, reason, target, ...extra })

/** Resolve original work before reading the new-worker preference. No task or execution is allocated here. */
export async function resolveExecutionIntent(service, args, { agent, signal, preview = false } = {}) {
  if (args.worker === 'codex' && args.agentPreset !== undefined) throw new Error('agentPreset is only valid for a DSH worker')
  if (args.forceNew) throw Object.assign(new Error('forceNew 已移除，请分别使用 newTask 与 sessionAction 描述新任务和新会话。'), {code:'EXECUTION_INTENT_INVALID'})
  if (args.sessionAction && !['continue','new','fork'].includes(args.sessionAction)) throw new TypeError('Invalid sessionAction')
  const discovery = await service.semanticCandidates({ ...args, signal })
  if (args.sessionId && args.sourceSystem && !args.taskId && !args.sessionTaskId && !args.projectId && !discovery.candidates.length) discovery.candidates.push({
    candidateId:`native:${args.sourceSystem}:${args.sessionId}`,sessionId:args.sessionId,sourceSystem:args.sourceSystem,
    objective:args.objective,state:'open',score:1,objectiveCompatible:true,sourceKind:args.sourceSystem==='codex'?'app_server_thread':null,
  })
  const explicit = !!(args.taskId || args.sessionTaskId || args.sessionId)
  const qualified = discovery.candidates.filter(item=> explicit || item.objectiveCompatible && item.score >= service.config.routeResumeThreshold)
  if (qualified.length > 1 && (explicit || qualified[0].score-qualified[1].score < service.config.routeAmbiguityGap)) {
    return { clarificationRequired:true,code:'EXECUTION_TARGET_AMBIGUOUS',candidates:qualified.slice(0,3),coverage:discovery.coverage,reason:'多个工作目标符合请求，请指定 taskId 或 sessionTaskId。' }
  }
  let target = qualified[0] ?? null
  if (!target && (explicit || args.intent === 'continue' || args.sessionAction === 'continue')) {
    return blocked('EXECUTION_TARGET_NOT_FOUND','尚未定位到要继续的工作，请按来源会话或原文补查；不会另开 worker。',null,{coverage:discovery.coverage})
  }
  if (discovery.coverage.truncated && !args.taskId && !args.sessionTaskId && (target || args.intent !== 'new')) return blocked('EXECUTION_DISCOVERY_INCOMPLETE','候选结果尚未查全，请分页补查并指定 taskId 或 sessionTaskId 后执行。',null,{coverage:discovery.coverage})
  if (!target && args.intent !== 'new' && (discovery.coverage.truncated || discovery.coverage.sessionsPending || discovery.coverage.supplementary.length || discovery.coverage.errors.length)) {
    return blocked('EXECUTION_DISCOVERY_INCOMPLETE','历史检索尚未完整，请补查来源，或明确这是新的工作目标。',null,{coverage:discovery.coverage})
  }
  if (target?.state === 'cancelled' || target?.state === 'merged') return blocked('EXECUTION_TASK_CLOSED','该任务已取消或合并，请选择有效任务。',target)
  if (args.worker==='internal') {
    const admission=inspectTaskAdmission(service,target,args)
    if (admission) return {...admission,coverage:discovery.coverage}
    if (args.sessionAction && args.sessionAction!=='continue' || args.forceFork) throw Object.assign(new Error('主会话直接执行不能同时新建或分叉 worker 会话。'),{code:'EXECUTION_INTENT_INVALID'})
    return {target,coverage:discovery.coverage,continuing:false,preview,policy:{worker:'internal'}}
  }
  if (target?.sessionId && target.sessionId === agent?.session.id && args.worker !== 'internal') return blocked('EXECUTION_SELF_TARGET','目标是当前会话，请直接处理或使用 internal 执行记录。',target)
  const admission=inspectTaskAdmission(service,target,args)
  if (admission) return {...admission,coverage:discovery.coverage}
  const replaces = target?.sessionId && (args.sessionAction === 'new' || args.sessionAction === 'fork' || args.forceFork)
  if (replaces && agent) {
    try { if (!args.sessionChangeQuote?.trim()) throw new Error('Missing quote'); service.currentUserMessage(agent,args.sessionChangeQuote) }
    catch (error) { return blocked('EXECUTION_SESSION_CHANGE_UNCONFIRMED','更换已有执行会话需要引用当前用户明确的新会话或分叉要求。',target) }
  }
  if (replaces && (args.sessionAction==='fork' || args.forceFork) && target.sourceSystem==='dsh') return blocked('DSH_EXPLICIT_FORK_UNAVAILABLE','当前执行入口不支持从指定 DSH 来源分叉；可以继续原会话，或明确要求新会话。',target)
  if (replaces && (args.sessionAction==='fork' || args.forceFork)) {
    const inspected=await inspectNativeTarget(service,target,{agent,signal,kind:args.kind,fork:true})
    if (inspected.blocked) return inspected
    return {target:{...target,...inspected},coverage:discovery.coverage,continuing:false,replaces:true,fork:true}
  }
  if (!target?.sessionId || replaces) {
    const policy = args.worker==='internal' ? {worker:'internal'} : resolveWorkerPolicy(service.config,args,{
      dsh_subagent:service.config.dshWorkerEnabled && !!(service.context?.get?.('subagents')??service.context?.subagents)?.startActivation,
      codex:service.config.codexWorkerEnabled && service.flags.enabled('codex.daemon.connect') && service.flags.enabled('codex.new_thread.execute'),
    })
    return {target,coverage:discovery.coverage,continuing:false,replaces:!!replaces,preview,policy}
  }
  const native = await inspectNativeTarget(service,target,{agent,signal,kind:args.kind})
  if (native.blocked) return {...native,coverage:discovery.coverage}
  return { target:{...target,...native},coverage:discovery.coverage,continuing:true,preview }
}

/** Reserve task admission even before its first native session exists; unresolved dispatch never permits replacement. */
export function inspectTaskAdmission(service,target,args,{reservation=null}={}) {
  if (!target?.taskId) return null
  const owner=service.nativeDispatches.get(`task:${target.taskId}`)
  if (owner && owner!==reservation) return blocked('EXECUTION_SESSION_BUSY','该任务正在接收另一项执行请求，请等待后重试。',target,{waiting:true})
  const task=service.ledger.getTask(target.taskId)
  if (!task || ['cancelled','merged'].includes(task.state)) return blocked('EXECUTION_TASK_CLOSED','该任务已取消、合并或移除，请重新查询。',target)
  if (!args.sessionId && !args.sessionTaskId) {
    const current=discoverExecutionTargets(service,{taskId:target.taskId}).candidates[0]
    if (current?.sessionId!==target.sessionId || current?.sourceSystem!==target.sourceSystem || task.state!==target.state) return blocked('EXECUTION_TARGET_CHANGED','任务的执行目标或状态已变化，请重新查询后继续。',target)
  }
  const active=service.database.db.prepare(`SELECT e.*,o.method FROM executions e LEFT JOIN outbox o USING(execution_id)
    WHERE e.task_id=? AND e.execution_state IN (${activeStates.map(()=>'?').join(',')})`).all(target.taskId,...activeStates)
  const correction=args.kind==='correction' && args.sessionAction!=='new' && args.sessionAction!=='fork' && !args.forceFork
  if (active.some(run=>!(correction && target.sourceSystem==='codex' && run.executor_kind==='codex' && run.method==='turn/start'
    && ['running','waiting_approval','waiting_user'].includes(run.execution_state)))) {
    return blocked('EXECUTION_SESSION_BUSY','该任务仍有执行中或结果未确认的请求，核对原执行前不会创建另一个 worker。',target,{waiting:true,executions:active.map(run=>({executionId:run.execution_id,state:run.execution_state}))})
  }
  return null
}

/** Verify native identity and ownership; imported source classifications never grant mutation authority. */
export async function inspectNativeTarget(service,target,{agent,signal,kind,fork=false,reservation=null}={}) {
  const db = service.database.db
  const running = db.prepare(`SELECT e.execution_id,e.execution_state FROM executions e JOIN execution_sessions x USING(execution_id)
    WHERE x.session_ref_id=? AND x.role='executor' AND e.execution_state IN (${activeStates.map(()=>'?').join(',')}) LIMIT 1`).get(target.sessionRefId??null,...activeStates)
  if ((service.nativeDispatches?.has(`${target.sourceSystem}:${target.sessionId}`) && service.nativeDispatches.get(`${target.sourceSystem}:${target.sessionId}`)!==reservation)) return blocked('EXECUTION_SESSION_BUSY','原会话正在接收另一项执行请求，请等待后重试。',target,{waiting:true})
  if (running && !(target.sourceSystem==='codex' && kind==='correction' && !fork)) return blocked('EXECUTION_SESSION_BUSY','原会话仍在执行或等待对账，已保留续接目标。',target,{waiting:true,execution:running})
  if (target.sourceSystem === 'codex') {
    if (!service.config.codexWorkerEnabled || !service.flags.enabled('codex.daemon.connect') || !service.flags.enabled(fork?'routing.fork':'routing.resume')) return blocked('CODEX_RESUME_DISABLED','原任务在 Codex 中，请开启 Codex 连接及续接功能后重试。',target)
    if (!service.adapter.initialized) await service.connectCodex()
    let read
    try { read=await service.adapter.request('thread/read',{threadId:target.sessionId,includeTurns:true}) }
    catch(error) { return blocked('CODEX_THREAD_UNAVAILABLE','无法读取原 Codex 会话，请检查连接和会话是否仍可访问。',target,{detail:String(error.message)}) }
    const thread=read?.thread
    if (!thread || thread.id !== target.sessionId) return blocked('CODEX_THREAD_IDENTITY','Codex 返回了不同的会话身份，已停止执行。',target)
    if (thread.ephemeral) return blocked('CODEX_THREAD_EPHEMERAL','临时 Codex 会话没有可持久续接的历史，请使用普通会话。',target)
    if (thread.canAcceptDirectInput === false || thread.status?.type === 'systemError') return blocked('CODEX_THREAD_NOT_WRITABLE','原 Codex 会话当前不能接收输入，请先在 Codex 中处理其状态。',target)
    if (thread.archived) return blocked('EXECUTION_SESSION_ARCHIVED','原会话已归档，请恢复后重试。',target)
    const active=(thread.turns??[]).find(turn=>turn.status==='inProgress')
    if (active || ['active','running'].includes(thread.status?.type ?? thread.status)) {
      const same=service.threadEpochs.get(thread.id)===service.adapter.connectionEpoch
      const authorized=active && same && service.activeTurnWorkspaceAuthority({taskId:target.taskId,threadId:thread.id,turnId:active.id,workspacePath:target.cwd??thread.cwd})
      if (kind==='correction' && !fork && service.flags.enabled('control.steer') && authorized) return {cwd:target.cwd??thread.cwd,runtime:{loaded:true,turnState:'active',sameAdapterConnection:true,activeTurnId:active.id,activeExecutionAuthorized:true}}
      return blocked('EXECUTION_SESSION_BUSY','原 Codex 会话正在执行，等待完成后续接。',target,{waiting:true})
    }
    const cwd=thread.cwd ?? target.cwd
    return {cwd,threadId:thread.id,runtime:{loaded:service.threadEpochs.get(thread.id)===service.adapter.connectionEpoch && thread.status?.type!=='notLoaded',settingsRefreshRequired:true,turnState:'idle',sameAdapterConnection:service.threadEpochs.get(thread.id)===service.adapter.connectionEpoch},lastCompletedTurnId:(thread.turns??[]).filter(turn=>turn.status==='completed').at(-1)?.id ?? null}
  }
  if (target.sourceSystem !== 'dsh') return blocked('EXECUTION_SOURCE_UNSUPPORTED','该历史来源没有可用的执行入口。',target)
  const ctx=service.context
  if (!service.config.dshWorkerEnabled || !ctx?.sessionPersistence) return blocked('DSH_RESUME_UNAVAILABLE','DSH 会话恢复能力尚未就绪。',target)
  if (ctx.workspaceRegistry?.archivedSessionIds.includes(target.sessionId)) return blocked('EXECUTION_SESSION_ARCHIVED','原 DSH 会话已归档，请恢复后重试。',target)
  const stored=await ctx.sessionPersistence.stat(target.sessionId)
  if (!stored) return blocked('EXECUTION_SESSION_MISSING','原 DSH 会话数据缺失，请恢复来源数据。',target)
  const live=ctx.agents?.get(target.sessionId)
  if (live?.status==='running' || live?.inbox?.nextTurn?.length || live?.inbox?.nextStep?.length) return blocked('EXECUTION_SESSION_BUSY','原 DSH 会话仍有运行中或排队的输入。',target,{waiting:true})
  const handle=await ctx.sessionPersistence.open(target.sessionId,'read')
  let header
  try { header=handle.header } finally { await handle.close() }
  let agentPreset = live ? ctx.agentPresets.presetForSession(live.session) : header.agentPreset
  let startSeq = stored.eventCount ?? live?.session.seq ?? 0
  let cwd = live ? ctx.workingDirectory.get(live.session) : null
  if (!live) {
    if (!ctx.sessionQuery) return blocked('DSH_RESUME_UNAVAILABLE','当前环境没有会话状态读取能力，无法确认原会话目录。',target)
    const observed=await ctx.sessionQuery.observeSession(target.sessionId,{signal})
    try {
      const inbox=observed.projections.values.inbox
      if (inbox['next-turn'].length || inbox['next-step'].length) return blocked('EXECUTION_SESSION_BUSY','原 DSH 会话仍有未处理的输入，请先恢复原会话。',target,{waiting:true})
      agentPreset=observed.projections.values.agentPreset;startSeq=observed.cursor+1
      cwd=observed.projections.values.workingDirectory ?? ctx.workingDirectory.defaultDirectory
    } finally { observed[Symbol.dispose]() }
  }
  if (header.origin==='subagent' || header.parentSessionId) {
    if (!agent || !ctx.subagents?.listDescendants || !ctx.subagents?.sendMessage) return blocked('DSH_SUBAGENT_OWNER_UNAVAILABLE','无法验证原子会话的代理树归属。',target)
    const descendants=await ctx.subagents.listDescendants(agent.session.id,signal)
    const member=descendants.find(item=>item.id===target.sessionId && item.kind==='child')
    if (!member || member.mode!=='continuable') return blocked('DSH_SUBAGENT_OTHER_TREE','原子会话不属于当前主会话的可续接代理树，请在原主会话中继续。',target)
    return {cwd,agentPreset,continuationMode:'subagent',startSeq}
  }
  if (!ctx.sessionController?.resolveAgent || !ctx.sessionController?.prompt) return blocked('DSH_RESUME_UNAVAILABLE','当前环境没有普通 DSH 会话续接入口。',target)
  return {cwd,agentPreset,continuationMode:'session',startSeq}
}

/** Adopt the selected historical work only for a current execution request, preserving the original source. */
export async function associateExecutionTask(service,args,resolution,{callerWorkspaceRoot=null}={}) {
  let target=resolution.target
  if (!target) return args
  if (target.sessionId && (!target.sessionRefId || target.sourceSystem==='codex')) {
    const source=service.ledger.upsertSession({system:target.sourceSystem,externalId:target.sessionId,cwd:target.cwd,sourceKind:target.sourceSystem==='codex'?'app_server_thread':target.sourceKind??'session',durability:'durable'})
    target={...target,sessionRefId:source.sessionRefId,sourceKey:target.sourceKey??`session:${source.sessionRefId}`}
    resolution.target=target
  }
  let task=target.taskId ? service.ledger.getTask(target.taskId) : null
  const sourceKey=target.sourceKey
  if (sourceKey) {
    const linked=service.database.db.prepare('SELECT task_id FROM task_sources WHERE source_key=?').get(sourceKey)
    if (linked) task=service.ledger.getTask(linked.task_id)
  }
  const taskCreated=!task || task.state==='completed' || args.newTask===true
  const independentTask=taskCreated && !resolution.continuing && !resolution.fork
  if (independentTask && args.workspacePath) {
    const workspacePath=await service.canonicalWorkspacePath(args.workspacePath,{requireAllowed:args.worker==='codex'})
    if (callerWorkspaceRoot) {
      const root=await service.canonicalWorkspacePath(callerWorkspaceRoot)
      const relative=path.relative(root,workspacePath)
      if (relative==='..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('workspacePath is outside the caller workspace')
    }
    args={...args,workspacePath}
  }
  return service.database.transaction(()=>{
    let projectId=target.projectId ?? null
    if (independentTask) {
      projectId=args.projectId ?? null
      if (args.workspacePath) {
        const workspace=service.ledger.upsertProject({name:args.projectName,canonicalPath:args.workspacePath})
        if (projectId && projectId!==workspace.projectId) throw new Error('projectId does not match workspacePath')
        projectId=workspace.projectId
      }
    }
    if (taskCreated) task=service.ledger.createTask({objective:args.objective,
      parentTaskId:task?.taskId ?? null,projectId,state:'open',acceptance:args.acceptance ?? ['Verify the result against the objective and record evidence'],
      sourceKey:`native-request:${args._triggerId}`})
    if (target.sessionRefId) service.ledger.attachTaskSession(task.taskId,target.sessionRefId,{relation:resolution.replaces && taskCreated?'fork_source':'executor',confidence:1})
    if (sourceKey) service.database.db.prepare(`INSERT INTO task_sources VALUES(?,?,?,?,?,?,?) ON CONFLICT(source_key) DO UPDATE SET
      task_id=excluded.task_id,context_version=excluded.context_version,messages_json=excluded.messages_json,updated_at=excluded.updated_at`)
      .run(sourceKey,task.taskId,target.sessionRefId,target.sessionTaskId??null,target.contextVersion??null,JSON.stringify(target.messages??[]),nowIso())
    return {...args,taskCreated,taskId:task.taskId,projectId:task.projectId,association:target,continuation:resolution.continuing?target:null,
      continuationContext:{objective:target.objective,sessionTaskId:target.sessionTaskId??null,summary:target.summary??null,messages:target.messages??[]}}
  })
}
