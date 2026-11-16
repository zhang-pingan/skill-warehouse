import assert from 'node:assert/strict'
import test from 'node:test'
import { AnalysisOutputError, managedAnalysis } from '../lib/managed-analysis.js'
import { AnalysisRuns } from '../lib/analysis-runs.js'
import { DshHistoryImporter } from '../lib/dsh-history.js'
import { PersonalAgentService } from '../lib/service.js'
import { analysisLabels } from '../lib/analysis-labels.js'
import { fixture } from './helpers.js'

const options = { purpose:'memory-extraction', instructions:'Return source-backed JSON', input:{evidence:[{id:'one',text:'A durable fact'}]}, cwd:'/tmp', selection:{provider:'fixture',model:'model'}, budgetMs:10000, maxInputChars:1000, maxOutputChars:1000 }
function nativeFixture({ output='{}', stopReason='completed', deferred, disposal }={}) {
  const calls=[]
  const context={
    agents:{async create(spec){calls.push(['parent',spec]);return{agent:{id:'parent'},async dispose(){calls.push(['parent-disposed'])}}}},
    agentPresets:{mount(){}},
    subagents:{async startActivation(spec){calls.push(['child',spec]);return{
      result:deferred?.promise??Promise.resolve({stopReason,output:[{type:'text',text:output}]}),
      async dispose(){calls.push(['child-disposed']);if(disposal)await disposal.promise;deferred?.resolve({stopReason:'cancelled',output:[]})},
    }}},
    sessionPersistence:{async flush(){calls.push(['flushed'])}},
  }
  return{context,calls}
}

test('recorded analysis uses an owned blank coordinator and native caller-delivery child',async()=>{
  const f=nativeFixture();let reserved
  const result=await managedAnalysis(f.context,{...options,onSession:ids=>{reserved=ids;if(!ids.available)assert.equal(f.calls.length,0)}})
  assert.equal(result.sessionId,reserved.sessionId)
  assert.equal(result.parentSessionId,reserved.parentSessionId)
  const parent=f.calls.find(([name])=>name==='parent')[1]
  const child=f.calls.find(([name])=>name==='child')[1]
  assert.equal(parent.sessionId,result.parentSessionId)
  assert.equal(parent.meta.agentPreset,'minimal')
  assert.equal(child.childId,result.sessionId)
  assert.equal(child.delivery,'caller')
  assert.equal(child.agentPreset,'minimal')
  assert.deepEqual(child.agentOptions,{provider:'fixture',model:'model'})
  assert.ok(child.prompt[0].text.includes(JSON.stringify(options.input)))
  assert.deepEqual(f.calls.slice(-3).map(([name])=>name),['child-disposed','flushed','parent-disposed'])
})

test('cancellation joins child teardown before releasing its coordinator',async()=>{
  const deferred=Promise.withResolvers();const disposal=Promise.withResolvers()
  const f=nativeFixture({deferred,disposal});const lifetime=new AbortController()
  const started=Promise.withResolvers()
  const start=f.context.subagents.startActivation
  f.context.subagents.startActivation=async spec=>{const activation=await start(spec);started.resolve();return activation}
  const run=managedAnalysis(f.context,{...options,signal:lifetime.signal})
  const rejected=assert.rejects(run,/abort/i)
  await started.promise
  lifetime.abort()
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(f.calls.some(([name])=>name==='parent-disposed'),false)
  disposal.resolve();await rejected
  assert.equal(f.calls.filter(([name])=>name==='child-disposed').length,1)
  assert.equal(f.calls.at(-1)[0],'parent-disposed')
})

test('failed native startup releases the blank coordinator',async()=>{
  const f=nativeFixture();f.context.subagents.startActivation=async()=>{throw Error('Unable to start')}
  await assert.rejects(managedAnalysis(f.context,options),/Unable to start/)
  assert.equal(f.calls.at(-1)[0],'parent-disposed')
})

test('execution metadata is visible during work, excludes its logs from import, and succeeds after commit',async()=>{
  const f=fixture();const deferred=Promise.withResolvers();const native=nativeFixture({deferred})
  const runs=new AnalysisRuns(f.database.db,native.context)
  try{
    const operation=runs.run(options,()=>{
      assert.equal(runs.list(options.purpose)[0].state,'running')
      return{processed:1,memories:0,entities:0,relations:0}
    })
    const run=runs.list(options.purpose)[0]
    assert.equal(run.state,'running');assert.equal(run.inputCount,1)
    const importer=new DshHistoryImporter(f.ledger)
    for(const id of [run.sessionId,run.parentSessionId]) assert.equal(await importer.executionActivity({open(){assert.fail('Do not read analysis logs')}},{id}),null)
    deferred.resolve({stopReason:'completed',output:[{type:'text',text:'{}'}]})
    await operation
    const completed=runs.list(options.purpose)[0]
    assert.equal(completed.state,'succeeded');assert.equal(completed.result.processed,1)
    assert.ok(completed.finishedAt);assert.equal(completed.logAvailable,true)
  }finally{f.close()}
})

test('rejected sources mark the run failed and restart marks unfinished work interrupted',async()=>{
  const f=fixture();const native=nativeFixture();const runs=new AnalysisRuns(f.database.db,native.context)
  try{
    await assert.rejects(runs.run(options,()=>{throw Error('Quote does not match source')}),/Quote/)
    assert.equal(runs.list(options.purpose)[0].state,'failed')
    assert.match(runs.list(options.purpose)[0].error,/Quote/)
    f.database.db.prepare("UPDATE analysis_runs SET state='running',finished_at=NULL").run()
    const restarted=new AnalysisRuns(f.database.db,native.context)
    assert.equal(restarted.list(options.purpose)[0].state,'interrupted')
  }finally{f.close()}
})

