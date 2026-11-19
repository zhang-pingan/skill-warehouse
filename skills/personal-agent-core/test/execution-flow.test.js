import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtempSync,mkdirSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {resolveConfig} from '../lib/config.js'
import {PersonalAgentService} from '../lib/service.js'
import {resolveWorkerPolicy,migrateWorkerSettings} from '../lib/worker-policy.js'
import {executionProjection} from '../lib/execution-projection.js'
import {ExecutionResults} from '../lib/execution-results.js'
import {inspectNativeTarget} from '../lib/execution-flow.js'

async function fixture(t,options={}) {
  const root=mkdtempSync(path.join(os.tmpdir(),'pac-flow-'))
  const service=new PersonalAgentService(resolveConfig({dataDir:path.join(root,'data'),codexHome:path.join(root,'codex'),allowedWorkspaceRoots:[root],codexWorkerEnabled:true,semanticRoutingEnabled:false,...options}))
  await service.initialize()
  t.after(async()=>{await service.dispose();rmSync(root,{recursive:true,force:true})})
  return {service,root}
}
async function history(service,system,id,root,goal) {
  const ref=service.ledger.upsertSession({system,externalId:id,cwd:root,sourceKind:'session',durability:'unknown'})
  const h=service.ledger.history
  h.stage({sessionRefId:ref.sessionRefId,sourceSystem:system,sourceKind:'message',sourceUri:`${system}://${id}`,sourceLocator:'message:1',sourceIdentity:'first',text:goal,authorRole:'user',occurredAt:new Date().toISOString()})
  h.complete(ref.sessionRefId)
  service.analysisRuns.run=async(options,commit)=>commit(options.input.messages?{tasks:[{id:'new:one',title:goal,goal,summary:'Original work',state:'open'}],assignments:options.input.messages.map(message=>({messageId:message.messageId,taskIds:['new:one'],status:'assigned'}))}:{merges:[]})
  await h.segmentNext()
  return service.database.db.prepare('SELECT * FROM session_tasks WHERE session_ref_id=?').get(ref.sessionRefId)
}
function adapter(service,root,{busy=false}={}) {
  const calls=[]
  service.flags.set('codex.daemon.connect',true)
  service.flags.set('routing.resume',true)
  const native={initialized:true,connectionEpoch:1,adapterInstanceId:'fixture',close:async()=>{},request:async(method,params)=>{
    calls.push({method,params})
    if(method==='thread/read')return {thread:{id:params.threadId,cwd:root,turns:busy?[{id:'external',status:'inProgress'}]:[]}}
    if(method==='thread/resume')return {cwd:root,runtimeWorkspaceRoots:[root],thread:{id:params.threadId,cwd:root,status:{type:'idle'}}}
    if(method==='turn/start')return {thread:{id:params.threadId},turn:{id:'new-turn',status:'inProgress'}}
    throw new Error(`Unexpected ${method}`)
  }}
  service.adapter=native;service.dispatcher.adapter=native;service.approvals.adapter=native
  return calls
}

test('historical Codex work wins over a DSH plugin override without an existing Task',async t=>{
  const {service,root}=await fixture(t)
  const old=await history(service,'codex','old-thread',root,'Maintain the DSH plugin')
  const calls=adapter(service,root)
  const result=await service.executeObjective({sessionTaskId:old.session_task_id,objective:'Add plugin validation',worker:'dsh_subagent',agentPreset:'cordis',requestId:'adopt'},{codexMutationAuthority:true})
  assert.equal(result.threadId,'old-thread',JSON.stringify(result))
  JSON.stringify(result,(key,value)=>{assert.notEqual(value,undefined,`Tool result field ${key} must survive JSON serialization`);return value})
  assert.deepEqual(calls.map(x=>x.method),['thread/read','thread/read','thread/resume','turn/start'])
  assert.equal(service.database.db.prepare('SELECT COUNT(*) AS n FROM task_sources').get().n,1)
  assert.equal(service.buildCandidates({sessionTaskId:old.session_task_id,objective:'Add plugin validation'}).length,1)
  assert.equal(calls.at(-1).params.model,undefined)
  assert.equal(calls.at(-1).params.runtimeWorkspaceRoots,undefined)
  assert.equal(calls.find(x=>x.method==='thread/resume').params.cwd,undefined)
  assert.equal(service.database.db.prepare("SELECT source_kind FROM session_refs WHERE external_id='old-thread'").get().source_kind,'app_server_thread')
  assert.match(JSON.stringify(calls.at(-1).params),/Original work/)
})

test('an explicit native thread can be adopted before history import',async t=>{
  const {service,root}=await fixture(t);const calls=adapter(service,root)
  const result=await service.executeObjective({sessionId:'native-only',sourceSystem:'codex',objective:'Continue existing work',intent:'continue',requestId:'native'},{codexMutationAuthority:true})
  assert.equal(result.threadId,'native-only',JSON.stringify(result))
  assert.equal(calls.some(x=>x.method==='thread/start'),false)
  assert.equal(service.database.db.prepare('SELECT COUNT(*) AS n FROM task_sources').get().n,1)
})

test('busy historical work waits without creating a task or alternate worker',async t=>{
  const {service,root}=await fixture(t);const old=await history(service,'codex','busy',root,'A task')
  const calls=adapter(service,root,{busy:true})
  const result=await service.executeObjective({sessionTaskId:old.session_task_id,objective:'Continue',requestId:'busy'},{codexMutationAuthority:true})
  assert.equal(result.code,'EXECUTION_SESSION_BUSY');assert.equal(result.waiting,true)
  assert.equal(service.database.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,0)
  assert.deepEqual(calls.map(x=>x.method),['thread/read'])
  assert.ok(result.routeDecisionId)
})

test('a completed management task gets a follow-up task on the original thread',async t=>{
  const {service,root}=await fixture(t);const old=await history(service,'codex','completed-thread',root,'Original task')
  const task=service.ledger.createTask({objective:'Original task',acceptance:['Verify'],state:'completed'})
  service.database.db.prepare('INSERT INTO task_sources VALUES(?,?,?,?,?,?,?)').run(`history:${old.session_task_id}`,task.taskId,old.session_ref_id,old.session_task_id,old.context_version,'[]',new Date().toISOString())
  adapter(service,root)
  const result=await service.executeObjective({sessionTaskId:old.session_task_id,objective:'Follow-up correction',requestId:'follow'},{codexMutationAuthority:true})
  assert.notEqual(result.taskId,task.taskId);assert.equal(result.threadId,'completed-thread',JSON.stringify(result))
  assert.equal(service.ledger.getTask(result.taskId).parentTaskId,task.taskId)
  assert.equal(service.ledger.getTask(task.taskId).state,'completed')
})

test('incomplete discovery blocks an unknown continuation but explicit new work uses the default',async t=>{
  const {service}=await fixture(t,{routeCandidateLimit:1})
  for(let i=0;i<2;i++)service.ledger.createTask({objective:`unrelated ${i}`,acceptance:['Verify']})
  const missing=await service.operate({action:'route',objective:'unfound target',intent:'continue'})
  assert.equal(missing.code,'EXECUTION_TARGET_NOT_FOUND')
  const incomplete=await service.operate({action:'route',objective:'unfound target'})
  assert.equal(incomplete.code,'EXECUTION_DISCOVERY_INCOMPLETE')
  service.context={subagents:{startActivation(){}}}
  const fresh=await service.operate({action:'route',objective:'unfound target',intent:'new'})
  assert.equal(fresh.policy.worker,'dsh_subagent');assert.equal(fresh.policy.agentPreset,'standard')
})

test('new workers use only the configured default or the paired creation-mode override',()=>{
  const available={dsh_subagent:true,codex:true}
  for(const priority of ['dsh_standard','dsh_cordis','codex']){
    const config=resolveConfig({codexWorkerEnabled:true,defaultWorkerPriority:priority})
    for(const objective of ['ptc','插件 harness bundle','Create a browser plugin'])assert.equal(resolveWorkerPolicy(config,{objective},available).priority,priority)
    assert.equal(resolveWorkerPolicy(config,{worker:'dsh_subagent',agentPreset:'cordis'},available).priority,'dsh_cordis')
    for(const args of [{worker:'codex'},{worker:'dsh_subagent'},{agentPreset:'cordis'},{worker:'dsh_subagent',agentPreset:'ptc'}])assert.throws(()=>resolveWorkerPolicy(config,args,available),{code:'WORKER_SELECTION_INVALID'})
    assert.throws(()=>resolveWorkerPolicy(config,{}, {dsh_subagent:false,codex:false}),{code:'WORKER_UNAVAILABLE'})
  }
})

test('migration keeps an exact copy of unrepresentable rules and preserves model policy references',()=>{
  const rules=[{id:'general',worker:'dsh_subagent',agentPreset:'cordis',keywords:[],capabilities:[],modelPolicy:'creator'},{id:'harness-plugin',worker:'codex',keywords:['custom'],capabilities:['network'],modelPolicy:'remote'}]
  const result=migrateWorkerSettings({workerRules:rules,defaultDshPreset:'standard',codexWorkerEnabled:true})
  assert.deepEqual(result.migration.previous.workerRules,rules)
  assert.ok(result.migration.warnings.includes('harness-plugin'))
  assert.ok(result.migration.warnings.includes('default-conflict:general'))
  assert.equal(result.settings.workerModelPolicies.dsh_cordis,'creator')
  assert.equal(Object.hasOwn(result.settings,'workerRules'),false)
})

