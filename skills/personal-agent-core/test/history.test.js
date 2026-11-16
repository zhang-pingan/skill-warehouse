import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync,writeFileSync,appendFileSync } from 'node:fs'
import path from 'node:path'
import { fixture } from './helpers.js'
import { DshHistoryImporter } from '../lib/dsh-history.js'
import { CodexHistoryImporter,normalizedItem } from '../lib/codex-history.js'
import { historyCheckpoint } from '../lib/history-work.js'
const user=(seq,text)=>({seq,time:'2026-01-01T00:00:00Z',type:'user/message',surfaceOp:'append',data:{source:{kind:'user'},content:[{type:'text',text}]}})
function persistence(events){const state={opens:0,closes:0};return Object.assign(state,{async list(){return[{id:'session',revision:events.length,eventCount:events.length,header:{id:'session',createdAt:'2026-01-01T00:00:00Z',title:'Conversation'}}]},async open(){state.opens++;return{async read(offset,limit){return{events:events.slice(offset,offset+limit)}},async close(){state.closes++}}}})}
const staged=f=>f.database.db.prepare('SELECT * FROM history_messages ORDER BY source_order').all()
function rollout(f,lines,name='session') {const dir=path.join(f.config.codexHome,'sessions');mkdirSync(dir,{recursive:true});const file=path.join(dir,`rollout-${name}.jsonl`);writeFileSync(file,lines.map(line=>JSON.stringify(line)+'\n').join(''));return file}
const meta={type:'session_meta',timestamp:'2026-01-01T00:00:00Z',payload:{id:'codex-session',cwd:'/tmp'}}
const codexUser=text=>({type:'event_msg',timestamp:'2026-01-01T00:01:00Z',payload:{type:'user_message',message:text}})

