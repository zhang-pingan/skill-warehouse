import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtempSync,mkdirSync,realpathSync,rmSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {resolveConfig} from '../lib/config.js'
import {PersonalAgentService} from '../lib/service.js'
import {ExecutionResults} from '../lib/execution-results.js'

async function fixture(t) {
  const root=realpathSync(mkdtempSync(path.join(os.tmpdir(),'pac-dsh-startup-')))
  const workspace=path.join(root,'workspace')
  mkdirSync(workspace)
  const service=new PersonalAgentService(resolveConfig({dataDir:path.join(root,'data'),codexHome:path.join(root,'codex'),allowedWorkspaceRoots:[root],semanticRoutingEnabled:false}))
  await service.initialize()
  t.after(async()=>{await service.dispose();rmSync(root,{recursive:true,force:true})})
  const agent={id:'main',session:{id:'main',seq:1,header:{cwd:workspace}}}
  service.context={agents:new Map([[agent.id,agent]]),workingDirectory:{ensure:async()=>workspace},sessionPersistence:{stat:async()=>undefined},subagents:{}}
  service.recordDshUsage=async()=>{}
  const task=service.ledger.createTask({objective:'Build output',state:'active',acceptance:['Verify output']})
  const execute=(requestId,extra={})=>service.executeObjective({taskId:task.taskId,objective:'Build output',workspacePath:workspace,mutatesWorkspace:true,requestId,...extra},{agent})
  return {service,agent,workspace,task,execute,db:service.database.db}
}

for (const code of ['INVALID_AGENT_NAME','DUPLICATE_AGENT_NAME']) test(`${code} leaves no phantom executor and the same Task can retry`,async t=>{
  const {service,task,execute,db}=await fixture(t)
  const rejection=Object.assign(new Error('Native name admission rejected'),{name:'SubagentError',code})
  const calls=[]
  service.context.subagents.startActivation=async spec=>{
    calls.push(spec)
    if (calls.length===1) throw rejection
    return {childId:spec.childId,messageId:'accepted-message',result:Promise.resolve({stopReason:'completed',output:[]}),dispose:async()=>{}}
  }
  await assert.rejects(execute('invalid-name',{name:'任务'}),error=>error===rejection)
  const failed=db.prepare('SELECT execution_id,execution_state FROM executions').get()
  assert.equal(failed.execution_state,'failed')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_sessions WHERE relation='executor'").get().n,0)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM execution_sessions WHERE role='executor'").get().n,0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session_refs WHERE external_id=?').get(calls[0].childId).n,0)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM leases WHERE lease_state IN ('active','recovery_hold')").get().n,0)

  const recovery=new ExecutionResults(service,{stateOf(){throw new Error('A rejected name has no native session')}})
  recovery.state=async()=>{throw new Error('Failed startup must not enter native recovery')}
  await recovery.kick()
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM execution_results').get().n,0)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_sessions WHERE relation='executor'").get().n,0)

  const result=await execute('corrected-name',{name:'build-output'})
  assert.equal(result.taskId,task.taskId)
  assert.equal(result.stopReason,'completed')
  assert.equal(calls.length,2)
  assert.notEqual(calls[0].childId,calls[1].childId)
  assert.equal(service.buildCandidates({taskId:task.taskId})[0].sessionId,result.childId)
  assert.equal(db.prepare('SELECT message_id FROM dsh_execution_runs WHERE execution_id=?').get(result.executionId).message_id,'accepted-message')
  assert.deepEqual(db.prepare('SELECT execution_state FROM executions ORDER BY rowid').all().map(row=>row.execution_state),['failed','succeeded'])
})

test('unknown DSH startup retains its identity and lease while blocking another worker',async t=>{
  const {service,execute,db}=await fixture(t)
  const failure=new Error('Startup failed after possible admission')
  let childId,starts=0
  service.context.subagents.startActivation=async spec=>{starts++;childId=spec.childId;throw failure}
  await assert.rejects(execute('unknown-start'),error=>error===failure)
  assert.equal(db.prepare('SELECT execution_state FROM executions').get().execution_state,'reconciling')
  assert.equal(db.prepare('SELECT session_id FROM dsh_execution_runs').get().session_id,childId)
  assert.equal(db.prepare('SELECT lease_state FROM leases').get().lease_state,'recovery_hold')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_sessions WHERE relation='executor'").get().n,0)
  const retry=await execute('unknown-retry')
  assert.equal(retry.code,'EXECUTION_SESSION_BUSY')
  assert.equal(retry.waiting,true)
  assert.equal(starts,1)
})

