import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './helpers.js'
import { MemorySystem } from '../lib/memory-system.js'
import { AnalysisRuns } from '../lib/analysis-runs.js'

function setup(options={}) {
  const f=fixture(options)
  const service={ledger:f.ledger,database:f.database,config:f.config,historyLifetime:new AbortController(),backgroundModelSelection:()=>null}
  service.memory=new MemorySystem(service)
  const history=f.ledger.history
  const session=f.ledger.upsertSession({system:'dsh',externalId:'original-session',sourceKind:'dsh_persistence'})
  const stage=(text,index)=>history.stage({sessionRefId:session.sessionRefId,sourceSystem:'dsh',sourceKind:'message',sourceUri:'dsh://session/original-session',sourceLocator:`seq:${index}`,sourceIdentity:`version:${index}`,text,authorRole:index%2?'assistant':'user',occurredAt:`2026-01-01T00:00:${String(index).padStart(2,'0')}.000Z`,normalizedPayload:{seq:index}})
  return {...f,service,history,session,stage}
}
const description=(id,title)=>({id,title,goal:title,summary:title+' outcome remains unverified',state:'uncertain'})

test('ownership repair names omitted messages and publishes only the complete corrected response',async()=>{
  const f=setup();try{
    for(let i=0;i<4;i++)f.stage(`Project source ${i}`,i)
    f.history.complete(f.session.sessionRefId)
    let calls=0,missing
    f.service.analysisRuns={async run(options,commit){
      if(!options.input.messages)return commit({merges:[]})
      calls++
      assert.equal(f.history.list().records.length,0)
      const messages=options.input.messages
      if(calls===1)missing=messages[2].messageId
      else {assert.match(options.instructions,/previous output for this chunk was rejected/);assert.ok(options.instructions.includes(missing));assert.equal(options.input.tasks.length,0)}
      return commit({tasks:[description(calls===1?'new:rejected':'new:accepted',calls===1?'Rejected draft':'Complete task')],assignments:messages.filter((m,i)=>calls!==1||i!==2).map(m=>({messageId:m.messageId,taskIds:[calls===1?'new:rejected':'new:accepted'],status:'assigned'}))})
    }}
    await f.history.segmentNext()
    assert.equal(calls,2)
    assert.equal(f.history.coverage().sessionsPending,0)
    assert.deepEqual(f.history.list().records.map(r=>r.title),['Complete task'])
    assert.equal(f.history.get(f.history.list().records[0].id).messages.length,4)
  }finally{f.close()}
})

test('rejected ownership leaves earlier drafts intact and retries are bounded',async()=>{
  const f=setup({memoryExtractionRetryLimit:2});try{
    const tasks=new Map([['new:a',description('new:a','Original')]]),assignments=new Map()
    const messages=[{messageId:'first'},{messageId:'second'}]
    assert.throws(()=>f.history.acceptDraft({tasks:[description('new:a','Rejected change')],assignments:[{messageId:'first',taskIds:['new:a'],status:'assigned'},{messageId:'second',taskIds:['missing'],status:'assigned'}]},messages,tasks,assignments),/Invalid historical message ownership/)
    assert.equal(tasks.get('new:a').title,'Original');assert.equal(assignments.size,0)
    assert.throws(()=>f.history.acceptDraft({tasks:[],assignments:[{messageId:'first',taskIds:[],status:'no-task'},{messageId:'first',taskIds:[],status:'no-task'}]},messages,tasks,assignments),error=>error.details.duplicateMessageIds[0]==='first'&&error.details.missingMessageIds[0]==='second')
    f.stage('Request',0);f.history.complete(f.session.sessionRefId)
    let calls=0
    f.service.analysisRuns={async run(options,commit){calls++;return commit({tasks:[],assignments:[]})}}
    await f.history.segmentNext()
    assert.equal(calls,2)
    assert.equal(f.history.coverage().sessionsPending,1)
    assert.match(f.history.coverage().errors[0].last_error,/every input message exactly once/)
    assert.equal(f.database.db.prepare('SELECT COUNT(*) AS n FROM evidence').get().n,0)
  }finally{f.close()}
})

