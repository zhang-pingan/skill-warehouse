/** Account native worker trees, preserving each session total and separating seeded turns. */
import {readFileSync,writeFileSync,existsSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import path from 'node:path'
import {digest} from './fixture.js'
const out=path.resolve(process.argv[2]),rows=readFileSync(path.join(out,'results.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
const sums=values=>Object.fromEntries([...new Set(values.flatMap(v=>Object.keys(v)))].map(k=>[k,values.reduce((s,v)=>s+(v[k]??0),0)]))
const scores=rows.map(row=>{
 const r=row.result,boundary=r.measurementBoundary??{},attempts=new Map()
 for(const observation of [r.observation,...(r.analyses??[]),...(r.workers??[]).map(w=>w.observation)].filter(Boolean))for(const attempt of observation.attempts??[]){
  const setup=observation.sessionId===r.observation?.sessionId&&attempt.seq<boundary.mainSeq||observation.sessionId===boundary.dshWorkerSeq?.sessionId&&attempt.seq<boundary.dshWorkerSeq.seq
  attempts.set(`${observation.sessionId}:${attempt.seq}`,{...attempt,setup})
 }
 const values=[...attempts.values()],measured=values.filter(v=>!v.setup)
 const tokens=items=>sums(items.map(a=>Object.fromEntries(['inputTokens','cacheReadTokens','outputTokens','totalTokens'].map(k=>[k,a.usage?.[k]??0]))))
 return {caseId:row.caseId,repeat:row.repeat,dsh:{allAttempts:values.length,measuredAttempts:measured.length,usageComplete:measured.every(v=>v.usage),allUsage:tokens(values),measuredUsage:tokens(measured)},codex:{turns:[]}}
})
let members=[]
try{if(existsSync(path.join(out,'codex-sessions.tar.gz')))members=execFileSync('tar',['-tzf',path.join(out,'codex-sessions.tar.gz')],{encoding:'utf8'}).trim().split('\n').filter(n=>n.endsWith('.jsonl')&&!path.basename(n).startsWith('._'))}catch(error){if(rows.some(r=>r.result.workers?.some(w=>w.sourceSystem==='codex')))throw error}
const sessions=new Map()
for(const name of members){
 const events=execFileSync('tar',['-xOzf',path.join(out,'codex-sessions.tar.gz'),name],{encoding:'utf8',maxBuffer:64*1024*1024}).trim().split('\n').map(JSON.parse)
 const meta=events.find(e=>e.type==='session_meta')?.payload
 if(!meta?.id||sessions.has(meta.id))throw new Error('Missing or duplicate Codex session identity')
 sessions.set(meta.id,{events,parent:meta.parent_thread_id??meta.source?.subagent?.thread_spawn?.parent_thread_id??null})
}
function owner(sessionId,visited=new Set()){
 if(visited.has(sessionId))throw new Error('Cyclic native Codex worker ancestry')
 visited.add(sessionId)
 const index=rows.findIndex(r=>r.result.workers?.some(w=>w.sessionId===sessionId))
 if(index>=0)return {index,rootId:sessionId}
 const parent=sessions.get(sessionId)?.parent
 if(!parent||!sessions.has(parent))throw new Error('Unmatched Codex usage session: '+sessionId)
 return owner(parent,visited)
}
for(const [sessionId,session] of sessions){
 const {index,rootId}=owner(sessionId)
 const rootTurns=sessions.get(rootId).events.filter(e=>e.type==='event_msg'&&e.payload.type==='task_started').map(e=>({id:e.payload.turn_id,time:Date.parse(e.timestamp)}))
 if(rootTurns.some(t=>!Number.isFinite(t.time)))throw new Error('Missing root turn timestamp')
 let turnId=null,turnStarted=null
 const records=[]
 for(const event of session.events){
  if(event.type==='event_msg'&&event.payload.type==='task_started'){turnId=event.payload.turn_id;turnStarted=Date.parse(event.timestamp)}
  if(event.type==='event_msg'&&event.payload.type==='token_count'&&event.payload.info)records.push({turnId,turnStarted,info:event.payload.info})
 }
 const totals=records.at(-1)?.info.total_token_usage
 if(!totals){scores[index].codex.missingUsage=true;continue}
 const keys=['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens','total_tokens']
 for(const key of keys)if(records.reduce((sum,r)=>sum+r.info.last_token_usage[key],0)!==totals[key])throw new Error(`Codex usage mismatch: ${sessionId} ${key}`)
 for(const record of records){
  const rootTurnId=sessionId===rootId?record.turnId:rootTurns.filter(t=>t.time<=record.turnStarted).at(-1)?.id
  if(!rootTurnId)throw new Error('Cannot associate descendant usage with a root turn')
  scores[index].codex.turns.push({sessionId,parentSessionId:session.parent,rootSessionId:rootId,turnId:record.turnId,rootTurnId,
   setup:rows[index].result.measurementBoundary?.codexSeedTurnIds?.includes(rootTurnId)??false,usage:record.info.last_token_usage})
 }
}
const summary={recordedAt:new Date().toISOString(),postprocessorSha256:digest(readFileSync(new URL(import.meta.url))),resultsSha256:digest(readFileSync(path.join(out,'results.jsonl'))),
 method:'DSH per-attempt sessionId/seq deduplication. Codex session_meta parent_thread_id establishes worker-tree ownership; descendant turns map to the latest root task_started at their start time. Per-session last usage sums must equal its final cumulative totals. Seed root turns and their descendants are excluded. Unknown ancestry/timestamps stop accounting; no missing session is silently dropped. Cache/reasoning subset conventions retained; no fees inferred.',scores,
 dsh:{attempts:scores.reduce((s,r)=>s+r.dsh.measuredAttempts,0),usage:sums(scores.map(r=>r.dsh.measuredUsage)),complete:scores.every(r=>r.dsh.usageComplete)},
 codex:{completions:scores.reduce((s,r)=>s+r.codex.turns.filter(t=>!t.setup).length,0),usage:sums(scores.flatMap(r=>r.codex.turns.filter(t=>!t.setup).map(t=>t.usage))),complete:scores.every(r=>!r.codex.missingUsage)}}
writeFileSync(path.join(out,'usage-tree-diagnostics.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({dsh:summary.dsh,codex:summary.codex}))
