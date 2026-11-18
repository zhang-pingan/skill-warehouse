import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fixture } from './helpers.js'
import { resolveWorkerPolicy } from '../lib/worker-policy.js'
import { PersonalAgentService } from '../lib/service.js'
import { resolveConfig } from '../lib/config.js'
import { managedAnalysis } from '../lib/managed-analysis.js'

function attempt(f, taskId, stepId = null) {
  const item = f.ledger.planExecution({ taskId, stepId, executorKind: 'internal', method: 'internal/verify', params: {}, dispatch: false })
  f.ledger.transitionExecution(item.executionId, 'running')
  f.ledger.transitionExecution(item.executionId, 'succeeded')
  const evidenceId = f.ledger.ingestSource({ sourceSystem: 'dsh', sourceKind: 'verification', sourceUri: 'dsh://review', sourceLocator: item.executionId, sourceIdentity: '1', text: 'Observed verification output', taskId, executionId: item.executionId }).evidenceId
  return { ...item, evidenceId }
}

test('all current criteria are required and a new attempt invalidates old task acceptance', () => {
  const f = fixture()
  try {
    const task = f.ledger.createTask({ objective: 'Two requirements', state: 'active', acceptance: ['Tests pass','Artifact exists'] })
    const first = attempt(f, task.taskId)
    const accept = (execution, criterionId) => f.ledger.recordAcceptance(execution.executionId, { state: 'passed', criterionId, evidenceIds: [execution.evidenceId] })
    accept(first, '0')
    assert.throws(() => f.ledger.transitionTask(task.taskId, 'completed', f.ledger.getTask(task.taskId).state), /every current criterion/)
    for (let count = 0; count < 70; count++) accept(first, '1')
    assert.deepEqual(f.ledger.getTask(task.taskId).acceptance, ['Tests pass','Artifact exists'])
    const second = attempt(f, task.taskId)
    assert.throws(() => f.ledger.transitionTask(task.taskId, 'completed', f.ledger.getTask(task.taskId).state), /acceptance evidence/)
    accept(second, '0'); accept(second, '1')
    assert.equal(f.ledger.transitionTask(task.taskId, 'completed', f.ledger.getTask(task.taskId).state).state, 'completed')
  } finally { f.close() }
})

test('empty or forged definition results cannot manufacture completion', () => {
  const f = fixture()
  try {
    for (const acceptance of [[], [{ kind: 'result', state: 'passed', evidenceIds: ['fake'] }]]) {
      const task = f.ledger.createTask({ objective: 'Unverified', state: 'active', acceptance })
      assert.throws(() => f.ledger.transitionTask(task.taskId, 'completed', task.state), /acceptance evidence/)
    }
  } finally { f.close() }
})

test('steps block dependent dispatch until evidence-backed verification completes', () => {
  const f = fixture()
  try {
    const task = f.ledger.createTask({ objective: 'Repair then validate', state: 'active', acceptance: ['Deliver verified result'] })
    const first = f.ledger.createTaskStep(task.taskId, { objective: 'Repair' })
    const next = f.ledger.createTaskStep(task.taskId, { objective: 'Validate', dependencies: [first.stepId] })
    assert.throws(() => attempt(f, task.taskId, next.stepId), /dependencies/)
    const result = attempt(f, task.taskId, first.stepId)
    assert.throws(() => f.ledger.transitionTaskStep(task.taskId, first.stepId, 'completed'), /acceptance evidence/)
    f.ledger.recordAcceptance(result.executionId, { state: 'passed', evidenceIds: [result.evidenceId] })
    f.ledger.transitionTaskStep(task.taskId, first.stepId, 'completed')
    assert.ok(attempt(f, task.taskId, next.stepId).executionId)
  } finally { f.close() }
})

test('expired writer ownership and nested workspaces remain blocked until reconciliation', () => {
  const f = fixture()
  try {
    const subdir = path.join(f.root, 'nested'); mkdirSync(subdir)
    const root = f.ledger.upsertProject({ canonicalPath: f.root })
    const child = f.ledger.upsertProject({ canonicalPath: subdir })
    const lease = f.ledger.acquireLease({ resourceKey: `workspace:${f.root}`, locationId: root.locationId })
    f.database.db.prepare("UPDATE leases SET expires_at='2000-01-01T00:00:00.000Z' WHERE lease_id=?").run(lease.leaseId)
    assert.throws(() => f.ledger.acquireLease({ resourceKey: `workspace:${subdir}`, locationId: child.locationId }), /blocked/)
    assert.throws(() => f.ledger.acquireLease({ resourceKey: `workspace:${f.root}`, locationId: root.locationId }), /blocked/)
    assert.equal(f.database.db.prepare('SELECT lease_state FROM leases WHERE lease_id=?').get(lease.leaseId).lease_state,'recovery_hold')
    f.ledger.releaseLease(lease.leaseId, 'process_dead')
    assert.ok(f.ledger.acquireLease({ resourceKey: `workspace:${subdir}`, locationId: child.locationId }).leaseId)
  } finally { f.close() }
})

