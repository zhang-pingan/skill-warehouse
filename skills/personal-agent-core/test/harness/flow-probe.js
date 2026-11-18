/** Real native Session continuation with isolated storage and a keyless model. */
import assert from 'node:assert/strict'
import path from 'node:path'
import {mkdtemp,mkdir,readFile,realpath} from 'node:fs/promises'
import { PersonalAgentService } from '../../lib/service.js'
import { resolveConfig } from '../../lib/config.js'
import { ExecutionResults } from '../../lib/execution-results.js'
import { executionProjection } from '../../lib/execution-projection.js'

export async function runFlowProbe(ctx,root) {
  const service=new PersonalAgentService(resolveConfig({dataDir:path.join(root,`flow-${crypto.randomUUID()}`),codexHome:path.join(root,'codex'),historyRead:false,semanticRoutingEnabled:false,memoryExtractionEnabled:false,cleanupEnabled:false}),{context:ctx})
  const projection=await ctx.sessionProjections.register(executionProjection)
  let disposeEvents=()=>{}
  let disposeTerminal=()=>{}
  try {
    await service.initialize()
    const directoryRoot=await realpath(await mkdtemp(path.join(root,'flow-directories-')))
    const directoryB=path.join(directoryRoot,'B'),directoryC=path.join(directoryRoot,'C'),directoryD=path.join(directoryRoot,'D')
    await Promise.all([directoryB,directoryC,directoryD].map(directory=>mkdir(directory)))
    const executionDirectory=executionId=>service.database.db.prepare(`SELECT l.canonical_path FROM executions e
      JOIN project_locations l ON l.location_id=e.workspace_location_id WHERE execution_id=?`).get(executionId)?.canonical_path
    service.results=new ExecutionResults(service,projection)
    const endings=new Map(),childEndings=new Map()
    disposeEvents=ctx.on('session/event',(session,event)=>{
      if(event.type!=='turn/end')return
      service.results.captureTerminal(session)
      endings.get(session.id)?.resolve()
    })
    const selection={provider:'personal-agent-smoke',model:'fixture',reasoningEffort:'off'}
    const created=await ctx.sessionController.create({cwd:root,agentPreset:'standard'})
    const main=(await ctx.sessionController.resolveAgent(created.sessionId)).agent
    main.model.select(selection)
    service.database.db.prepare("INSERT INTO main_session_binding VALUES(1,?,1,'ready',?)").run(created.sessionId,new Date().toISOString())
    const first=await service.executeObjective({objective:'Create a native worker fixture',workspacePath:directoryB,requestId:'spawn',intent:'new',mutatesWorkspace:false,modelProvider:selection.provider,model:selection.model,effort:'off'},{agent:main})
    assert.equal(first.stopReason,'completed')
    assert.equal(ctx.agents.get(first.childId),undefined)
    const terminal=Promise.withResolvers();disposeTerminal=ctx.on('subagent/end',info=>{if(info.id===first.childId)terminal.resolve();childEndings.get(info.id)?.resolve()})
    const second=await service.executeObjective({taskId:first.taskId,objective:'Continue the same work',requestId:'continue',intent:'continue',mutatesWorkspace:false,worker:'dsh_subagent',agentPreset:'cordis'},{agent:main})
    assert.equal(second.childId,first.childId)
    assert.equal(second.accepted,true)
    await terminal.promise
    await service.results.kick()
    const result=service.database.db.prepare('SELECT result_json FROM execution_results WHERE execution_id=?').get(second.executionId)
    assert.ok(result,JSON.stringify({run:service.database.db.prepare('SELECT * FROM dsh_execution_runs WHERE execution_id=?').get(second.executionId),state:await service.results.state(first.childId),attention:service.database.db.prepare('SELECT * FROM attention_items').all()}))
    assert.match(JSON.parse(result.result_json).output,/Recorded fixture result/)
    const observed=await ctx.sessionQuery.observeSession(first.childId)
    try {
      assert.equal(observed.projections.values.agentPreset,'standard')
      assert.equal(observed.projections.values.workingDirectory,directoryB)
      assert.equal(observed.header.cwd,main.session.header.cwd)
      assert.notEqual(observed.header.cwd,directoryB)
    }finally{observed[Symbol.dispose]()}
    assert.equal(executionDirectory(first.executionId),directoryB)
    assert.equal(executionDirectory(second.executionId),directoryB)
    const ordinary=await ctx.sessionController.create({cwd:root,agentPreset:'ptc'})
    const ordinaryAgent=(await ctx.sessionController.resolveAgent(ordinary.sessionId)).agent
    ordinaryAgent.model.select(selection)
    await ctx.workingDirectory.set(ordinaryAgent,directoryC)
    await ctx.workingDirectory.set(ordinaryAgent,directoryD)
    // Native directory notices are consumed by an ordinary turn before admission checks.
    ordinaryAgent.followup(Object.freeze({id:crypto.randomUUID(),role:'user',source:{kind:'user'},content:[{type:'text',text:'Observe the current directory.'}]}))
    await ordinaryAgent.whenIdle()
    const ordinaryEnd=Promise.withResolvers();endings.set(ordinary.sessionId,ordinaryEnd)
    const third=await service.executeObjective({sessionId:ordinary.sessionId,sourceSystem:'dsh',objective:'Continue external ordinary session',requestId:'ordinary',intent:'continue',mutatesWorkspace:false},{agent:main})
    assert.equal(third.childId,ordinary.sessionId)
    await ordinaryEnd.promise
    await service.results.kick()
    assert.equal(service.database.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(third.executionId).execution_state,'succeeded')
    assert.equal(ctx.agentPresets.presetForSession(ordinaryAgent.session),'ptc')
    assert.equal(ctx.workingDirectory.get(ordinaryAgent.session),directoryD)
    assert.equal(executionDirectory(third.executionId),directoryD)
    const foreign=await ctx.sessionController.create({cwd:root,agentPreset:'standard'})
    const foreignMain=(await ctx.sessionController.resolveAgent(foreign.sessionId)).agent
    const blocked=await service.executeObjective({taskId:first.taskId,objective:'Continue from another tree',requestId:'foreign',mutatesWorkspace:false},{agent:foreignMain})
    assert.equal(blocked.code,'DSH_SUBAGENT_OTHER_TREE')
    const repeated=await service.executeObjective({sessionId:ordinary.sessionId,sourceSystem:'dsh',objective:'Continue external ordinary session',requestId:'ordinary',intent:'continue',mutatesWorkspace:false},{agent:main})
    assert.equal(repeated.repeated,true)
    assert.equal(repeated.executionId,third.executionId)
    const extra=await service.executeObjective({objective:'Separate notification fixture',requestId:'extra-spawn',intent:'new',mutatesWorkspace:false,modelProvider:selection.provider,model:selection.model,effort:'off'},{agent:main})
    const extraEnd=Promise.withResolvers();childEndings.set(extra.childId,extraEnd)
    const extraRun=await service.executeObjective({taskId:extra.taskId,objective:'Continue second child',requestId:'extra-continue',mutatesWorkspace:false},{agent:main})
    await extraEnd.promise
    await service.results.kick()
    await main.whenIdle()
    const receipts=projection.stateOf(main.session).settlements
    assert.ok(receipts[first.childId]>=0 && receipts[extra.childId]>=0)
    assert.equal(service.database.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(extraRun.executionId).execution_state,'succeeded')
    const noticeAgent=main
    service.mainSession={binding:()=>({session_id:created.sessionId}),ensure:async()=>({agent:noticeAgent,sessionId:created.sessionId,version:1})}
    const noticeEnd=Promise.withResolvers();endings.set(created.sessionId,noticeEnd)
    await service.results.kick()
    await noticeEnd.promise
    await noticeAgent.whenIdle()
    await service.results.kick()
    await noticeAgent.whenIdle()
    assert.equal(service.database.db.prepare("SELECT COUNT(*) AS n FROM execution_results WHERE delivery_state='pending'").get().n,0)
    const count=noticeAgent.session.deriveMessages().filter(message=>message.source?.rpcId?.startsWith('worker-result')).length
    assert.equal(count,3)
    await service.results.kick()
    assert.equal(noticeAgent.session.deriveMessages().filter(message=>message.source?.rpcId?.startsWith('worker-result')).length,count)
    assert.equal(service.ledger.getTask(first.taskId).state,'active')
    const internal=await service.executeObjective({taskId:first.taskId,worker:'internal',objective:'Verify the existing worker result in main',requestId:'internal-after-worker',mutatesWorkspace:false},{agent:main})
    assert.equal(internal.worker,'internal')
    assert.equal(internal.taskId,first.taskId)
    main.followup(Object.freeze({id:crypto.randomUUID(),role:'user',source:{kind:'user'},content:[{type:'text',text:'Produce the verification fixture output.'}]}))
    await main.whenIdle()
    const finished=await service.finishInternalExecution({executionId:internal.executionId,output:'Verified in the original main session'},{agent:main})
    assert.equal(finished.executionState,'succeeded')
    assert.equal(service.buildCandidates({taskId:first.taskId})[0].sessionId,first.childId)
    assert.equal(service.database.db.prepare('SELECT COUNT(*) AS n FROM dsh_execution_runs').get().n,5)
    const switchedEnd=Promise.withResolvers();childEndings.set(first.childId,switchedEnd)
    const switched=await service.executeObjective({taskId:first.taskId,objective:'Continue in directory C',workspacePath:directoryC,mutatesWorkspace:true,requestId:'directory-switch'},{agent:main})
    assert.equal(switched.childId,first.childId)
    assert.equal(switched.accepted,true,JSON.stringify(switched))
    await switchedEnd.promise
    await service.results.kick()
    await main.whenIdle()
    const restored=await ctx.sessionQuery.observeSession(first.childId)
    try {
      assert.equal(restored.projections.values.workingDirectory,directoryC)
      assert.equal(restored.header.cwd,main.session.header.cwd)
    }finally{restored[Symbol.dispose]()}
    const retainedEnd=Promise.withResolvers();childEndings.set(first.childId,retainedEnd)
    const retained=await service.executeObjective({taskId:first.taskId,objective:'Keep the current directory',mutatesWorkspace:false,requestId:'directory-retain'},{agent:main})
    assert.equal(retained.childId,first.childId)
    assert.equal(retained.accepted,true,JSON.stringify(retained))
    await retainedEnd.promise
    await service.results.kick()
    assert.equal(executionDirectory(switched.executionId),directoryC)
    assert.equal(executionDirectory(retained.executionId),directoryC)
    assert.equal(executionDirectory(first.executionId),directoryB)
    assert.equal(service.ledger.getTask(first.taskId).projectId,service.database.db.prepare('SELECT project_id FROM project_locations WHERE canonical_path=?').get(directoryB).project_id)
    const protection=service.database.db.prepare(`SELECT l.canonical_path,k.resource_key,e.workspace_baseline_id FROM executions e
      JOIN project_locations l ON l.location_id=e.workspace_location_id JOIN leases k USING(execution_id) WHERE execution_id=?`).get(switched.executionId)
    assert.equal(protection.canonical_path,directoryC)
    assert.equal(protection.resource_key,`workspace:${directoryC}`)
    assert.ok(protection.workspace_baseline_id)
    assert.equal(service.buildCandidates({taskId:first.taskId})[0].cwd,directoryC)
    const snapshot={internalWorkPreservesExecutor:true,releasedChildContinued:true,ordinarySessionContinued:true,originalPresetPreserved:true,foreignTreeBlocked:true,duplicateRequestSuppressed:true,resultsDeliveredOnce:true,multipleChildReceiptsPreserved:true,acceptancePending:true,inheritedHeaderIgnored:true,coldDirectoryRetained:true,coldDirectorySwitched:true,multipleDirectoryChangesObserved:true,executionDirectoriesPreserved:true,switchedWorkspaceProtected:true}
    assert.deepEqual(snapshot,JSON.parse(await readFile(new URL('./flow-expected.json',import.meta.url),'utf8')))
    return snapshot
  } finally {disposeEvents();disposeTerminal();await service.dispose();await projection.dispose()}
}