test('execution projection recovers the same result from a checkpoint and its suffix',()=>{
  const events=[{seq:3,type:'user/message',surfaceOp:'append',data:{id:'message',source:{kind:'user'},content:[{type:'text',text:JSON.stringify({personalAgentExecution:'run',requestId:'request'})}]}},{seq:4,type:'assistant/message',surfaceOp:'append',data:{turn:2,message:{content:[{type:'text',text:'Observed result'}]}}},{seq:5,type:'turn/end',data:{turn:2,reason:{kind:'completed'}}}]
  const complete=events.reduce(executionProjection.apply,executionProjection.init())
  const checkpoint=executionProjection.stateSchema.parse(JSON.parse(JSON.stringify(events.slice(0,2).reduce(executionProjection.apply,executionProjection.init()))))
  assert.deepEqual(events.slice(2).reduce(executionProjection.apply,checkpoint),complete)
  assert.equal(complete.final.text,'Observed result');assert.equal(complete.final.requestId,'request')
})

test('idle result recovery does not acquire the main session and a reset never redirects an uncertain receipt',async t=>{
  const {service}=await fixture(t)
  let acquired=0
  service.context={agents:new Map()}
  service.mainSession={binding:()=>({session_id:'replacement'}),ensure:async()=>{acquired++;throw new Error('Unexpected restoration')}}
  const results=new ExecutionResults(service,{stateOf:()=>({})});service.results=results
  await results.kick();assert.equal(acquired,0)
  const task=service.ledger.createTask({objective:'Notice',acceptance:['Verify']})
  const run=service.ledger.planExecution({taskId:task.taskId,executorKind:'dsh_subagent',method:'subagent/start',params:{},dispatch:false,mutatesWorkspace:false})
  results.record(run.executionId,{executionId:run.executionId,acceptanceRequired:true})
  service.database.db.prepare("UPDATE execution_results SET delivery_state='delivering',target_session_id='archived'").run()
  await results.kick();await results.kick()
  assert.equal(acquired,0)
  assert.equal(service.database.db.prepare('SELECT delivery_state FROM execution_results').get().delivery_state,'unknown')
})