test('mixed temporary conversation fragments preserve project facts without recalling weather', () => {
  const f = fixture()
  try {
    const project = f.ledger.upsertProject({ canonicalPath: f.root })
    const task = f.ledger.createTask({ objective: 'Project history', projectId: project.projectId })
    f.ledger.ingestSource({ sourceSystem: 'dsh', sourceKind: 'message', sourceUri: 'dsh://mixed', sourceLocator: 'seq:1', sourceIdentity: '1', text: '今天天气晴朗。项目用途是管理本地知识。', taskId: task.taskId })
    assert.equal(f.ledger.search('天气').length, 0)
    assert.equal(f.ledger.search('知识').length, 1)
    assert.equal(f.ledger.search('天气', { includeTemporary: true }).length, 1)
    assert.equal(f.ledger.search('天气 知识', { includeTemporary: true }).length, 0)
  } finally { f.close() }
})

test('backend, DSH preset and model rules resolve independently and preserve Codex fields', () => {
  const f = fixture({ codexWorkerEnabled:true, modelPolicies: { code: { worker: 'codex', model: 'configured-model', effort: 'high' } }, workerRules: [
    { id: 'plugin', keywords: ['plugin'], capabilities: [], worker: 'dsh_subagent', agentPreset: 'cordis' },
    { id: 'code', keywords: [], capabilities: [], worker: 'codex', modelPolicy: 'code' },
  ] })
  try {
    const available = { codex: true, dsh_subagent: true }
    assert.equal(resolveWorkerPolicy(f.config, { objective: 'Build a plugin', worker:'dsh_subagent',agentPreset:'cordis' }, available).agentPreset, 'cordis')
    const codex = resolveWorkerPolicy(f.config, { objective: 'Implement parser' }, available)
    assert.equal(codex.worker, 'codex')
    assert.equal(codex.model.model, 'configured-model')
    assert.equal(Object.hasOwn(codex, 'agentPreset'), false)
    assert.throws(() => resolveWorkerPolicy(f.config, { objective: 'Implement parser', worker: 'codex', agentPreset: 'standard' }, available), /新建 worker/)
  } finally { f.close() }
})

test('configuration rejects incompatible model policies and unsafe heartbeat timing at load', () => {
  assert.throws(()=>resolveConfig({modelPolicies:{broken:{worker:'codex'}}}),/Invalid model/)
  assert.throws(()=>resolveConfig({workerRules:[{id:'a',worker:'dsh_subagent',keywords:[],capabilities:[],modelPolicy:'missing'}]}),/missing or incompatible/)
  assert.throws(()=>resolveConfig({workerHeartbeatMs:60000,leaseTtlMs:60000}),/less than half/)
  assert.throws(()=>resolveConfig({memoryExtractionEnabled:'maybe'}),/Boolean/)
  assert.throws(()=>resolveConfig({importIntervalMs:1}),/integer from/)
})

test('model analysis rejects partial JSON from a failed recorded turn', async () => {
  const context={agents:{async create(){return{agent:{},async dispose(){}}}},agentPresets:{mount(){}},subagents:{async startActivation(){return{result:Promise.resolve({stopReason:'error',output:[{type:'text',text:'{}'}]}),async dispose(){}}}},sessionPersistence:{async flush(){}}}
  await assert.rejects(managedAnalysis(context,{purpose:'failure-fixture',instructions:'Return JSON',input:{},budgetMs:10000,maxInputChars:1000,maxOutputChars:1000}),/did not complete successfully/)
})