test('full snapshot publishes noncontiguous many-to-many ownership once, then reuses task ids incrementally',async()=>{
  const f=setup();try{
    const messages=['Build Aurora','Build Borealis','Continue Aurora','Compare both projects'].map(f.stage)
    assert.equal(f.database.db.prepare('SELECT COUNT(*) AS n FROM evidence').get().n,0)
    f.history.complete(f.session.sessionRefId,'Two projects')
    f.service.analysisRuns={async run(options,commit){
      if(!options.input.messages)return commit({merges:[]})
      assert.match(options.instructions,/zh-CN/)
      return commit({tasks:[description('new:a','Aurora'),description('new:b','Borealis')],assignments:options.input.messages.map((message,i)=>({messageId:message.messageId,taskIds:i===3?['new:a','new:b']:i===1?['new:b']:['new:a'],status:'assigned'}))})
    }}
    await f.history.segmentNext()
    assert.equal(f.history.coverage().sessionsPending,0)
    const tasks=f.history.list().records
    assert.equal(tasks.length,2)
    const a=tasks.find(t=>t.title==='Aurora'),b=tasks.find(t=>t.title==='Borealis')
    assert.equal(f.history.get(a.id).messages.length,3)
    assert.equal(f.history.get(b.id).messages.length,2)
    assert.equal(f.database.db.prepare('SELECT COUNT(*) AS n FROM evidence').get().n,4)
    assert.equal(f.database.db.prepare('SELECT COUNT(*) AS n FROM memory_extraction_jobs').get().n,0)
    assert.equal(f.history.list({query:'Compare',rawSearch:false}).records.length,0)
    assert.equal(f.history.list({query:'Compare',rawSearch:true}).records.length,2)
    assert.equal(f.history.list({query:'Compare',rawSearch:true,limit:1}).hasMore,true)
    const fifth=f.stage('Aurora follow-up',4);f.history.complete(f.session.sessionRefId)
    f.service.analysisRuns.run=async(options,commit)=>commit(options.input.messages?{tasks:[],assignments:[{messageId:fifth.messageId,taskIds:[a.id],status:'assigned'}]}:{merges:[]})
    await f.history.segmentNext()
    assert.equal(f.history.get(a.id).messages.length,4)
    assert.deepEqual(new Set(f.history.list().records.map(t=>t.id)),new Set([a.id,b.id]))
    assert.ok(messages.every(message=>f.database.db.prepare('SELECT staged_text FROM history_messages WHERE message_id=?').get(message.messageId).staged_text===null))
  }finally{f.close()}
})

test('incomplete ownership and concurrent source changes cannot publish a partial session',async()=>{
  const f=setup();try{
    f.stage('First request',0);f.stage('Second request',1);f.history.complete(f.session.sessionRefId)
    f.service.analysisRuns={async run(options,commit){return commit(!options.input.messages?{merges:[]}:{tasks:[],assignments:[]})}}
    await f.history.segmentNext()
    assert.match(f.history.coverage().errors[0].last_error,/every input/)
    assert.equal(f.database.db.prepare('SELECT COUNT(*) AS n FROM evidence').get().n,0)
    f.service.analysisRuns.run=async(options,commit)=>{if(!options.input.messages)return commit({merges:[]});f.stage('Arrived during analysis',2);return commit({tasks:[],assignments:options.input.messages.map(message=>({messageId:message.messageId,taskIds:[],status:'no-task'}))})}
    await f.history.segmentNext()
    assert.equal(f.database.db.prepare('SELECT COUNT(*) AS n FROM evidence').get().n,0)
    assert.deepEqual(f.history.coverage().errors,[])
  }finally{f.close()}
})