test('DSH stages old conversations completely, skips injected instructions and reasoning, and reuses unchanged cursors',async()=>{
 const f=fixture({historyBatchSize:1});try{
  const events=[user(0,'Old request'),{...user(1,'Injected'),data:{source:{kind:'agent-instructions'},content:[{text:'Injected'}]}},{seq:2,type:'assistant/message',surfaceOp:'append',time:'2026-01-01T01:00:00Z',data:{message:{content:[{type:'reasoning',text:'secret'},{type:'text',text:'Visible reply'}]}}},{seq:3,type:'tool/result',surfaceOp:'append',data:{message:{content:[{type:'text',text:'Full tool output'}]}}}]
  const source=persistence(events),importer=new DshHistoryImporter(f.ledger)
  assert.equal((await importer.importFromPersistence(source)).imported,3)
  assert.deepEqual(staged(f).map(row=>row.staged_text),['Old request','Visible reply','Full tool output'])
  assert.equal(f.database.db.prepare('SELECT COUNT(*) AS n FROM evidence').get().n,0)
  assert.equal(f.database.db.prepare('SELECT scan_complete FROM history_sessions').get().scan_complete,1)
  const opens=source.opens;assert.equal((await importer.importFromPersistence(source)).imported,0);assert.equal(source.opens,opens)
  events.push(user(4,'New follow-up'));assert.equal((await importer.importFromPersistence(source)).imported,1);assert.equal(staged(f).length,4)
  assert.equal(source.opens,source.closes)
 }finally{f.close()}
})
test('DSH cancellation closes readers, preserves staged messages and retries without duplicate publication',async()=>{
 const f=fixture({historyBatchSize:1});try{
  const source=persistence([user(0,'First'),user(1,'Second')]),importer=new DshHistoryImporter(f.ledger),snapshot=(await source.list())[0]
  let checkpoints=0
  await assert.rejects(importer.importStoredSession(source,snapshot,{checkpoint:async()=>{if(++checkpoints===7)throw new DOMException('cancelled','AbortError')}}),{name:'AbortError'})
  assert.equal(source.opens,source.closes)
  await importer.importStoredSession(source,snapshot)
  assert.equal(staged(f).length,2);assert.equal(f.database.db.prepare('SELECT COUNT(*) AS n FROM evidence').get().n,0)
 }finally{f.close()}
})
test('DSH incomplete snapshots are left unpublished and visible as retryable import failures',async()=>{
 const f=fixture();try{
  const source=persistence([user(0,'First')]),importer=new DshHistoryImporter(f.ledger)
  await assert.rejects(importer.importStoredSession(source,{...(await source.list())[0],eventCount:2}),/not fully read/)
  assert.equal(f.database.db.prepare('SELECT scan_complete FROM history_sessions').get().scan_complete,0)
  assert.equal(source.opens,source.closes)
 }finally{f.close()}
})
test('Codex indexes titles without publishing title evidence and stages full long tool output',async()=>{
 const f=fixture({historyReadBytes:1024});try{
  const text='tool original content '.repeat(1000)
  const file=rollout(f,[meta,codexUser('First request'),{type:'event_msg',timestamp:'2026-01-01T00:02:00Z',payload:{type:'item_completed',item:{id:'cmd',type:'CommandExecution',command:'cat file',aggregated_output:text,status:'completed'}}}])
  writeFileSync(path.join(f.config.codexHome,'session_index.jsonl'),JSON.stringify({id:'codex-session',thread_name:'Original title',updated_at:'2026-11-16T00:00:00Z'})+'\n')
  const importer=new CodexHistoryImporter(f.ledger,f.config)
  for(let i=0;i<10;i++){const result=await importer.run();if(result.rollouts.complete)break}
  assert.equal(staged(f).length,2);assert.ok(staged(f)[1].staged_text.includes(text.trim()))
  assert.equal(f.database.db.prepare('SELECT title,scan_complete FROM history_sessions').get().title,'Original title')
  assert.equal(f.database.db.prepare('SELECT scan_complete FROM history_sessions').get().scan_complete,1)
  assert.equal(f.database.db.prepare('SELECT COUNT(*) AS n FROM evidence').get().n,0)
  appendFileSync(file,JSON.stringify(codexUser('Appended request'))+'\n');await importer.run();assert.equal(staged(f).length,3)
  assert.equal((await importer.run()).rollouts.evidenceImported,0)
 }finally{f.close()}
})
test('Codex partial file budgets cannot publish a complete session snapshot',async()=>{
 const f=fixture({historyReadBytes:1024});try{
  rollout(f,[meta,...Array.from({length:30},(_,i)=>codexUser('Original '+i+' '+'.'.repeat(200)))])
  const importer=new CodexHistoryImporter(f.ledger,f.config)
  const first=await importer.run({totalByteBudget:1024,fileByteBudget:1024})
  assert.equal(first.rollouts.complete,false);assert.equal(f.database.db.prepare('SELECT scan_complete FROM history_sessions').get().scan_complete,0)
  for(let i=0;i<20;i++){if((await importer.run()).rollouts.complete)break}
  assert.equal(staged(f).length,30);assert.equal(f.database.db.prepare('SELECT scan_complete FROM history_sessions').get().scan_complete,1)
 }finally{f.close()}
})
test('Codex rollout cancellation leaves its durable cursor behind uncommitted input and safely repeats staged records',async()=>{
 const f=fixture();try{
  rollout(f,[meta,codexUser('First'),codexUser('Second')]);const importer=new CodexHistoryImporter(f.ledger,f.config)
  let calls=0;await assert.rejects(importer.importRollouts({checkpoint:async()=>{if(++calls===6)throw new DOMException('cancelled','AbortError')}}),{name:'AbortError'})
  await importer.importRollouts();assert.equal(staged(f).length,2)
 }finally{f.close()}
})
test('original-source parser excludes injected user context and reasoning phases',()=>{
 assert.equal(normalizedItem(codexUser('# AGENTS.md instructions for workspace')),null)
 assert.equal(normalizedItem({type:'event_msg',payload:{type:'item_completed',item:{type:'Reasoning',text:'private'}}}),null)
 assert.equal(normalizedItem({type:'event_msg',payload:{type:'agent_message',phase:'analysis',message:'private'}}),null)
 assert.equal(normalizedItem({type:'event_msg',payload:{type:'agent_message',phase:'final',message:'Visible'}}).text,'Visible')
})
test('history checkpoints observe cancellation and yield under bounded work',async()=>{
 const f=fixture({historyBatchSize:1});try{const controller=new AbortController(),checkpoint=historyCheckpoint(f.config,controller.signal);await checkpoint();controller.abort();await assert.rejects(checkpoint(),{name:'AbortError'})}finally{f.close()}
})


test('Codex retains completion-only replies and excludes a repeated completion echo',async()=>{
 const f=fixture();try{
  const complete=text=>({type:'event_msg',timestamp:'2026-01-01T00:02:00Z',payload:{type:'task_complete',last_agent_message:text}})
  rollout(f,[meta,codexUser('Request'),complete('Only final response'),codexUser('Follow-up'),{type:'event_msg',timestamp:'2026-01-01T00:02:00Z',payload:{type:'agent_message',phase:'final',message:'Already recorded'}},complete('Already recorded')])
  await new CodexHistoryImporter(f.ledger,f.config).run()
  assert.deepEqual(staged(f).map(row=>row.staged_text),['Request','Only final response','Follow-up','Already recorded'])
 }finally{f.close()}
})