test('internal begin bookkeeping alone cannot be submitted as completed work', async()=>{
  const f=fixture();const service=new PersonalAgentService(f.config)
  await service.initialize()
  const agent={session:{id:'bookkeeping',seq:0}}
  try{
    const execution=await service.executeObjective({worker:'internal',mutatesWorkspace:false,objective:'Actually inspect the project',requestId:'bookkeeping'},{agent})
    agent.session.seq=2
    const events=[{seq:0,type:'tool/call',data:{name:'personal_agent',callId:'begin'}},{seq:1,type:'tool/result',data:{message:{source:{kind:'tool',callId:'begin'},content:[{type:'text',text:'Execution started'}]}}}]
    service.context={sessionPersistence:{async flush(){},async open(){return{async read(offset,limit){return{events:events.slice(offset,offset+limit)}},async close(){}}}}}
    await assert.rejects(service.finishInternalExecution({executionId:execution.executionId,output:'Trust me'},{agent}),/requires recorded Session work/)
    assert.equal(service.ledger.getTask(execution.taskId).state,'active')
  }finally{await service.dispose();f.close()}
})

test('workspace recovery retains hold until an authenticated inspection and never declares success',async()=>{
  const f=fixture();const service=new PersonalAgentService(f.config)
  await service.initialize()
  const agent={session:{id:'recovery-user',seq:0}}
  try{
    const execution=await service.executeObjective({worker:'internal',workspacePath:f.root,objective:'Repair project',requestId:'recovery'},{agent})
    service.cancelInternalExecution(execution.executionId,{agent})
    await assert.rejects(service.reconcileNativeExecution({executionId:execution.executionId,proof:'quiescent',acceptanceSummary:'Inspected changed files'}),/authenticated operator/)
    await service.reconcileNativeExecution({executionId:execution.executionId,proof:'quiescent',acceptanceSummary:'Inspected changed files and stopped the native work'},{operator:true})
    assert.equal(service.database.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(execution.executionId).execution_state,'interrupted')
    assert.equal(service.database.db.prepare('SELECT lease_state FROM leases WHERE execution_id=?').get(execution.executionId).lease_state,'released')
    assert.notEqual(service.ledger.getTask(execution.taskId).state,'completed')
  }finally{await service.dispose();f.close()}
})

test('quality counts all declared criteria rather than only submitted results',async()=>{
  const f=fixture();const service=new PersonalAgentService(f.config);await service.initialize()
  try{
    const task=service.ledger.createTask({objective:'Deliver two outcomes',state:'active',acceptance:['One','Two']})
    const result=attempt({ledger:service.ledger},task.taskId)
    service.ledger.recordAcceptance(result.executionId,{state:'passed',criterionId:'0',evidenceIds:[result.evidenceId]})
    assert.equal(service.executionEvaluation().quality.verifiedExecutionCount,0)
    assert.equal(service.executionEvaluation().quality.acceptancePassRate,0.5)
    assert.equal(service.executionEvaluation().quality.pending,1)
    service.ledger.recordAcceptance(result.executionId,{state:'passed',criterionId:'1',evidenceIds:[result.evidenceId]})
    assert.equal(service.executionEvaluation().quality.verifiedExecutionCount,1)
  }finally{await service.dispose();f.close()}
})

test('repository paths remain case-sensitive for hosts without known case folding',()=>{
  const f=fixture()
  try{
    const one=path.join(f.root,'One');const two=path.join(f.root,'Two')
    for(const [dir,remote] of [[one,'ssh://git@example.test/Team/Repo.git'],[two,'ssh://git@example.test/team/repo.git']]){mkdirSync(path.join(dir,'.git'),{recursive:true});writeFileSync(path.join(dir,'.git','config'),'[remote "origin"]\nurl = '+remote+'\n')}
    assert.notEqual(f.ledger.upsertProject({canonicalPath:one}).projectId,f.ledger.upsertProject({canonicalPath:two}).projectId)
  }finally{f.close()}
})

test('request identity rejects changed acceptance or preset and survives a completed native dispatch',async()=>{
  const f=fixture();const service=new PersonalAgentService(f.config);await service.initialize()
  const agent={session:{id:'same-request',seq:0}}
  const request={worker:'internal',mutatesWorkspace:false,objective:'Track one goal',requestId:'stable-id',acceptance:['One']}
  try{
    const first=await service.executeObjective(request,{agent})
    const again=await service.executeObjective(request,{agent})
    assert.equal(again.executionId,first.executionId)
    assert.equal(again.repeated,true)
    await assert.rejects(service.executeObjective({...request,acceptance:['Different']},{agent}),/already bound/)
    const blocked=await service.executeObjective({...request,requestId:'second-id'},{agent})
    assert.equal(blocked.code,'EXECUTION_SESSION_BUSY')
    assert.equal(blocked.waiting,true)
    assert.equal(service.database.db.prepare('SELECT COUNT(*) AS n FROM executions').get().n,1)
  }finally{await service.dispose();f.close()}
})