test('empty task extraction completes the version and all messages archive with stable readable sources',async()=>{
  const f=setup();try{
    for(let i=0;i<10;i++)f.stage('Archive exact original message '+i,i)
    f.history.complete(f.session.sessionRefId)
    f.service.analysisRuns={async run(options,commit){return commit(!options.input.messages?{merges:[]}:{tasks:[description('new:a','Archive task')],assignments:options.input.messages.map(message=>({messageId:message.messageId,taskIds:['new:a'],status:'assigned'}))})}}
    await f.history.segmentNext()
    const id=f.history.list().records[0].id
    assert.equal(f.history.archive().archived,0)
    f.service.analysisRuns.run=async(options,commit)=>{assert.equal(options.input.task.id,id);return commit({entities:[],memories:[],relations:[]})}
    await f.service.memory.runBatch()
    assert.equal(f.database.db.prepare('SELECT context_version=extracted_version AS done FROM session_tasks').get().done,1)
    assert.equal(f.history.archive().archived,10)
    for(const message of f.history.get(id).messages)assert.match(f.service.memory.getExperience(message.evidenceId).content,/Archive exact original message/)
    f.service.memory.rebuildIndex()
    assert.equal(f.history.list({query:'original',rawSearch:true}).records[0].matchCount,10)
    const source=f.history.get(id).messages[0].evidenceId
    const text=f.service.memory.getExperience(source).content
    const memory=f.service.memory.createRecord({kind:'fact',content:text,evidence:[{id:source,quote:text}]})
    assert.equal(memory.sources.length,1)
    const backup=f.database.backup(f.config.backupDir+'/ledger-2026-11-16.sqlite')
    assert.equal(f.database.validateBackup(backup.path).ok,true)
    f.history.removeTask(id)
    assert.equal(f.database.db.prepare('SELECT COUNT(*) AS n FROM history_exclusions').get().n,10)
    assert.equal(f.database.db.prepare('SELECT COUNT(*) AS n FROM evidence').get().n,0)
    assert.equal(f.database.listManagedBackups().length,0)
    assert.equal(f.stage('Archive exact original message 0',0).inserted,false)
  }finally{f.close()}
})

test('failed runs are filtered before stable cursor pagination, including equal timestamps',()=>{
  const f=fixture();try{
    const runs=new AnalysisRuns(f.database.db,null)
    for(let i=0;i<45;i++)f.database.db.prepare('INSERT INTO analysis_runs(run_id,purpose,state,started_at,input_count) VALUES(?,?,?,?,?)').run(String(i).padStart(3,'0'),'memory-extraction',i%2?'succeeded':'failed','2026-11-16T00:00:00Z',1)
    const first=runs.failures({limit:10}),second=runs.failures({limit:10,cursor:first.nextCursor}),third=runs.failures({limit:10,cursor:second.nextCursor})
    assert.equal(first.runs.length,10);assert.equal(second.runs.length,10);assert.equal(third.runs.length,3);assert.equal(third.nextCursor,null)
    assert.equal(new Set([...first.runs,...second.runs,...third.runs].map(run=>run.id)).size,23)
    assert.ok(first.runs.every(run=>run.state==='failed'))
  }finally{f.close()}
})


test('task activity requires a source in the requested interval; raw recall may use earlier context',async()=>{
 const f=setup();try{
  f.stage('Earlier telescope requirement',0);f.stage('Later continuation',2);f.history.complete(f.session.sessionRefId)
  f.service.analysisRuns={async run(options,commit){return commit(options.input.messages?{tasks:[description('new:a','Project')],assignments:options.input.messages.map(m=>({messageId:m.messageId,taskIds:['new:a'],status:'assigned'}))}:{merges:[]})}}
  await f.history.segmentNext()
  assert.equal(f.history.list({from:'2026-01-01T00:00:01.000Z',to:'2026-01-01T00:00:01.900Z'}).records.length,0)
  assert.equal(f.history.list({query:'telescope',rawSearch:true,from:'2026-01-01T00:00:02.000Z'}).records.length,1)
  assert.equal(f.history.list({query:'telescope',rawSearch:true,rawWithinRange:true,from:'2026-01-01T00:00:02.000Z'}).records.length,0)
  const task=f.history.list().records[0],detail=f.history.get(task.id)
  f.database.db.prepare("UPDATE session_tasks SET context_version='changed'").run()
  assert.throws(()=>f.history.get(task.id,{offset:1,version:detail.version}),/changed during paging/)
 }finally{f.close()}
})

