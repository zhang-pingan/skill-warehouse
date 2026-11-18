/** Deduplicate measured native usage; retain fixture-setup costs separately from measured work. */
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
for(const name of members){
 const events=execFileSync('tar',['-xOzf',path.join(out,'codex-sessions.tar.gz'),name],{encoding:'utf8',maxBuffer:64*1024*1024}).trim().split('\n').map(JSON.parse)
 const sessionId=events.find(e=>e.type==='session_meta')?.payload.id
 const index=rows.findIndex(r=>r.result.workers?.some(w=>w.sessionId===sessionId))
 if(index<0)throw new Error('Unmatched Codex usage session')
 let turnId=null
 const records=[]
 for(const event of events){
  if(event.type==='event_msg'&&event.payload.type==='task_started')turnId=event.payload.turn_id
  if(event.type==='event_msg'&&event.payload.type==='token_count'&&event.payload.info)records.push({turnId,info:event.payload.info})
 }
 const totals=records.at(-1)?.info.total_token_usage
 if(!totals){scores[index].codex.missingUsage=true;continue}
 const keys=['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens','total_tokens']
 for(const key of keys)if(records.reduce((sum,r)=>sum+r.info.last_token_usage[key],0)!==totals[key])throw new Error(`Codex usage mismatch: ${key}`)
 for(const record of records)scores[index].codex.turns.push({sessionId,turnId:record.turnId,setup:rows[index].result.measurementBoundary?.codexSeedTurnIds?.includes(record.turnId)??false,usage:record.info.last_token_usage})
}
const summary={recordedAt:new Date().toISOString(),postprocessorSha256:digest(readFileSync(new URL(import.meta.url))),resultsSha256:digest(readFileSync(path.join(out,'results.jsonl'))),
 method:'DSH per-attempt sessionId/seq deduplication; seed observations excluded from measured phase. Codex per-completion last usage, checked against final native cumulative totals; seeded turn IDs excluded. Cache/reasoning subset conventions retained; no fees inferred.',scores,
 dsh:{attempts:scores.reduce((s,r)=>s+r.dsh.measuredAttempts,0),usage:sums(scores.map(r=>r.dsh.measuredUsage)),complete:scores.every(r=>r.dsh.usageComplete)},
 codex:{completions:scores.reduce((s,r)=>s+r.codex.turns.filter(t=>!t.setup).length,0),usage:sums(scores.flatMap(r=>r.codex.turns.filter(t=>!t.setup).map(t=>t.usage))),complete:scores.every(r=>!r.codex.missingUsage)}}
writeFileSync(path.join(out,'usage-diagnostics.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({dsh:summary.dsh,codex:summary.codex}))