test('step execution uses its persisted criteria and rejects request-only replacements', async () => {
  const f=fixture();const service=new PersonalAgentService(f.config);await service.initialize()
  const agent={session:{id:'step-user',seq:0}}
  try{
    const task=service.ledger.createTask({objective:'Deliver parent',state:'active',acceptance:['Parent outcome']})
    const step=service.ledger.createTaskStep(task.taskId,{objective:'Inspect child',acceptance:['Child observation']})
    assert.deepEqual(service.withExecutionCriteria({taskId:task.taskId,stepId:step.stepId}).acceptance,['Child observation'])
    await assert.rejects(service.executeObjective({worker:'internal',taskId:task.taskId,stepId:step.stepId,objective:'Inspect child',mutatesWorkspace:false,acceptance:['Easier replacement'],requestId:'changed-step'},{agent}),/match the persisted/)
    assert.equal(service.ledger.getTask(task.taskId).executions.length,0)
  }finally{await service.dispose();f.close()}
})


test('background jobs expose failures, join overlapping ticks, and preserve history after restart', async () => {
  const { BackgroundJobs }=await import('../lib/background-jobs.js')
  const f=fixture();let now=1000000000000;const jobs=new BackgroundJobs(f.database.db,()=>now)
  try{
    jobs.configure('history',true,1000)
    const work=Promise.withResolvers();let calls=0
    const running=jobs.run('history',()=>{calls+=1;return work.promise})
    assert.equal(jobs.run('history',()=>{throw Error('Duplicate')}),running)
    assert.equal(jobs.state('history').running,true)
    work.reject(Error('Source unavailable'))
    await assert.rejects(running,/unavailable/)
    assert.equal(calls,1)
    assert.equal(jobs.state('history').lastError,'Source unavailable')
    now+=1000
    await jobs.run('history',async()=>({warnings:['Partial history unreadable']}))
    assert.match(jobs.state('history').lastError,/unreadable/)
    now+=1000
    await jobs.run('history',async()=>({imported:2}))
    await assert.rejects(jobs.run('invalid-rejection',()=>Promise.reject(null)), value => value === null)
    assert.equal(jobs.state('invalid-rejection').running,false)
    assert.equal(jobs.state('invalid-rejection').lastError,'null')
    const restarted=new BackgroundJobs(f.database.db,()=>now)
    assert.equal(restarted.state('history').lastError,null)
    assert.equal(restarted.state('history').lastSuccessfulAt,new Date(now).toISOString())
    assert.equal(restarted.state('history').nextRunAt,null)
  }finally{f.close()}
})


test('Cordis validated configuration remains valid when apply resolves it again',()=>{
  const config=resolveConfig({historyRead:false})
  assert.deepEqual(resolveConfig(config),config)
})


test('cross-project candidates require clarification before an explicit task continues', async () => {
  const f=fixture({semanticRoutingEnabled:false});const service=new PersonalAgentService(f.config);await service.initialize()
  try{
    const first=await service.executeObjective({worker:'internal',objective:'Prepare the same durable report',mutatesWorkspace:false,requestId:'first'},{agent:{session:{id:'first-session',seq:0}}})
    const project=service.ledger.upsertProject({canonicalPath:f.root})
    service.ledger.createTask({objective:'Prepare the same durable report',projectId:project.projectId,acceptance:['Verify result']})
    const continued=await service.executeObjective({worker:'internal',objective:'Prepare the same durable report',mutatesWorkspace:false,requestId:'continued'},{agent:{session:{id:'second-session',seq:0}}})
    assert.equal(continued.clarificationRequired,true)
    assert.equal(service.buildCandidates({objective:'Prepare the same durable report'}).length,2)
    service.ledger.transitionExecution(first.executionId,'succeeded',{expectedState:'running'})
    const explicit=await service.executeObjective({worker:'internal',taskId:first.taskId,objective:'Prepare the same durable report',mutatesWorkspace:false,requestId:'explicit'},{agent:{session:{id:'second-session',seq:0}}})
    assert.equal(explicit.taskId,first.taskId)
    const other=await service.executeObjective({worker:'internal',objective:'Repair independent notification failure',mutatesWorkspace:false,requestId:'other'},{agent:{session:{id:'third-session',seq:0}}})
    assert.notEqual(other.taskId,first.taskId)
  }finally{await service.dispose();f.close()}
})