test('entity-only extraction remains connected to its task and publication failures reject the run callback',async()=>{
 const f=setup();try{
  f.stage('Orion is a project',0);f.history.complete(f.session.sessionRefId)
  f.service.analysisRuns={async run(options,commit){return commit(options.input.messages?{tasks:[description('new:a','Orion work')],assignments:options.input.messages.map(m=>({messageId:m.messageId,taskIds:['new:a'],status:'assigned'}))}:{merges:[]})}}
  await f.history.segmentNext()
  const task=f.history.list().records[0]
  assert.throws(()=>f.service.memory.validateExtraction({entities:[{name:'Orion',type:'project',attributes:{},evidenceId:'source',quote:'`Orion` is a project'}],memories:[],relations:[]},[{evidence_id:'source',text:'Orion is a project'}]),/entities\[0\]\.quote/)
  f.service.analysisRuns.run=async(options,commit)=>commit({entities:[{name:'Orion',type:'project',attributes:{},evidenceId:options.input.evidence[0].id,quote:'Orion'}],memories:[],relations:[]})
  await f.service.memory.runBatch()
  assert.equal(f.history.get(task.id).entities[0].name,'Orion')
  assert.ok(f.service.memory.list({type:'session-task',from:'2025-01-01T00:00:00Z'}).graphRecords.some(r=>r.relation==='involves'))
  f.database.db.prepare("UPDATE session_tasks SET extracted_version=NULL").run()
  f.service.analysisRuns.run=async(options,commit)=>{f.database.db.prepare("UPDATE session_tasks SET context_version='changed'").run();assert.throws(()=>commit({entities:[],memories:[],relations:[]}),/changed during extraction/);throw new Error('commit failure recorded')}
  await f.service.memory.runBatch()
  assert.equal(f.database.db.prepare('SELECT last_error FROM session_tasks').get().last_error,null)
 }finally{f.close()}
})

test('an unsupported alias is repaired before advancing to later chunks or importing another session',async()=>{
 const f=setup({analysisInputChars:2200});try{
  f.stage('Aurora uses SQLite. '+'Context '.repeat(140),0);f.stage('Borealis uses SQLite. '+'Context '.repeat(140),1)
  f.history.complete(f.session.sessionRefId)
  f.service.analysisRuns={async run(options,commit){return commit(options.input.messages?{tasks:[description('new:a','Storage task')],assignments:options.input.messages.map(m=>({messageId:m.messageId,taskIds:['new:a'],status:'assigned'}))}:{merges:[]})}}
  await f.history.segmentNext()
  f.history.segmentNext=async()=>{throw new Error('Pending task extraction must precede unrelated session analysis')}
  const calls=[]
  f.service.analysisRuns.run=async(options,commit)=>{
   const source=options.input.evidence[0],name=source.text.startsWith('Aurora')?'Aurora':'Borealis';calls.push(name)
   const repaired=options.instructions.includes('entities[0].aliases[0]')
   if(repaired)assert.match(options.instructions,/Unsupported Aurora alias/)
   assert.equal(f.database.db.prepare('SELECT COUNT(*) AS n FROM memory_entities').get().n,0)
   return commit({entities:[{name,type:'project',attributes:{},aliases:name==='Aurora'&&!repaired?['Unsupported Aurora alias']:[],evidenceId:source.id,quote:name}],memories:[],relations:[]})
  }
  await f.service.memory.runBatch()
  assert.deepEqual(calls,['Aurora','Aurora','Borealis'])
  assert.equal(f.database.db.prepare('SELECT COUNT(*) AS n FROM memory_entities').get().n,2)
  assert.equal(f.database.db.prepare('SELECT COUNT(*) AS n FROM memory_aliases').get().n,0)
  assert.equal(f.database.db.prepare('SELECT context_version=extracted_version AS done FROM session_tasks').get().done,1)
 }finally{f.close()}
})