test('profile rule migration survives Config validation and is recorded once across restart',async t=>{
  const {service}=await fixture(t,{workerRules:[{id:'custom',worker:'dsh_subagent',agentPreset:'standard',keywords:['billing'],capabilities:[]}],defaultDshPreset:'standard'})
  assert.deepEqual(service.runtimeSettingsView().workerMigration.warnings,['custom'])
  const revalidated=resolveConfig(service.config)
  assert.deepEqual(revalidated.workerSettingsMigration,service.config.workerSettingsMigration)
  service.loadRuntimeSettings()
  assert.equal(service.database.db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type='settings.worker_selection_migrated'").get().n,1)
})

test('an uncertain older result does not block delivery of a later result',async t=>{
  const {service}=await fixture(t,{inboxBatchSize:1})
  const sent=[]
  const agent={status:'idle',session:{id:'main'},inbox:{nextStep:[],nextTurn:[]}}
  service.context={agents:new Map(),sessionPersistence:{flush:async()=>{}},sessionController:{prompt:async request=>sent.push(request)}}
  service.mainSession={binding:()=>({session_id:'main'}),ensure:async()=>({agent,sessionId:'main',version:1})}
  const results=new ExecutionResults(service,{stateOf:()=>({})});service.results=results
  for(const objective of ['Unknown receipt','Pending result']){
    const task=service.ledger.createTask({objective,acceptance:['Verify']})
    const run=service.ledger.planExecution({taskId:task.taskId,executorKind:'dsh_subagent',method:'subagent/start',params:{},dispatch:false,mutatesWorkspace:false})
    results.record(run.executionId,{executionId:run.executionId,acceptanceRequired:true})
    if(objective==='Unknown receipt')service.database.db.prepare("UPDATE execution_results SET delivery_state='unknown' WHERE execution_id=?").run(run.executionId)
  }
  await results.kick()
  assert.equal(sent.length,1)
  assert.deepEqual(service.database.db.prepare('SELECT delivery_state FROM execution_results ORDER BY rowid').all().map(row=>row.delivery_state),['unknown','delivered'])
})

test('incomplete semantic classification cannot turn existing work into a new worker',async t=>{
  const {service}=await fixture(t,{semanticRoutingEnabled:true})
  const task=service.ledger.createTask({objective:'Existing project work',acceptance:['Verify']})
  service.context={sessionController:{},subagents:{startActivation(){throw new Error('Must not dispatch')}}}
  for(const candidates of [[],[{candidateId:task.taskId,compatible:true,confidence:2,reason:'Invalid'}]]){
    service.analysisRuns.run=async()=>({value:{candidates}})
    await assert.rejects(service.executeObjective({objective:'Continue the project',requestId:JSON.stringify(candidates),mutatesWorkspace:false}),{code:'EXECUTION_ASSOCIATION_INVALID'})
  }
  assert.equal(service.database.db.prepare('SELECT COUNT(*) AS n FROM executions').get().n,0)
  assert.equal(service.database.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,1)
})

test('two concurrent requests for the same historical thread start only one native turn',async t=>{
  const {service,root}=await fixture(t)
  const old=await history(service,'codex','shared-thread',root,'One project')
  const calls=adapter(service,root)
  const original=service.adapter.request
  const bothReading=Promise.withResolvers(),release=Promise.withResolvers()
  let reads=0
  service.adapter.request=async(method,params)=>{
    if(method==='thread/read' && ++reads<=2){if(reads===2)bothReading.resolve();await release.promise}
    return original(method,params)
  }
  const first=service.executeObjective({sessionTaskId:old.session_task_id,objective:'First instruction',requestId:'first'},{codexMutationAuthority:true})
  const second=service.executeObjective({sessionTaskId:old.session_task_id,objective:'Second instruction',requestId:'second'},{codexMutationAuthority:true})
  await bothReading.promise
  release.resolve()
  const results=await Promise.all([first,second])
  assert.equal(results.filter(result=>result.code==='EXECUTION_SESSION_BUSY').length,1)
  assert.equal(calls.filter(call=>call.method==='turn/start').length,1)
  assert.equal(service.database.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,1)
})

test('explicit source filtering precedes candidate pagination and keeps its existing Task',async t=>{
  const {service,root}=await fixture(t,{routeCandidateLimit:1})
  const task=service.ledger.createTask({objective:'Older task',acceptance:['Verify']})
  const ref=service.ledger.upsertSession({system:'codex',externalId:'older-thread',cwd:root})
  service.ledger.attachTaskSession(task.taskId,ref.sessionRefId,{relation:'executor'})
  service.ledger.createTask({objective:'New unrelated task',acceptance:['Verify']})
  const found=service.buildCandidates({sessionId:'older-thread',sourceSystem:'codex',objective:'New unrelated task'})
  assert.equal(found.length,1)
  assert.equal(found[0].taskId,task.taskId)
})

test('contradictory explicit identities cannot fall back to an unlinked native thread',async t=>{
  const {service,root}=await fixture(t);const calls=adapter(service,root)
  const result=await service.executeObjective({taskId:'nonexistent',sessionId:'native-thread',sourceSystem:'codex',objective:'Continue',requestId:'conflict'},{codexMutationAuthority:true})
  assert.equal(result.code,'EXECUTION_TARGET_NOT_FOUND')
  assert.equal(calls.length,0)
  assert.equal(service.database.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,0)
})

test('an explicit historical source cannot silently switch to the linked Task latest executor',async t=>{
  const {service,root}=await fixture(t)
  const old=await history(service,'codex','source-thread',root,'Original work')
  const task=service.ledger.createTask({objective:'Original work',acceptance:['Verify']})
  const ref=service.ledger.upsertSession({system:'codex',externalId:'replacement-thread',cwd:root})
  service.ledger.attachTaskSession(task.taskId,ref.sessionRefId,{relation:'executor'})
  service.database.db.prepare('INSERT INTO task_sources VALUES(?,?,?,?,?,?,?)').run(`history:${old.session_task_id}`,task.taskId,old.session_ref_id,old.session_task_id,old.context_version,'[]',new Date().toISOString())
  const found=service.buildCandidates({sessionTaskId:old.session_task_id,sessionId:'source-thread',sourceSystem:'codex',objective:'Continue'})
  assert.equal(found[0].sessionId,'source-thread')
})

test('truncated automatic discovery cannot hide another matching target',async t=>{
  const {service}=await fixture(t,{routeCandidateLimit:1})
  for(let i=0;i<2;i++)service.ledger.createTask({objective:'Same objective',acceptance:['Verify']})
  const result=await service.operate({action:'route',objective:'Same objective'})
  assert.equal(result.code,'EXECUTION_DISCOVERY_INCOMPLETE')
})

test('a Task without a native executor can start Codex with resume disabled',async t=>{
  const {service,root}=await fixture(t,{defaultWorkerPriority:'codex'})
  const task=service.ledger.createTask({objective:'Existing work',acceptance:['Verify']})
  const calls=adapter(service,root)
  const native=service.adapter.request
  service.adapter.request=async(method,params)=>method==='thread/start'?(calls.push({method,params}),{cwd:root,runtimeWorkspaceRoots:[root],thread:{id:'first-thread',cwd:root}}):native(method,params)
  service.flags.set('routing.resume',false);service.flags.set('codex.new_thread.execute',true)
  const result=await service.executeObjective({taskId:task.taskId,objective:'Execute existing work',workspacePath:root,requestId:'first-native'},{codexMutationAuthority:true})
  assert.equal(result.threadId,'first-thread',JSON.stringify(result))
  assert.equal(result.taskId,task.taskId)
  assert.deepEqual(calls.map(call=>call.method),['thread/start','turn/start'])
})

test('an explicit new native session keeps the selected Task unless newTask is requested',async t=>{
  const {service,root}=await fixture(t,{defaultWorkerPriority:'codex'})
  const task=service.ledger.createTask({objective:'Existing work',acceptance:['Verify']})
  const ref=service.ledger.upsertSession({system:'codex',externalId:'original-thread',cwd:root})
  service.ledger.attachTaskSession(task.taskId,ref.sessionRefId,{relation:'executor'})
  const calls=adapter(service,root),native=service.adapter.request
  service.adapter.request=async(method,params)=>method==='thread/start'?(calls.push({method,params}),{cwd:root,runtimeWorkspaceRoots:[root],thread:{id:'replacement',cwd:root}}):native(method,params)
  service.flags.set('codex.new_thread.execute',true)
  const result=await service.executeObjective({taskId:task.taskId,objective:'Continue in new session',sessionAction:'new',workspacePath:root,requestId:'replace'},{codexMutationAuthority:true})
  assert.equal(result.threadId,'replacement',JSON.stringify(result))
  assert.equal(result.taskId,task.taskId)
  assert.equal(service.database.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,1)
  assert.equal(service.database.db.prepare("SELECT COUNT(*) AS n FROM execution_sessions WHERE session_ref_id=? AND role='executor'").get(ref.sessionRefId).n,0)
})

for (const worker of ['dsh_standard','codex']) test(`new ${worker} work uses its requested project while retaining the historical source`,async t=>{
  const {service,root}=await fixture(t,{defaultWorkerPriority:worker})
  const next=path.join(root,'new-work');mkdirSync(next)
  const previous=service.ledger.upsertProject({canonicalPath:root})
  const old=await history(service,'dsh','old-work',root,'Original report')
  const calls=[]
  const agent={session:{id:'main',seq:1,header:{cwd:root},deriveMessages:()=>[{role:'user',source:{kind:'user'},content:[{type:'text',text:'Create a new task in a new session'}]}]}}
  service.context={subagents:{startActivation:async args=>{calls.push(args);return {childId:args.childId,result:Promise.resolve({stopReason:'completed',output:[{type:'text',text:'New report'}]}),dispose:async()=>{}}}}}
  service.recordDshUsage=async()=>{}
  if (worker==='codex') {
    adapter(service,next);service.flags.set('codex.new_thread.execute',true)
    const request=service.adapter.request
    service.adapter.request=async(method,params)=>method==='thread/start'?(calls.push(params),{cwd:next,runtimeWorkspaceRoots:[next],thread:{id:'new-work',cwd:next}}):request(method,params)
  }
  const result=await service.executeObjective({sessionTaskId:old.session_task_id,objective:'New report',newTask:true,sessionAction:'new',sessionChangeQuote:'new session',workspacePath:next,mutatesWorkspace:false,requestId:'new-project'},{agent,codexMutationAuthority:true})
  const task=service.ledger.getTask(result.taskId)
  assert.equal(calls.length,1,JSON.stringify(result))
  assert.equal(calls[0].cwd,realpathSync(next))
  assert.notEqual(task.projectId,previous.projectId)
  assert.equal(service.database.db.prepare('SELECT canonical_path FROM project_locations WHERE project_id=?').get(task.projectId).canonical_path,realpathSync(next))
  assert.equal(service.database.db.prepare('SELECT cwd FROM session_refs WHERE session_ref_id=?').get(old.session_ref_id).cwd,realpathSync(root))
  assert.equal(service.database.db.prepare('SELECT relation FROM task_sessions WHERE task_id=? AND session_ref_id=?').get(task.taskId,old.session_ref_id).relation,'fork_source')
  assert.equal(service.database.db.prepare('SELECT session_task_id FROM task_sources WHERE task_id=?').get(task.taskId).session_task_id,old.session_task_id)
})

test('a conflicting project for new work rejects before creating a task or association',async t=>{
  const {service,root}=await fixture(t)
  const next=path.join(root,'new-work');mkdirSync(next)
  const previous=service.ledger.upsertProject({canonicalPath:root})
  const old=await history(service,'dsh','old-project-work',root,'Original report')
  service.context={subagents:{startActivation(){throw Error('Must not dispatch')}}}
  await assert.rejects(service.executeObjective({sessionTaskId:old.session_task_id,objective:'New report',newTask:true,sessionAction:'new',projectId:previous.projectId,workspacePath:next,requestId:'project-conflict'}),/projectId does not match workspacePath/)
  assert.equal(service.database.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,0)
  assert.equal(service.database.db.prepare('SELECT COUNT(*) AS n FROM task_sources').get().n,0)
  assert.equal(service.database.db.prepare('SELECT COUNT(*) AS n FROM project_locations').get().n,1)
})

test('DSH run metadata failure rolls back execution planning and releases the workspace lease',async t=>{
  const {service,root}=await fixture(t)
  let dispatched=false
  service.context={subagents:{startActivation(){dispatched=true;throw Error('Unexpected dispatch')}}}
  service.database.db.exec("CREATE TEMP TRIGGER reject_run BEFORE INSERT ON dsh_execution_runs BEGIN SELECT RAISE(ABORT,'injected run metadata failure'); END")
  await assert.rejects(service.executeObjective({objective:'Prepare task',workspacePath:root,requestId:'metadata'},{agent:{session:{id:'main',seq:1,header:{cwd:root}}}}),/injected run metadata failure/)
  assert.equal(dispatched,false)
  assert.equal(service.database.db.prepare('SELECT COUNT(*) AS n FROM executions').get().n,0)
  assert.equal(service.database.db.prepare("SELECT COUNT(*) AS n FROM leases WHERE lease_state IN ('active','recovery_hold')").get().n,0)
})

test('bounded result recovery advances past an earlier running worker',async t=>{
  const {service}=await fixture(t,{inboxBatchSize:1})
  service.context={agents:new Map([['still-running',{status:'running'}]])}
  service.recordDshUsage=async()=>{}
  const results=new ExecutionResults(service,{stateOf:()=>({})});service.results=results
  const ids=[]
  for(const child of ['still-running','already-finished']){
    const task=service.ledger.createTask({objective:child,acceptance:['Verify']})
    const run=service.ledger.planExecution({taskId:task.taskId,executorKind:'dsh_subagent',method:'session/prompt',params:{},dispatch:false,mutatesWorkspace:false})
    service.ledger.transitionExecution(run.executionId,'running');ids.push(run.executionId)
    const final=child==='already-finished'?JSON.stringify({executionId:run.executionId,requestId:child,reason:'completed',seq:5,text:'Finished'}):null
    service.database.db.prepare('INSERT INTO dsh_execution_runs(execution_id,session_id,request_id,start_seq,terminal_json,mode) VALUES(?,?,?,?,?,?)').run(run.executionId,child,child,0,final,'session')
  }
  await results.kick();await results.kick()
  assert.equal(service.database.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(ids[1]).execution_state,'succeeded')
  assert.equal(service.database.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(ids[0]).execution_state,'running')
})

test('consumed settlements from multiple children survive checkpoints without duplicate notices',async t=>{
  const {service}=await fixture(t)
  const event=(child,seq)=>({seq,type:'user/message',surfaceOp:'append',data:{source:{kind:'subagent-settled',senderSessionId:child}}})
  const first=executionProjection.apply(executionProjection.init(),event('child-a',2))
  const checkpoint=executionProjection.stateSchema.parse(JSON.parse(JSON.stringify(first)))
  const state=executionProjection.apply(checkpoint,event('child-b',3))
  assert.deepEqual(state,[event('child-a',2),event('child-b',3)].reduce(executionProjection.apply,executionProjection.init()))
  const sent=[]
  const agent={status:'idle',session:{id:'main'},inbox:{nextStep:[],nextTurn:[]}}
  service.context={agents:new Map(),sessionPersistence:{flush:async()=>{}},sessionController:{prompt:async request=>sent.push(request)}}
  service.mainSession={binding:()=>({session_id:'main'}),ensure:async()=>({agent,sessionId:'main',version:1})}
  const results=new ExecutionResults(service,{stateOf:()=>state});service.results=results
  for(const child of ['child-a','child-b']){
    const task=service.ledger.createTask({objective:child,acceptance:['Verify']})
    const run=service.ledger.planExecution({taskId:task.taskId,executorKind:'dsh_subagent',method:'subagent/sendMessage',params:{},dispatch:false,mutatesWorkspace:false})
    service.database.db.prepare('INSERT INTO dsh_execution_runs(execution_id,session_id,request_id,start_seq,parent_session_id,parent_start_seq,mode) VALUES(?,?,?,?,?,?,?)').run(run.executionId,child,child,0,'main',1,'subagent')
    results.record(run.executionId,{executionId:run.executionId,acceptanceRequired:true})
  }
  await results.kick()
  assert.equal(sent.length,0)
  assert.equal(service.database.db.prepare("SELECT COUNT(*) AS n FROM execution_results WHERE delivery_state='delivered'").get().n,2)
})

test('a fork adopts historical work and preserves the association without an extra Task',async t=>{
  const {service,root}=await fixture(t)
  const old=await history(service,'codex','history-fork-source',root,'Historical task')
  const calls=adapter(service,root),native=service.adapter.request
  service.flags.set('routing.fork',true)
  service.adapter.request=async(method,params)=>{
    if(method==='thread/read'){calls.push({method,params});return {thread:{id:params.threadId,cwd:root,turns:[{id:'completed',status:'completed'}]}}}
    if(method==='thread/fork'){calls.push({method,params});return {cwd:root,runtimeWorkspaceRoots:[root],thread:{id:'forked',cwd:root}}}
    return native(method,params)
  }
  const result=await service.executeObjective({sessionTaskId:old.session_task_id,objective:'Try another approach',sessionAction:'fork',requestId:'fork-history'},{codexMutationAuthority:true})
  assert.equal(result.threadId,'forked',JSON.stringify(result))
  assert.equal(service.database.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,1)
  assert.equal(service.database.db.prepare('SELECT task_id FROM task_sources WHERE source_key=?').get(`history:${old.session_task_id}`).task_id,result.taskId)
  assert.equal(service.database.db.prepare("SELECT relation FROM task_sessions WHERE task_id=? AND session_ref_id=?").get(result.taskId,old.session_ref_id).relation,'fork_source')
  assert.deepEqual(calls.map(call=>call.method),['thread/read','thread/read','thread/resume','thread/fork','turn/start'])
})

test('cold DSH sessions with pending inbox work block before acquiring an agent',async t=>{
  const {service,root}=await fixture(t)
  let closed=0
  service.context={agents:new Map(),sessionPersistence:{stat:async()=>({eventCount:3}),open:async()=>({header:{cwd:root,agentPreset:'standard'},close:async()=>{}})},sessionQuery:{observeSession:async()=>({cursor:2,projections:{values:{agentPreset:'standard',inbox:{'next-turn':[{id:'pending'}],'next-step':[]}}},[Symbol.dispose](){closed++}})}}
  const result=await service.executeObjective({sessionId:'cold-busy',sourceSystem:'dsh',objective:'Continue',requestId:'cold'},{agent:{session:{id:'main',header:{cwd:root}}}})
  assert.equal(result.code,'EXECUTION_SESSION_BUSY')
  assert.equal(closed,1)
  assert.equal(service.database.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,0)
})

function dshDirectoryFixture(service,root,{cold=false,child=false}={}) {
  const origin=realpathSync(root),current=path.join(origin,'current'),next=path.join(origin,'next')
  mkdirSync(current);mkdirSync(next)
  const main={session:{id:'main',seq:1,header:{cwd:origin}}}
  const worker={status:'idle',session:{id:'native-worker',seq:5,header:{cwd:origin}},inbox:{nextTurn:[],nextStep:[]}}
  const header={cwd:origin,agentPreset:'standard',...(child?{origin:'subagent',parentSessionId:'main'}:{})}
  const listeners=new Set(),calls=[]
  let effective=current
  const directories={get:()=>effective,ensure:async()=>effective,set:async(target,directory)=>{calls.push(['set',target.session.id,directory]);effective=directory}}
  const deliver=()=>{calls.push(['deliver',effective]);return 'message'}
  service.context={
    agents:new Map(cold?[]:[[worker.session.id,worker]]),workingDirectory:directories,
    agentPresets:{presetForSession:()=> 'standard'},
    sessionPersistence:{stat:async()=>({eventCount:6}),open:async()=>({header,close:async()=>{}}),flush:async()=>{}},
    sessionQuery:{observeSession:async()=>({cursor:5,projections:{values:{workingDirectory:effective,agentPreset:'standard',inbox:{'next-turn':[],'next-step':[]}}},[Symbol.dispose](){}})},
    on:(event,listener)=>{assert.equal(event,'agent/created');listeners.add(listener);return()=>listeners.delete(listener)},
    sessionController:{resolveAgent:async()=>({agent:worker}),prompt:async()=>({messageId:deliver()})},
    subagents:{listDescendants:async()=>[{id:worker.session.id,kind:'child',mode:'continuable'}],sendMessage:async()=>{
      if(cold)for(const listener of listeners)await listener({agent:worker})
      return deliver()
    }},
  }
  const project=service.ledger.upsertProject({canonicalPath:origin})
  const task=service.ledger.createTask({objective:'Directory continuation',projectId:project.projectId,acceptance:['Verify']})
  const ref=service.ledger.upsertSession({system:'dsh',externalId:worker.session.id,cwd:origin,sourceKind:child?'subagent':'session'})
  service.ledger.attachTaskSession(task.taskId,ref.sessionRefId,{relation:'executor'})
  return {main,worker,header,task,ref,origin,current,next,calls,listeners,directories,setCurrent:value=>{effective=value}}
}

for(const cold of [false,true])for(const child of [false,true])test(`DSH ${cold?'cold':'live'} ${child?'child':'ordinary'} continuation switches directory on the same session`,async t=>{
  const {service,root}=await fixture(t)
  const f=dshDirectoryFixture(service,root,{cold,child})
  const preview=await service.operate({action:'route',taskId:f.task.taskId,objective:'Continue'}, {agent:f.main})
  assert.equal(preview.target.cwd,f.current)
  assert.deepEqual(f.calls,[])
  const result=await service.executeObjective({taskId:f.task.taskId,objective:'Continue',workspacePath:f.next,mutatesWorkspace:true,requestId:'switch'},{agent:f.main})
  assert.equal(result.childId,f.worker.session.id,JSON.stringify(result))
  assert.deepEqual(f.calls,[['set',f.worker.session.id,f.next],['deliver',f.next]])
  assert.equal(f.listeners.size,0)
  assert.equal(f.header.cwd,f.origin)
  assert.equal(service.ledger.getTask(f.task.taskId).projectId,f.task.projectId)
  const run=service.database.db.prepare(`SELECT l.canonical_path,e.workspace_baseline_id,k.resource_key,k.lease_state FROM executions e
    JOIN project_locations l ON l.location_id=e.workspace_location_id JOIN leases k USING(execution_id) WHERE execution_id=?`).get(result.executionId)
  assert.equal(run.canonical_path,f.next)
  assert.ok(run.workspace_baseline_id)
  assert.equal(run.resource_key,`workspace:${f.next}`)
  assert.equal(run.lease_state,'active')
  assert.equal(service.buildCandidates({taskId:f.task.taskId})[0].cwd,f.next)
  assert.equal(service.database.db.prepare('SELECT cwd FROM session_refs WHERE session_ref_id=?').get(f.ref.sessionRefId).cwd,f.origin)
})

test('DSH continuation without a requested directory adopts native state and records readonly locations',async t=>{
  const {service,root}=await fixture(t)
  const f=dshDirectoryFixture(service,root,{cold:true,child:true})
  const result=await service.executeObjective({taskId:f.task.taskId,objective:'Continue',mutatesWorkspace:false,requestId:'retain'},{agent:f.main})
  assert.equal(result.accepted,true)
  assert.deepEqual(f.calls,[['deliver',f.current]])
  const run=service.database.db.prepare(`SELECT l.canonical_path,e.workspace_baseline_id,k.lease_id FROM executions e
    JOIN project_locations l ON l.location_id=e.workspace_location_id LEFT JOIN leases k USING(execution_id) WHERE execution_id=?`).get(result.executionId)
  assert.deepEqual({...run},{canonical_path:f.current,workspace_baseline_id:null,lease_id:null})
  assert.equal(service.buildCandidates({sessionId:f.worker.session.id,sourceSystem:'dsh'})[0].cwd,f.current)
  assert.equal(f.listeners.size,0)
})

test('invalid DSH requested directories never switch or dispatch',async t=>{
  const {service,root}=await fixture(t)
  const f=dshDirectoryFixture(service,root)
  const file=path.join(root,'file');writeFileSync(file,'content')
  for(const workspacePath of [path.join(root,'missing'),file])await assert.rejects(service.executeObjective({taskId:f.task.taskId,objective:'Continue',workspacePath,mutatesWorkspace:false,requestId:workspacePath},{agent:f.main}),/ENOENT|existing directory/)
  assert.deepEqual(f.calls,[])
  assert.equal(service.database.db.prepare('SELECT COUNT(*) AS n FROM executions').get().n,0)
})

test('a DSH directory switch failure blocks cold child delivery and releases its lease and hook',async t=>{
  const {service,root}=await fixture(t)
  const f=dshDirectoryFixture(service,root,{cold:true,child:true})
  f.directories.set=async()=>{throw Error('Directory access rejected')}
  await assert.rejects(service.executeObjective({taskId:f.task.taskId,objective:'Continue',workspacePath:f.next,mutatesWorkspace:true,requestId:'reject'},{agent:f.main}),/Directory access rejected/)
  assert.deepEqual(f.calls,[])
  assert.equal(f.listeners.size,0)
  assert.equal(service.database.db.prepare('SELECT execution_state FROM executions').get().execution_state,'failed')
  assert.equal(service.database.db.prepare('SELECT workspace_location_id FROM executions').get().workspace_location_id,null)
  assert.equal(service.database.db.prepare("SELECT COUNT(*) AS n FROM leases WHERE lease_state IN ('active','recovery_hold')").get().n,0)
})

test('DSH implicit directory comparison accepts a canonical alias without switching native state',async t=>{
  const {service,root}=await fixture(t)
  const f=dshDirectoryFixture(service,root)
  const alias=path.join(f.origin,'alias');symlinkSync(f.current,alias,'junction');f.setCurrent(alias)
  const result=await service.executeObjective({taskId:f.task.taskId,objective:'Continue',mutatesWorkspace:false,requestId:'alias'},{agent:f.main})
  assert.equal(result.accepted,true)
  assert.deepEqual(f.calls,[['deliver',alias]])
  assert.equal(service.buildCandidates({taskId:f.task.taskId})[0].cwd,f.current)
})

test('a cold DSH setup failure with uncertain native cleanup retains the workspace hold',async t=>{
  const {service,root}=await fixture(t)
  const f=dshDirectoryFixture(service,root,{cold:true,child:true})
  f.directories.set=async()=>{throw Error('Directory access rejected')}
  const send=service.context.subagents.sendMessage
  service.context.subagents.sendMessage=async()=>{
    try {return await send()}
    catch(error){throw new AggregateError([error,new Error('Native cleanup failed')],'Native setup rollback failed')}
  }
  await assert.rejects(service.executeObjective({taskId:f.task.taskId,objective:'Continue',workspacePath:f.next,mutatesWorkspace:true,requestId:'rollback-failure'},{agent:f.main}),/Native setup rollback failed/)
  assert.deepEqual(f.calls,[])
  assert.equal(f.listeners.size,0)
  assert.equal(service.database.db.prepare('SELECT execution_state FROM executions').get().execution_state,'reconciling')
  assert.equal(service.database.db.prepare('SELECT lease_state FROM leases').get().lease_state,'recovery_hold')
})

test('a new DSH worker without a directory records the effective directory without adding a write lease',async t=>{
  const {service,root}=await fixture(t)
  const directory=path.join(realpathSync(root),'default-workspace')
  mkdirSync(directory)
  let adopted
  service.context={workspaceController:{initializeDefault:async()=>({workspace:{path:directory}})},workingDirectory:{ensure:async()=>{throw new Error('must not inherit main directory')}},subagents:{startActivation:async args=>{
    adopted=args.cwd
    return {childId:args.childId,result:Promise.resolve({stopReason:'completed',output:[]}),dispose:async()=>{}}
  }}}
  service.recordDshUsage=async()=>{}
  const result=await service.executeObjective({objective:'Readonly default directory',intent:'new',mutatesWorkspace:false,requestId:'default-directory'},{agent:{session:{id:'main',seq:1,header:{cwd:root}}}})
  assert.equal(result.stopReason,'completed')
  assert.equal(adopted,directory)
  assert.equal(service.buildCandidates({taskId:result.taskId})[0].cwd,directory)
  assert.equal(service.database.db.prepare('SELECT COUNT(*) AS n FROM leases').get().n,0)
})

test('DSH directory changes during admission do not restore a stale implicit directory',async t=>{
  const {service,root}=await fixture(t)
  const f=dshDirectoryFixture(service,root)
  const plan=service.ledger.planExecution.bind(service.ledger)
  service.ledger.planExecution=args=>{const result=plan(args);f.setCurrent(f.next);return result}
  await assert.rejects(service.executeObjective({taskId:f.task.taskId,objective:'Continue',mutatesWorkspace:true,requestId:'race'},{agent:f.main}),{code:'EXECUTION_DIRECTORY_CHANGED'})
  assert.deepEqual(f.calls,[])
  assert.equal(service.context.workingDirectory.get(f.worker.session),f.next)
  assert.equal(service.database.db.prepare("SELECT COUNT(*) AS n FROM leases WHERE lease_state IN ('active','recovery_hold')").get().n,0)
})

test('DSH work arriving during admission prevents a directory change and continuation delivery',async t=>{
  const {service,root}=await fixture(t)
  const f=dshDirectoryFixture(service,root,{child:true})
  const plan=service.ledger.planExecution.bind(service.ledger)
  service.ledger.planExecution=args=>{const result=plan(args);f.worker.inbox.nextTurn.push({id:'external'});return result}
  await assert.rejects(service.executeObjective({taskId:f.task.taskId,objective:'Continue',workspacePath:f.next,mutatesWorkspace:true,requestId:'busy-race'},{agent:f.main}),{code:'EXECUTION_SESSION_BUSY'})
  assert.deepEqual(f.calls,[])
  assert.equal(f.listeners.size,0)
  assert.equal(service.database.db.prepare("SELECT COUNT(*) AS n FROM leases WHERE lease_state IN ('active','recovery_hold')").get().n,0)
})

test('cold DSH inspection requires native directory observation instead of falling back to its header',async t=>{
  const {service,root}=await fixture(t)
  const f=dshDirectoryFixture(service,root,{cold:true})
  delete service.context.sessionQuery
  const result=await inspectNativeTarget(service,{sessionId:f.worker.session.id,sourceSystem:'dsh'},{agent:f.main})
  assert.equal(result.code,'DSH_RESUME_UNAVAILABLE')
  assert.deepEqual(f.calls,[])
})

test('failed native replacement preserves the existing Task original executor',async t=>{
  const {service,root}=await fixture(t,{defaultWorkerPriority:'codex'})
  const task=service.ledger.createTask({objective:'Existing work',acceptance:['Verify']})
  const ref=service.ledger.upsertSession({system:'codex',externalId:'retained-thread',cwd:root})
  service.ledger.attachTaskSession(task.taskId,ref.sessionRefId,{relation:'executor'})
  adapter(service,root)
  const native=service.adapter.request
  service.adapter.request=async(method,params)=>{if(method==='thread/start')throw Error('definite rejection');return native(method,params)}
  service.flags.set('codex.new_thread.execute',true)
  const result=await service.executeObjective({taskId:task.taskId,objective:'Try a replacement',sessionAction:'new',workspacePath:root,requestId:'failed-replace'},{codexMutationAuthority:true})
  assert.equal(result.executions[0].dispatch.failed,1)
  assert.equal(service.buildCandidates({taskId:task.taskId})[0].sessionId,'retained-thread')
  const continued=await service.executeObjective({taskId:task.taskId,objective:'Continue the original',requestId:'continue-after-rejection'},{codexMutationAuthority:true})
  assert.equal(continued.threadId,'retained-thread')
})

test('concurrent first execution of an existing Task creates only one native worker',async t=>{
  const {service,root}=await fixture(t,{defaultWorkerPriority:'codex'})
  const task=service.ledger.createTask({objective:'First worker',acceptance:['Verify']})
  const calls=adapter(service,root),native=service.adapter.request
  service.flags.set('codex.new_thread.execute',true)
  const started=Promise.withResolvers(),release=Promise.withResolvers()
  service.adapter.request=async(method,params)=>{
    if(method==='thread/start'){calls.push({method,params});started.resolve();await release.promise;return {cwd:root,runtimeWorkspaceRoots:[root],thread:{id:'only-thread',cwd:root}}}
    return native(method,params)
  }
  const first=service.executeObjective({taskId:task.taskId,objective:'Start task',workspacePath:root,requestId:'first'},{codexMutationAuthority:true})
  await started.promise
  let second
  try {
    const preview=await service.operate({action:'route',taskId:task.taskId,objective:'Start task'})
    assert.equal(preview.waiting,true,JSON.stringify(preview))
    second=await service.executeObjective({taskId:task.taskId,objective:'Start task',workspacePath:root,requestId:'second'},{codexMutationAuthority:true})
    assert.equal(second.waiting,true)
  } finally {release.resolve();await first}
  assert.equal(calls.filter(call=>call.method==='thread/start').length,1)
})

test('uncertain thread creation blocks another execution even without a native identity',async t=>{
  const {service,root}=await fixture(t,{defaultWorkerPriority:'codex'})
  const task=service.ledger.createTask({objective:'Unknown creation',acceptance:['Verify']})
  const calls=adapter(service,root)
  service.flags.set('codex.new_thread.execute',true)
  service.adapter.request=async(method,params)=>{calls.push({method,params});throw Object.assign(Error('Lost reply'),{deliveryUnknown:true})}
  const first=await service.executeObjective({taskId:task.taskId,objective:'Start task',workspacePath:root,requestId:'unknown-first'},{codexMutationAuthority:true})
  assert.equal(first.executions[0].dispatch.uncertain,1)
  const second=await service.executeObjective({taskId:task.taskId,objective:'Continue task',workspacePath:root,requestId:'unknown-second'},{codexMutationAuthority:true})
  assert.equal(second.waiting,true,JSON.stringify(second))
  assert.equal(calls.length,1)
})

test('accepted remote dispatch with a local write failure stays uncertain and is never resent',async t=>{
  const {service,root}=await fixture(t)
  const task=service.ledger.createTask({objective:'Accepted remotely',acceptance:['Verify']})
  const calls=adapter(service,root)
  service.flags.set('codex.new_thread.execute',true)
  service.adapter.request=async(method,params)=>{calls.push({method,params});return {thread:{id:'remote-created',cwd:root}}}
  service.database.db.exec("CREATE TEMP TRIGGER reject_native_link BEFORE INSERT ON execution_sessions BEGIN SELECT RAISE(ABORT,'injected native link failure'); END")
  const result=await service.dispatchCodex({taskId:task.taskId,method:'thread/start',params:{cwd:root},mutatesWorkspace:false})
  assert.equal(result.dispatch.uncertain,1)
  const row=service.database.db.prepare('SELECT outbox_state,external_result_json FROM outbox WHERE outbox_id=?').get(result.outboxId)
  assert.equal(row.outbox_state,'uncertain');assert.equal(JSON.parse(row.external_result_json).thread.id,'remote-created')
  assert.equal(service.database.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(result.executionId).execution_state,'dispatch_unknown')
  service.database.db.exec('DROP TRIGGER reject_native_link')
  await service.dispatcher.dispatchOnce()
  assert.equal(calls.length,1)
})

test('a mismatched resume reply cannot redirect the next turn to another thread',async t=>{
  const {service,root}=await fixture(t)
  const old=await history(service,'codex','expected-thread',root,'Resume original')
  const calls=adapter(service,root),native=service.adapter.request
  service.adapter.request=async(method,params)=>{if(method==='thread/resume'){calls.push({method,params});return {thread:{id:'wrong-thread',cwd:root}}}return native(method,params)}
  const result=await service.executeObjective({sessionTaskId:old.session_task_id,objective:'Continue',requestId:'mismatch'},{codexMutationAuthority:true})
  assert.equal(result.executions[0].dispatch.uncertain,1,JSON.stringify(result))
  assert.equal(calls.some(call=>call.method==='turn/start'),false)
})

test('Codex reconciliation reads only the executor thread and the exact recorded turn',async t=>{
  const {service,root}=await fixture(t)
  const task=service.ledger.createTask({objective:'Recover original turn',acceptance:['Verify']})
  const run=service.ledger.planExecution({taskId:task.taskId,executorKind:'codex',method:'turn/start',params:{threadId:'executor'},dispatch:false,mutatesWorkspace:false})
  service.ledger.transitionExecution(run.executionId,'running');service.ledger.transitionExecution(run.executionId,'reconciling')
  for(const [system,id,kind,role] of [['dsh','main','interaction','interaction'],['codex','fork-source','app_server_thread','fork_source'],['codex','executor','app_server_thread','executor'],['codex','expected-turn','app_server_turn','executor']]){
    const ref=service.ledger.upsertSession({system,externalId:id,sourceKind:kind,cwd:root})
    service.ledger.attachExecutionSession(run.executionId,ref.sessionRefId,{role})
  }
  const calls=adapter(service,root)
  service.adapter.request=async(method,params)=>{calls.push({method,params});return {thread:{id:params.threadId,turns:[{id:'expected-turn',status:'completed'}]}}}
  const result=await service.reconcileExecutions()
  assert.deepEqual(calls.map(call=>call.params.threadId),['executor'])
  assert.equal(result.terminal,1)
})

test('Codex reconciliation never treats an unrelated latest turn as the missing execution',async t=>{
  const {service,root}=await fixture(t)
  const task=service.ledger.createTask({objective:'Missing turn receipt',acceptance:['Verify']})
  const run=service.ledger.planExecution({taskId:task.taskId,executorKind:'codex',method:'turn/start',params:{threadId:'executor'},dispatch:false,mutatesWorkspace:false})
  service.ledger.transitionExecution(run.executionId,'running');service.ledger.transitionExecution(run.executionId,'reconciling')
  const ref=service.ledger.upsertSession({system:'codex',externalId:'executor',sourceKind:'app_server_thread',cwd:root})
  service.ledger.attachExecutionSession(run.executionId,ref.sessionRefId,{role:'executor'})
  const calls=adapter(service,root)
  service.adapter.request=async(method,params)=>{calls.push({method,params});return {thread:{id:'executor',turns:[{id:'unrelated-turn',status:'inProgress'}]}}}
  const result=await service.reconcileExecutions()
  assert.equal(result.unresolved,1)
  assert.equal(service.database.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(run.executionId).execution_state,'reconciling')
  assert.equal(service.database.db.prepare("SELECT COUNT(*) AS n FROM execution_sessions es JOIN session_refs s USING(session_ref_id) WHERE es.execution_id=? AND s.source_kind='app_server_turn'").get(run.executionId).n,0)
})

test('direct internal work keeps the Task native association without dispatching that worker',async t=>{
  const {service,root}=await fixture(t)
  const task=service.ledger.createTask({objective:'Verify worker output',acceptance:['Verify']})
  const ref=service.ledger.upsertSession({system:'codex',externalId:'original-worker',cwd:root,sourceKind:'app_server_thread'})
  service.ledger.attachTaskSession(task.taskId,ref.sessionRefId,{relation:'executor'})
  const calls=adapter(service,root)
  const agent={session:{id:'main',seq:1,header:{cwd:root}}}
  const result=await service.executeObjective({taskId:task.taskId,worker:'internal',objective:'Verify worker output',mutatesWorkspace:false,requestId:'internal-existing'},{agent})
  assert.equal(result.worker,'internal',JSON.stringify(result))
  assert.equal(result.taskId,task.taskId)
  assert.equal(calls.length,0)
  assert.equal(service.buildCandidates({taskId:task.taskId})[0].sessionId,'original-worker')
})

test('equal request IDs in different caller sessions remain independent',async t=>{
  const {service,root}=await fixture(t)
  const results=[]
  for(const id of ['caller-a','caller-b']){
    results.push(await service.executeObjective({worker:'internal',objective:id,intent:'new',mutatesWorkspace:false,requestId:'same-request'}, {agent:{session:{id,seq:1,header:{cwd:root}}}}))
  }
  assert.notEqual(results[0].executionId,results[1].executionId)
  assert.notEqual(results[0].taskId,results[1].taskId)
})

test('a turn notification with a different thread identity cannot settle the recorded execution',async t=>{
  const {service,root}=await fixture(t)
  const task=service.ledger.createTask({objective:'Original work',acceptance:['Verify']})
  const run=service.ledger.planExecution({taskId:task.taskId,executorKind:'codex',method:'turn/start',params:{threadId:'original'},dispatch:false,mutatesWorkspace:false})
  service.ledger.transitionExecution(run.executionId,'running')
  for(const [id,kind] of [['original','app_server_thread'],['recorded-turn','app_server_turn']]){
    const ref=service.ledger.upsertSession({system:'codex',externalId:id,sourceKind:kind,cwd:root})
    service.ledger.attachExecutionSession(run.executionId,ref.sessionRefId,{role:'executor'})
  }
  const inbox=service.ledger.recordInbox({adapterInstanceId:'test',connectionEpoch:1,method:'turn/completed',payload:{},dedupeKey:'wrong-thread-notice'})
  assert.equal(service.projectCodexNotification({inboxId:inbox.inboxId,method:'turn/completed',params:{threadId:'another-thread',turn:{id:'recorded-turn',status:'completed'}}}),false)
  assert.equal(service.database.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(run.executionId).execution_state,'running')
})

test('cancelling while Codex creates a thread prevents the subsequent turn',async t=>{
  const {service,root}=await fixture(t,{defaultWorkerPriority:'codex'})
  const calls=adapter(service,root),native=service.adapter.request
  service.flags.set('codex.new_thread.execute',true)
  const started=Promise.withResolvers(),release=Promise.withResolvers(),controller=new AbortController()
  service.adapter.request=async(method,params)=>{
    if(method==='thread/start'){calls.push({method,params});started.resolve();await release.promise;return {cwd:root,runtimeWorkspaceRoots:[root],thread:{id:'created-before-cancel',cwd:root}}}
    return native(method,params)
  }
  const pending=service.executeObjective({objective:'Cancelled start',intent:'new',workspacePath:root,requestId:'cancel-during-setup'},{codexMutationAuthority:true,signal:controller.signal})
  const rejected=assert.rejects(pending,{name:'AbortError'})
  await started.promise;controller.abort();release.resolve();await rejected
  assert.deepEqual(calls.map(call=>call.method),['thread/start'])
  assert.equal(service.database.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE method='turn/start'").get().n,0)
})

test('a reset beginning during main-session acquisition defers the unsent result',async t=>{
  const {service}=await fixture(t)
  const ready=Promise.withResolvers(),acquired=Promise.withResolvers(),sent=[]
  const agent={status:'idle',session:{id:'old-main'},inbox:{nextStep:[],nextTurn:[]}}
  service.context={agents:new Map(),sessionPersistence:{flush:async()=>{}},sessionController:{prompt:async request=>sent.push(request)}}
  service.mainSession={reset:{operation:null},binding:()=>({session_id:'old-main'}),ensure:async()=>{acquired.resolve();await ready.promise;return {agent,sessionId:'old-main',version:1}}}
  const results=new ExecutionResults(service,{stateOf:()=>({})});service.results=results
  const task=service.ledger.createTask({objective:'Pending notice',acceptance:['Verify']})
  const run=service.ledger.planExecution({taskId:task.taskId,executorKind:'dsh_subagent',method:'session/prompt',params:{},dispatch:false,mutatesWorkspace:false})
  results.record(run.executionId,{executionId:run.executionId,acceptanceRequired:true})
  const pending=results.kick()
  await acquired.promise;service.mainSession.reset.operation=Promise.resolve();ready.resolve();await pending
  assert.equal(sent.length,0)
  assert.equal(service.database.db.prepare('SELECT delivery_state FROM execution_results WHERE execution_id=?').get(run.executionId).delivery_state,'pending')
})

for (const worker of ['codex','internal']) test(`${worker} preparation rolls back an execution when its session attachment fails`,async t=>{
  const {service,root}=await fixture(t)
  const task=service.ledger.createTask({objective:'Atomic preparation',acceptance:['Verify']})
  const ref=service.ledger.upsertSession({system:'codex',externalId:'atomic-thread',sourceKind:'app_server_thread',cwd:root})
  const calls=adapter(service,root)
  service.database.db.exec("CREATE TEMP TRIGGER reject_preparation_link BEFORE INSERT ON execution_sessions BEGIN SELECT RAISE(ABORT,'injected preparation failure'); END")
  if(worker==='codex') await assert.rejects(service.dispatchCodex({taskId:task.taskId,method:'turn/start',params:{threadId:'atomic-thread'},workspacePath:root,executionSessions:[{sessionRefId:ref.sessionRefId,role:'executor'}]}),/injected preparation failure/)
  else await assert.rejects(service.executeObjective({taskId:task.taskId,worker:'internal',objective:'Record work',workspacePath:root,requestId:'atomic-internal'},{agent:{session:{id:'main',seq:0,header:{cwd:root}}},callerWorkspaceRoot:root}),/injected preparation failure/)
  assert.equal(service.database.db.prepare('SELECT COUNT(*) AS n FROM executions').get().n,0)
  assert.equal(service.database.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n,0)
  assert.equal(service.database.db.prepare("SELECT COUNT(*) AS n FROM leases WHERE lease_state IN ('active','recovery_hold')").get().n,0)
  assert.equal(calls.length,0)
})

test('a Task assigned a native session after discovery cannot create a replacement from the stale candidate',async t=>{
  const {service,root}=await fixture(t,{defaultWorkerPriority:'codex'})
  const task=service.ledger.createTask({objective:'Assigned during discovery',acceptance:['Verify']})
  const calls=adapter(service,root)
  service.flags.set('codex.new_thread.execute',true)
  const discover=service.semanticCandidates.bind(service)
  service.semanticCandidates=async args=>{
    const result=await discover(args)
    const ref=service.ledger.upsertSession({system:'codex',externalId:'newly-assigned',sourceKind:'app_server_thread',cwd:root})
    service.ledger.attachTaskSession(task.taskId,ref.sessionRefId,{relation:'executor'})
    return result
  }
  const result=await service.executeObjective({taskId:task.taskId,objective:'Continue work',workspacePath:root,requestId:'stale-discovery'},{codexMutationAuthority:true})
  assert.equal(result.code,'EXECUTION_TARGET_CHANGED',JSON.stringify(result))
  assert.equal(calls.length,0)
})

for (const explicit of [false,true]) test(`Codex continuation records the ${explicit?'requested':'native effective'} directory while preserving the Task project`,async t=>{
  const {service,root}=await fixture(t)
  const current=path.join(root,'current'),requested=path.join(root,'requested'),stale=path.join(root,'removed')
  mkdirSync(current);mkdirSync(requested)
  const project=service.ledger.upsertProject({canonicalPath:stale})
  const task=service.ledger.createTask({objective:'Continue native work',projectId:project.projectId,acceptance:['Verify']})
  const ref=service.ledger.upsertSession({system:'codex',externalId:'moved',sourceKind:'app_server_thread',cwd:stale})
  service.ledger.attachTaskSession(task.taskId,ref.sessionRefId,{relation:'executor'})
  const calls=adapter(service,stale),native=service.adapter.request
  service.threadEpochs.set('moved',service.adapter.connectionEpoch)
  service.adapter.request=async(method,params)=>{
    if(method==='thread/resume'){calls.push({method,params});return {cwd:current,runtimeWorkspaceRoots:[current,root],thread:{id:'moved',cwd:stale,status:{type:'idle'}}}}
    return native(method,params)
  }
  const result=await service.executeObjective({taskId:task.taskId,objective:task.objective,...(explicit?{workspacePath:requested}:{}),requestId:'moved'},{codexMutationAuthority:true})
  assert.equal(result.threadId,'moved',JSON.stringify(result))
  assert.equal(service.ledger.getTask(task.taskId).projectId,project.projectId)
  const expected=realpathSync(explicit?requested:current),turn=calls.find(call=>call.method==='turn/start')
  assert.equal(turn.params.cwd,expected);assert.equal(turn.params.runtimeWorkspaceRoots,undefined)
  assert.deepEqual(calls.find(call=>call.method==='thread/resume').params,{threadId:'moved',excludeTurns:true})
  const location=service.database.db.prepare('SELECT l.canonical_path FROM executions e JOIN project_locations l ON l.location_id=e.workspace_location_id WHERE e.execution_id=?').get(result.executions.at(-1).executionId)
  assert.equal(location.canonical_path,expected)
  const ownership=service.database.db.prepare(`SELECT b.workspace_location_id AS baselineLocation,e.workspace_location_id AS executionLocation,k.workspace_location_id AS leaseLocation,k.resource_key FROM executions e JOIN workspace_baselines b ON b.baseline_id=e.workspace_baseline_id JOIN leases k USING(execution_id) WHERE e.execution_id=?`).get(result.executions.at(-1).executionId)
  assert.equal(ownership.baselineLocation,ownership.executionLocation);assert.equal(ownership.leaseLocation,ownership.executionLocation)
  assert.equal(ownership.resource_key,`workspace:${expected}`)
  assert.equal(service.buildCandidates({taskId:task.taskId,objective:task.objective})[0].cwd,expected)
})

test('Codex forks preserve native workspace roots and use the effective source directory',async t=>{
  const {service,root}=await fixture(t)
  const current=path.join(root,'current'),extra=path.join(root,'extra');mkdirSync(current);mkdirSync(extra)
  const old=await history(service,'codex','source',root,'Try another approach')
  const calls=adapter(service,root);service.flags.set('routing.fork',true);service.flags.set('routing.resume',false)
  service.adapter.request=async(method,params)=>{
    calls.push({method,params})
    if(method==='thread/read')return {thread:{id:'source',cwd:root,status:{type:'idle'},turns:[{id:'boundary',status:'completed'}]}}
    if(method==='thread/resume')return {cwd:current,runtimeWorkspaceRoots:[current,extra],thread:{id:'source',cwd:root,status:{type:'idle'}}}
    if(method==='thread/fork')return {cwd:current,runtimeWorkspaceRoots:[current,extra],thread:{id:'fork',forkedFromId:'source',cwd:current,status:{type:'idle'}}}
    if(method==='turn/start')return {turn:{id:'fork-turn',status:'inProgress'}}
    throw Error(`Unexpected ${method}`)
  }
  const result=await service.executeObjective({sessionTaskId:old.session_task_id,objective:'Try another approach',sessionAction:'fork',requestId:'native-roots'},{codexMutationAuthority:true})
  assert.equal(result.threadId,'fork',JSON.stringify(result))
  const fork=calls.find(call=>call.method==='thread/fork').params
  assert.deepEqual(fork.runtimeWorkspaceRoots,[current,extra]);assert.equal(fork.cwd,realpathSync(current))
  assert.equal(fork.lastTurnId,'boundary');assert.equal(fork.deferGoalContinuation,true)
  assert.equal(calls.at(-1).params.runtimeWorkspaceRoots,undefined)
  assert.equal(service.isCodexMutationAuthorized('thread/resume'),true)
})

test('a fork reply naming a different parent never starts a turn',async t=>{
  const {service,root}=await fixture(t),old=await history(service,'codex','source',root,'Fork work')
  const calls=adapter(service,root),native=service.adapter.request;service.flags.set('routing.fork',true)
  service.adapter.request=async(method,params)=>{
    if(method==='thread/read'){calls.push({method,params});return {thread:{id:'source',cwd:root,turns:[{id:'boundary',status:'completed'}]}}}
    if(method==='thread/fork'){calls.push({method,params});return {cwd:root,runtimeWorkspaceRoots:[root],thread:{id:'fork',forkedFromId:'unrelated',cwd:root}}}
    return native(method,params)
  }
  const result=await service.executeObjective({sessionTaskId:old.session_task_id,objective:'Fork work',sessionAction:'fork',requestId:'bad-parent'},{codexMutationAuthority:true})
  assert.equal(result.executions.at(-1).dispatch.uncertain,1)
  assert.equal(calls.some(call=>call.method==='turn/start'),false)
})

for (const state of [{canAcceptDirectInput:false},{status:{type:'systemError'}},{ephemeral:true}]) test(`Codex refuses a native source with ${JSON.stringify(state)}`,async t=>{
  const {service,root}=await fixture(t),calls=adapter(service,root)
  service.adapter.request=async(method,params)=>{calls.push({method,params});return {thread:{id:'restricted',cwd:root,turns:[],...state}}}
  const result=await service.executeObjective({sessionId:'restricted',sourceSystem:'codex',intent:'continue',objective:'Continue',requestId:'restricted'},{codexMutationAuthority:true})
  assert.equal(result.blocked,true);assert.deepEqual(calls.map(call=>call.method),['thread/read'])
})

test('native settings becoming busy during resume prevent turn delivery',async t=>{
  const {service,root}=await fixture(t),calls=adapter(service,root),native=service.adapter.request
  service.adapter.request=async(method,params)=>{
    if(method==='thread/resume'){calls.push({method,params});return {cwd:root,runtimeWorkspaceRoots:[root],thread:{id:params.threadId,status:{type:'active'}}}}
    return native(method,params)
  }
  const result=await service.executeObjective({sessionId:'busy-after-read',sourceSystem:'codex',intent:'continue',objective:'Continue',requestId:'race'},{codexMutationAuthority:true})
  assert.equal(result.code,'EXECUTION_SESSION_BUSY');assert.equal(calls.some(call=>call.method==='turn/start'),false)
})

test('an unreadable empty native thread blocks adoption without starting or replacing it',async t=>{
  const {service,root}=await fixture(t),calls=adapter(service,root)
  service.threadEpochs.set('empty',service.adapter.connectionEpoch)
  service.adapter.request=async(method,params)=>{calls.push({method,params});throw Object.assign(Error('thread is not materialized yet'),{code:-32600})}
  const result=await service.executeObjective({sessionId:'empty',sourceSystem:'codex',intent:'continue',objective:'First message',requestId:'empty'},{codexMutationAuthority:true})
  assert.equal(result.code,'CODEX_THREAD_UNAVAILABLE');assert.deepEqual(calls.map(call=>call.method),['thread/read'])
})

test('Codex close and unloaded notifications invalidate local thread ownership',async t=>{
  const {service}=await fixture(t)
  for(const notification of [{method:'thread/closed',params:{threadId:'thread'}},{method:'thread/deleted',params:{threadId:'thread'}},{method:'thread/status/changed',params:{threadId:'thread',status:{type:'notLoaded'}}}]){
    service.threadEpochs.set('thread',service.adapter.connectionEpoch)
    assert.equal(service.projectCodexNotification(notification),true)
    assert.equal(service.threadEpochs.has('thread'),false)
  }
})

for(const ambiguous of [false,true]) test(`Codex cancellation ${ambiguous?'rejects ambiguous executors':'ignores fork sources and interaction references'}`,async t=>{
  const {service,root}=await fixture(t),calls=adapter(service,root)
  const task=service.ledger.createTask({objective:'Stop worker',acceptance:['Verify']})
  const run=service.ledger.planExecution({taskId:task.taskId,executorKind:'codex',method:'turn/start',params:{threadId:'executor'},dispatch:false,mutatesWorkspace:false})
  service.ledger.transitionExecution(run.executionId,'running')
  const refs=[['codex','source','app_server_thread','fork_source'],['dsh','main','app_server_thread','interaction'],['codex','executor','app_server_thread','executor'],['codex','turn','app_server_turn','executor']]
  if(ambiguous)refs.push(['codex','other','app_server_thread','executor'])
  for(const [system,id,sourceKind,role] of refs){const ref=service.ledger.upsertSession({system,externalId:id,sourceKind,cwd:root});service.ledger.attachExecutionSession(run.executionId,ref.sessionRefId,{role})}
  service.adapter.request=async(method,params)=>{calls.push({method,params});return {}}
  if(ambiguous){await assert.rejects(service.cancelWorker(run.executionId,{operator:true}),/outcome is unknown/);assert.equal(calls.length,0)}
  else{await service.cancelWorker(run.executionId,{operator:true});assert.deepEqual(calls,[{method:'turn/interrupt',params:{threadId:'executor',turnId:'turn'}}]);assert.equal(service.database.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(run.executionId).execution_state,'reconciling')}
})

test('reconciliation subscribes to the exact running thread and rechecks its turn after resume',async t=>{
  const {service,root}=await fixture(t),calls=adapter(service,root)
  const task=service.ledger.createTask({objective:'Reconnect',acceptance:['Verify']})
  const run=service.ledger.planExecution({taskId:task.taskId,executorKind:'codex',method:'turn/start',params:{threadId:'executor'},dispatch:false,mutatesWorkspace:false})
  service.ledger.transitionExecution(run.executionId,'running');service.ledger.transitionExecution(run.executionId,'reconciling')
  for(const [externalId,sourceKind] of [['executor','app_server_thread'],['turn','app_server_turn']]){
    const ref=service.ledger.upsertSession({system:'codex',externalId,sourceKind,cwd:root});service.ledger.attachExecutionSession(run.executionId,ref.sessionRefId,{role:'executor'})
  }
  service.adapter.request=async(method,params)=>{calls.push({method,params});return {thread:{id:'executor',turns:[{id:'turn',status:method==='thread/resume'?'completed':'inProgress'}]}}}
  const result=await service.reconcileExecutions()
  assert.equal(result.terminal,1)
  assert.deepEqual(calls,[{method:'thread/read',params:{threadId:'executor',includeTurns:true}},{method:'thread/resume',params:{threadId:'executor',excludeTurns:false}}])
})

test('a lost Codex connection marks live work for reconciliation and retains its workspace hold',async t=>{
  const {service,root}=await fixture(t)
  const task=service.ledger.createTask({objective:'Reconnect running work',acceptance:['Verify']})
  const project=service.ledger.upsertProject({canonicalPath:root})
  const location=service.database.db.prepare('SELECT location_id FROM project_locations WHERE project_id=?').get(project.projectId)
  const lease=service.ledger.acquireLease({resourceKey:`workspace:${root}`,locationId:location.location_id,ttlMs:60000})
  const run=service.ledger.planExecution({taskId:task.taskId,executorKind:'codex',method:'turn/start',params:{threadId:'thread'},dispatch:false,mutatesWorkspace:false,leaseId:lease.leaseId})
  service.ledger.transitionExecution(run.executionId,'running')
  service.threadEpochs.set('thread',service.adapter.connectionEpoch)
  service.adapter.emit('disconnected',{connectionEpoch:service.adapter.connectionEpoch})
  await Promise.all(service.inFlightOperations)
  assert.equal(service.threadEpochs.size,0)
  assert.equal(service.database.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(run.executionId).execution_state,'reconciling')
  assert.equal(service.database.db.prepare('SELECT lease_state FROM leases WHERE lease_id=?').get(lease.leaseId).lease_state,'recovery_hold')
})


test('an explicit Codex directory replaces a removed native directory on the same thread',async t=>{
  const {service,root}=await fixture(t),removed=path.join(root,'removed'),requested=path.join(root,'requested')
  mkdirSync(requested)
  const old=await history(service,'codex','moved-native',removed,'Continue existing work')
  const calls=adapter(service,removed)
  const result=await service.executeObjective({sessionTaskId:old.session_task_id,objective:'Continue',workspacePath:requested,requestId:'replace-removed'},{codexMutationAuthority:true})
  assert.equal(result.threadId,'moved-native',JSON.stringify(result))
  assert.deepEqual(calls.map(call=>call.method),['thread/read','thread/read','thread/resume','turn/start'])
  assert.equal(calls.at(-1).params.cwd,realpathSync(requested))
})

test('invalid Codex requested directories never resume, switch or dispatch',async t=>{
  const {service,root}=await fixture(t)
  const old=await history(service,'codex','original',root,'Continue existing work'),calls=adapter(service,root)
  const file=path.join(root,'file');writeFileSync(file,'content')
  for(const workspacePath of [path.join(root,'missing'),file])await assert.rejects(service.executeObjective({sessionTaskId:old.session_task_id,objective:'Continue',workspacePath,requestId:workspacePath},{codexMutationAuthority:true}),/ENOENT|existing directory/)
  assert.equal(calls.every(call=>call.method==='thread/read'),true)
  assert.equal(service.database.db.prepare('SELECT COUNT(*) AS n FROM executions').get().n,0)
})


test('an explicit DSH directory replaces a removed native directory on the same session',async t=>{
  const {service,root}=await fixture(t),f=dshDirectoryFixture(service,root,{cold:true,child:true})
  rmSync(f.current,{recursive:true})
  const result=await service.executeObjective({taskId:f.task.taskId,objective:'Continue',workspacePath:f.next,mutatesWorkspace:true,requestId:'replace-removed-dsh'},{agent:f.main})
  assert.equal(result.childId,f.worker.session.id,JSON.stringify(result))
  assert.deepEqual(f.calls,[['set',f.worker.session.id,f.next],['deliver',f.next]])
})

for (const roots of ['empty','restricted']) test(`DSH continuation applies the ${roots} shared allowlist before switching or delivering`, async t => {
  const {service,root}=await fixture(t)
  const f=dshDirectoryFixture(service,root)
  service.updateRuntimeSettings({allowedWorkspaceRoots:roots==='empty'?[]:[f.next]})
  if(roots==='restricted') {
    await assert.rejects(service.executeObjective({taskId:f.task.taskId,objective:'Continue',requestId:'deny-current'},{agent:f.main}),{code:'WORKER_WORKSPACE_NOT_ALLOWED'})
    assert.deepEqual(f.calls,[])
  }
  const directory=roots==='empty'?f.current:f.next
  const result=await service.executeObjective({taskId:f.task.taskId,objective:'Continue',requestId:'allow-current',...(roots==='restricted'?{workspacePath:directory}:{})},{agent:f.main})
  assert.equal(result.childId,f.worker.session.id)
  assert.deepEqual(f.calls.at(-1),['deliver',directory])
  const location=service.database.db.prepare('SELECT l.canonical_path FROM executions e JOIN project_locations l ON l.location_id=e.workspace_location_id WHERE execution_id=?').get(result.executionId)
  assert.equal(location.canonical_path,directory)
})

test('a new DSH worker outside the shared allowlist never starts and does not fall back',async t=>{
  const {service,root}=await fixture(t)
  const allowed=path.join(root,'allowed');mkdirSync(allowed)
  service.updateRuntimeSettings({allowedWorkspaceRoots:[allowed]})
  let started=0
  service.context={workspaceController:{initializeDefault:async()=>({workspace:{path:root}})},subagents:{startActivation:async()=>{started++;throw new Error('unexpected start')}}}
  for(const explicit of [false,true])await assert.rejects(service.executeObjective({objective:'New task',intent:'new',requestId:`deny-${explicit}`,...(explicit?{workspacePath:root}:{})},{agent:{session:{id:'main',seq:0,header:{cwd:root}}}}),{code:'WORKER_WORKSPACE_NOT_ALLOWED'})
  assert.equal(started,0)
  assert.equal(service.database.db.prepare('SELECT COUNT(*) AS n FROM executions').get().n,0)
})

test('a new Codex worker uses its native configured default and records the exact dispatched directory',async t=>{
  const {service,root}=await fixture(t,{defaultWorkerPriority:'codex',allowedWorkspaceRoots:[]})
  const calls=adapter(service,root),native=service.adapter.request
  const configured=path.join(root,'codex-projectless')
  service.adapter.request=async(method,params)=>{
    if(method==='config/read')return {config:{desktop:{projectlessWorkspaceRoot:configured}}}
    if(method==='configRequirements/read')return {requirements:null}
    if(method==='thread/start'){calls.push({method,params});return {cwd:params.cwd,thread:{id:'new-default',cwd:params.cwd}}}
    return native(method,params)
  }
  const result=await service.executeObjective({objective:'Build a report',intent:'new',requestId:'native-default'},{codexMutationAuthority:true,callerWorkspaceRoot:root})
  const start=calls.find(call=>call.method==='thread/start'),turn=calls.find(call=>call.method==='turn/start')
  assert.match(start.params.cwd,new RegExp(`${configured}/\\d{4}-\\d{2}-\\d{2}/build-a-report$`))
  assert.equal(turn.params.cwd,start.params.cwd)
  assert.deepEqual(start.params.runtimeWorkspaceRoots,[start.params.cwd])
  const execution=result.executions.at(-1)
  const saved=service.database.db.prepare(`SELECT l.canonical_path,b.workspace_location_id AS baseline_location,e.workspace_location_id,l.canonical_path,k.resource_key FROM executions e JOIN project_locations l ON l.location_id=e.workspace_location_id JOIN workspace_baselines b ON b.baseline_id=e.workspace_baseline_id JOIN leases k USING(execution_id) WHERE execution_id=?`).get(execution.executionId)
  assert.equal(saved.canonical_path,turn.params.cwd)
  assert.equal(saved.baseline_location,saved.workspace_location_id)
  assert.equal(saved.resource_key,`workspace:${turn.params.cwd}`)
})

test('Codex continuation applies the latest allowlist to the effective directory before any turn',async t=>{
  const {service,root}=await fixture(t)
  const allowed=path.join(root,'allowed');mkdirSync(allowed)
  const old=await history(service,'codex','outside-thread',root,'Continue an existing task')
  const calls=adapter(service,root)
  service.updateRuntimeSettings({allowedWorkspaceRoots:[allowed]})
  await assert.rejects(service.executeObjective({sessionTaskId:old.session_task_id,objective:'Continue',requestId:'deny-native'},{codexMutationAuthority:true}),{code:'WORKER_WORKSPACE_NOT_ALLOWED'})
  assert.equal(calls.some(call=>['thread/start','thread/fork','turn/start'].includes(call.method)),false)
  service.updateRuntimeSettings({allowedWorkspaceRoots:[]})
  const result=await service.executeObjective({sessionTaskId:old.session_task_id,objective:'Continue',requestId:'allow-native'},{codexMutationAuthority:true})
  assert.equal(result.threadId,'outside-thread')
  assert.equal(calls.at(-1).params.cwd,realpathSync(root))
})