test('extraction selects the configured background model and shutdown joins its direct run',async()=>{
  const f=fixture({backgroundModelPolicy:'background',modelPolicies:{background:{worker:'dsh_subagent',provider:'fixture',model:'extraction-model',effort:'off'}}})
  const deferred=Promise.withResolvers();const disposal=Promise.withResolvers()
  const native=nativeFixture({deferred,disposal})
  const service=new PersonalAgentService(f.config,{context:native.context});await service.initialize()
  try{
    service.ledger.ingestSource({sourceSystem:'dsh',sourceKind:'message',sourceUri:'dsh://fixture',sourceLocator:'seq:1',sourceIdentity:'one',text:'The project stores durable knowledge.'})
    const run=service.memory.run();const rejected=assert.rejects(run,/abort/i)
    await new Promise(resolve=>setImmediate(resolve))
    assert.equal(service.memoryExtractionView().running,true)
    assert.equal(service.analysisRuns.list('memory-extraction')[0].model.model,'extraction-model')
    const stopping=service.dispose()
    await new Promise(resolve=>setImmediate(resolve))
    assert.equal(service.database.closed,false)
    disposal.resolve();await rejected;await stopping
    assert.equal(service.database.closed,true)
  }finally{if(!service.database.closed)await service.dispose();f.close()}
})

test('input-budget rejection retains a failed record without a broken log entry',async()=>{
  const f=fixture();const native=nativeFixture();const runs=new AnalysisRuns(f.database.db,native.context)
  try{
    await assert.rejects(runs.run({...options,maxInputChars:1}),/input exceeds/)
    const run=runs.list(options.purpose)[0]
    assert.equal(run.state,'failed');assert.equal(run.logAvailable,false);assert.equal(run.sessionId,null)
    assert.equal(native.calls.length,0)
  }finally{f.close()}
})

test('native analysis labels prevent source re-import after local run records are cleared',async()=>{
  const f=fixture()
  try{
    const now=Date.now()
    const events=[{seq:0,time:now,type:'subagent/descriptor',data:{label:analysisLabels.extraction}},
      {seq:1,time:now,type:'user/message',surfaceOp:'append',data:{source:{kind:'user'},content:[{type:'text',text:'Source-backed extraction'}]}},
      {seq:2,time:now,type:'turn/start',data:{turn:1}}]
    const persistence={async open(){return{async read(offset,limit){return{events:events.slice(offset,offset+limit)}},async close(){}}}}
    const importer=new DshHistoryImporter(f.ledger)
    assert.equal(f.database.db.prepare('SELECT COUNT(*) AS n FROM analysis_runs').get().n,0)
    assert.equal(await importer.executionActivity(persistence,{id:'native-analysis',header:{origin:'subagent'}},async()=>{},{now}),null)
    assert.equal(await importer.executionActivity(persistence,{id:'ordinary-session',header:{}},async()=>{},{now}),now)
  }finally{f.close()}
})

test('an owning service cancellation stops generic analyses without a caller signal',async()=>{
  const f=fixture();const deferred=Promise.withResolvers();const native=nativeFixture({deferred});const lifetime=new AbortController()
  const runs=new AnalysisRuns(f.database.db,native.context,{signal:lifetime.signal})
  try{
    const run=runs.run({...options,purpose:'task-association'})
    const rejected=assert.rejects(run,/abort/i)
    await new Promise(resolve=>setImmediate(resolve))
    lifetime.abort();await rejected
    assert.equal(runs.list('task-association')[0].state,'cancelled')
    await assert.rejects(runs.run(options),/abort/i)
    assert.equal(runs.list('memory-extraction').length,0)
  }finally{f.close()}
})

test('manual extraction returns live status before the model completes and keeps browsing available', async () => {
  const f = fixture()
  const deferred = Promise.withResolvers()
  const native = nativeFixture({ deferred })
  const service = new PersonalAgentService(f.config, { context: native.context })
  try {
    await service.initialize()
    service.ledger.ingestSource({ sourceSystem: 'dsh', sourceKind: 'message', sourceUri: 'dsh://manual-extraction', sourceLocator: 'seq:1', sourceIdentity: 'one', text: 'Atlas uses SQLite for persistent records.' })
    const started = await service.manageMemory({ action: 'run-extraction' })
    assert.equal(started.running, true)
    assert.equal(started.runs.length, 0)
    assert.equal((await service.manageMemory({ action: 'list', type: 'experience' })).records.length, 1)
    assert.equal((await service.manageMemory({ action: 'run-extraction' })).runs.length, 0)
    deferred.resolve({ stopReason: 'completed', output: [{ type: 'text', text: '{"entities":[],"memories":[],"relations":[]}' }] })
    await service.memory.running
    assert.equal(service.memoryExtractionView().runs.length, 0)
  } finally {
    deferred.resolve({ stopReason: 'cancelled', output: [] })
    await service.dispose()
    f.close()
  }
})

test('analysis states the output budget in its recorded prompt and reports oversized results explicitly', async () => {
  const native = nativeFixture({ output: 'x'.repeat(1001) })
  await assert.rejects(managedAnalysis(native.context, options), error => error instanceof AnalysisOutputError && error.reason === 'too-large' && /exceeding the 1000 character output budget/.test(error.message))
  const prompt = native.calls.find(([name]) => name === 'child')[1].prompt[0].text
  assert.match(prompt, /JSON response must be at most 1000 characters/)
  const empty = nativeFixture({ output: '' })
  await assert.rejects(managedAnalysis(empty.context, options), error => error instanceof AnalysisOutputError && error.reason === 'empty')
})