test('a name-shaped ordinary error does not establish native pre-admission rejection',async t=>{
  const {service,execute,db}=await fixture(t)
  service.context.subagents.startActivation=async()=>{throw Object.assign(new Error('Invalid agent name'),{code:'INVALID_AGENT_NAME'})}
  await assert.rejects(execute('ordinary-error'),{code:'INVALID_AGENT_NAME'})
  assert.equal(db.prepare('SELECT execution_state FROM executions').get().execution_state,'reconciling')
  assert.equal(db.prepare('SELECT lease_state FROM leases').get().lease_state,'recovery_hold')
})

test('accepted DSH startup with failed local association keeps reconciliation and disposes its activation',async t=>{
  const {service,task,execute,db}=await fixture(t)
  let childId,disposed=0
  service.context.subagents.startActivation=async spec=>{
    childId=spec.childId
    return {childId,messageId:'accepted',result:Promise.resolve({stopReason:'completed',output:[]}),dispose:async()=>{disposed++}}
  }
  db.exec("CREATE TEMP TRIGGER reject_executor_link BEFORE INSERT ON execution_sessions WHEN NEW.role='executor' BEGIN SELECT RAISE(ABORT,'injected executor association failure'); END")
  await assert.rejects(execute('accepted-local-failure'),/injected executor association failure/)
  assert.equal(disposed,1)
  assert.equal(db.prepare('SELECT execution_state FROM executions').get().execution_state,'reconciling')
  assert.equal(db.prepare('SELECT session_id FROM dsh_execution_runs').get().session_id,childId)
  assert.equal(db.prepare('SELECT lease_state FROM leases').get().lease_state,'recovery_hold')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_sessions WHERE relation='executor'").get().n,0)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM execution_sessions WHERE role='executor'").get().n,0)
  db.exec('DROP TRIGGER reject_executor_link')
  assert.equal((await execute('accepted-local-retry')).code,'EXECUTION_SESSION_BUSY')

  const run=db.prepare('SELECT * FROM dsh_execution_runs').get()
  const recovery=new ExecutionResults(service,{})
  recovery.state=async id=>{
    assert.equal(id,childId)
    return {final:{executionId:run.execution_id,requestId:run.request_id,reason:'completed',text:'Native output',seq:3}}
  }
  await recovery.kick()
  assert.equal(db.prepare('SELECT execution_state FROM executions').get().execution_state,'succeeded')
  assert.equal(db.prepare('SELECT lease_state FROM leases').get().lease_state,'released')
  assert.equal(service.buildCandidates({taskId:task.taskId})[0].sessionId,childId)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_sessions WHERE relation='executor'").get().n,1)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM execution_sessions WHERE role='executor'").get().n,1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM execution_results').get().n,1)
  await recovery.kick()
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM execution_results').get().n,1)
})