test('model entity references and record fields are validated before publication',()=>{
 const f=setup();try{
  const entity={name:'Aurora',type:'project',attributes:{},evidenceId:'source',quote:'Aurora'}
  const memory={kind:'fact',content:'Aurora uses SQLite',confidence:.8,evidence:[{id:'source',quote:'Aurora'}]}
  const check=value=>f.service.memory.validateExtraction(value,[{evidence_id:'source',text:'Aurora uses SQLite'}])
  check({entities:[{...entity,aliases:['SQLite']}],memories:[{...memory,entityName:'Aurora'}],relations:[]})
  assert.throws(()=>check({entities:[entity,{...entity,name:'AURORA'}],memories:[],relations:[]}),/ambiguous/)
  for(const [fields,error] of [[{entityName:'Unknown'},/entityName/],[{predicate:12},/predicate/],[{object:{entityId:'invented'}},/entityId/],[{scope:[]},/scope/]])assert.throws(()=>check({entities:[entity],memories:[{...memory,...fields}],relations:[]}),error)
  assert.throws(()=>check({entities:[entity],memories:[],relations:[{fromEntity:'Aurora',toEntity:'Unknown',relation:'uses',evidenceId:'source',quote:'Aurora'}]}),/canonical endpoints/)
 }finally{f.close()}
})

for (const repair of [true,false]) test(`task extraction ${repair?'repairs a rejected chunk without repeating valid chunks':'stops at the chunk retry limit without publishing partial memories'}`,async()=>{
  const f=setup({analysisInputChars:2200,memoryExtractionRetryLimit:3});try{
    f.stage('Aurora uses `SQLite` for persistence. '+ 'Context '.repeat(140),0)
    f.stage('Borealis uses `SQLite` for persistence. '+ 'Context '.repeat(140),1)
    f.history.complete(f.session.sessionRefId)
    f.service.analysisRuns={async run(options,commit){return commit(options.input.messages?{tasks:[description('new:a','Storage decision')],assignments:options.input.messages.map(m=>({messageId:m.messageId,taskIds:['new:a'],status:'assigned'}))}:{merges:[]})}}
    await f.history.segmentNext()
    const calls=[]
    f.service.analysisRuns.run=async(options,commit)=>{
      assert.equal(options.input.evidence.length,1)
      const source=options.input.evidence[0],name=source.text.startsWith('Aurora')?'Aurora':'Borealis'
      calls.push(name)
      assert.equal(f.database.db.prepare('SELECT COUNT(*) AS n FROM memory_records').get().n,0)
      const retry=options.instructions.includes('previous attempt for this source chunk was rejected')
      if(retry)assert.match(options.instructions,/exact source support/)
      const quote=name==='Aurora'||repair&&retry?`${name} uses \`SQLite\` for persistence.`:`${name} uses SQLite for persistence.`
      return commit({entities:[],relations:[],memories:[{kind:'fact',content:`${name} uses SQLite`,entityName:null,confidence:.8,evidence:[{id:source.id,quote,stance:'supports'}]}]})
    }
    await f.service.memory.runBatch()
    assert.deepEqual(calls,repair?['Aurora','Borealis','Borealis']:['Aurora','Borealis','Borealis','Borealis'])
    const row=f.database.db.prepare('SELECT context_version,extracted_version,last_error FROM session_tasks').get()
    assert.equal(f.database.db.prepare('SELECT COUNT(*) AS n FROM memory_records').get().n,repair?2:0)
    if(repair){assert.equal(row.extracted_version,row.context_version);assert.equal(row.last_error,null)}
    else {assert.equal(row.extracted_version,null);assert.match(row.last_error,/exact source support/)}
  }finally{f.close()}
})