test('an established DSH executor missing from native storage remains blocked',async t=>{
  const {service,task,execute,db}=await fixture(t)
  const session=service.ledger.upsertSession({system:'dsh',externalId:'existing-worker',sourceKind:'subagent',durability:'durable'})
  service.ledger.attachTaskSession(task.taskId,session.sessionRefId,{relation:'executor'})
  let starts=0
  service.context.subagents.startActivation=async()=>{starts++;throw new Error('Must not replace a missing existing worker')}
  const result=await execute('missing-established')
  assert.equal(result.code,'EXECUTION_SESSION_MISSING')
  assert.equal(starts,0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM executions').get().n,0)
  assert.equal(service.buildCandidates({taskId:task.taskId})[0].sessionId,'existing-worker')
})

for (const mode of ['spawn','session','subagent']) test(`terminal ${mode} recovery attaches only its confirmed native session`,async t=>{
  const {service,task,db}=await fixture(t)
  const previous=service.ledger.upsertSession({system:'dsh',externalId:'previous-worker',sourceKind:'subagent',durability:'durable'})
  service.ledger.attachTaskSession(task.taskId,previous.sessionRefId,{relation:'executor',confidence:0.8})
  const previousLink={...db.prepare('SELECT * FROM task_sessions WHERE session_ref_id=?').get(previous.sessionRefId)}
  const run=service.ledger.planExecution({taskId:task.taskId,executorKind:'dsh_subagent',method:mode==='spawn'?'subagent/start':mode==='session'?'session/prompt':'subagent/sendMessage',params:{},dispatch:false,mutatesWorkspace:false})
  service.ledger.transitionExecution(run.executionId,'running')
  db.prepare('INSERT INTO dsh_execution_runs(execution_id,session_id,request_id,start_seq,mode) VALUES(?,?,?,?,?)').run(run.executionId,'confirmed-worker','confirmed-request',0,mode)
  const recovery=new ExecutionResults(service,{})
  recovery.state=async()=>({final:{executionId:run.executionId,requestId:'unrelated-request',reason:'completed',text:'Another request',seq:2}})
  await recovery.kick()
  assert.equal(db.prepare('SELECT execution_state FROM executions').get().execution_state,'running')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM session_refs WHERE external_id='confirmed-worker'").get().n,0)
  recovery.state=async()=>({final:{executionId:run.executionId,requestId:'confirmed-request',reason:'completed',text:'Confirmed result',seq:3}})
  await recovery.kick()
  assert.equal(db.prepare('SELECT execution_state FROM executions').get().execution_state,'succeeded')
  assert.equal(service.buildCandidates({taskId:task.taskId})[0].sessionId,'confirmed-worker')
  assert.equal(db.prepare("SELECT source_kind FROM session_refs WHERE external_id='confirmed-worker'").get().source_kind,mode==='session'?'session':'subagent')
  assert.deepEqual({...db.prepare('SELECT * FROM task_sessions WHERE session_ref_id=?').get(previous.sessionRefId)},previousLink)
})

test('terminal recovery preserves established continuation metadata and association',async t=>{
  const {service,task,workspace,db}=await fixture(t)
  const session=service.ledger.upsertSession({system:'dsh',externalId:'original-worker',sourceKind:'session',cwd:workspace,durability:'durable',nativeStatus:'idle'})
  service.ledger.attachTaskSession(task.taskId,session.sessionRefId,{relation:'executor',confidence:0.8})
  const run=service.ledger.planExecution({taskId:task.taskId,executorKind:'dsh_subagent',method:'session/prompt',params:{},dispatch:false,mutatesWorkspace:false})
  service.ledger.attachExecutionSession(run.executionId,session.sessionRefId,{role:'executor',confidence:0.7})
  service.ledger.transitionExecution(run.executionId,'running')
  db.prepare('INSERT INTO dsh_execution_runs(execution_id,session_id,request_id,start_seq,mode) VALUES(?,?,?,?,?)').run(run.executionId,'original-worker','continue-request',0,'session')
  const before={session:{...db.prepare('SELECT * FROM session_refs WHERE session_ref_id=?').get(session.sessionRefId)},task:{...db.prepare('SELECT * FROM task_sessions').get()},execution:{...db.prepare('SELECT * FROM execution_sessions').get()}}
  const recovery=new ExecutionResults(service,{})
  recovery.state=async()=>({final:{executionId:run.executionId,requestId:'continue-request',reason:'completed',text:'Continued result',seq:3}})
  await recovery.kick()
  assert.equal(db.prepare('SELECT execution_state FROM executions').get().execution_state,'succeeded')
  assert.deepEqual({...db.prepare('SELECT * FROM session_refs WHERE session_ref_id=?').get(session.sessionRefId)},before.session)
  assert.deepEqual({...db.prepare('SELECT * FROM task_sessions').get()},before.task)
  assert.deepEqual({...db.prepare('SELECT * FROM execution_sessions').get()},before.execution)
})

test('terminal recovery does not overwrite a conflicting execution identity',async t=>{
  const {service,task,db}=await fixture(t)
  const session=service.ledger.upsertSession({system:'dsh',externalId:'linked-worker',sourceKind:'subagent',durability:'durable'})
  service.ledger.attachTaskSession(task.taskId,session.sessionRefId,{relation:'executor'})
  const run=service.ledger.planExecution({taskId:task.taskId,executorKind:'dsh_subagent',method:'subagent/start',params:{},dispatch:false,mutatesWorkspace:false})
  service.ledger.attachExecutionSession(run.executionId,session.sessionRefId,{role:'executor'})
  service.ledger.transitionExecution(run.executionId,'running')
  db.prepare('INSERT INTO dsh_execution_runs(execution_id,session_id,request_id,start_seq,mode) VALUES(?,?,?,?,?)').run(run.executionId,'different-worker','conflict-request',0,'spawn')
  const recovery=new ExecutionResults(service,{})
  recovery.state=async()=>({final:{executionId:run.executionId,requestId:'conflict-request',reason:'completed',text:'Conflicting identity',seq:3}})
  const attention=[]
  service.openAttention=entry=>attention.push(entry)
  await recovery.kick()
  assert.equal(db.prepare('SELECT execution_state FROM executions').get().execution_state,'running')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM session_refs WHERE external_id='different-worker'").get().n,0)
  assert.equal(service.buildCandidates({taskId:task.taskId})[0].sessionId,'linked-worker')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM execution_results').get().n,0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM evidence WHERE execution_id=?').get(run.executionId).n,0)
  assert.equal(attention.length,1)
  assert.equal(attention[0].kind,'worker_result_recovery')
})
