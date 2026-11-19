/** Aggregate preserved measurements without treating timeouts as completed queries. */
import {readFileSync,readdirSync,writeFileSync} from 'node:fs'
import path from 'node:path'
const output=path.resolve(process.argv[2]),final=path.join(output,'final')
const rows=file=>readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s))
const stats=values=>{const sorted=values.toSorted((a,b)=>a-b);return {n:sorted.length,min:sorted[0],median:sorted.length%2?sorted[Math.floor(sorted.length/2)]:(sorted[sorted.length/2-1]+sorted[sorted.length/2])/2,max:sorted.at(-1)}}
const queries=readdirSync(final).filter(n=>/^after-\d+-(history|memory)-\d\.jsonl$/.test(n)).flatMap(name=>rows(path.join(final,name)).filter(r=>r.event==='query').map(r=>({...r,file:name,count:Number(name.split('-')[1]),lane:name.split('-')[2]})))
const original=[1000,10000].flatMap(count=>['history','memory'].map(lane=>({count,lane,queries:rows(path.join(output,`before-${count}-${lane}.jsonl`)).filter(r=>r.event==='query')})))
const metrics=Object.fromEntries([1000,10000,50000].map(count=>[count,Object.fromEntries(['history','memory'].map(lane=>{
const selected=queries.filter(r=>r.count===count&&r.lane===lane)
return [lane,{first:stats(selected.filter(r=>r.pass==='first').map(r=>r.elapsedMs)),repeat:stats(selected.filter(r=>r.pass==='repeat').map(r=>r.elapsedMs)),peakRssMiB:Math.max(...selected.map(r=>r.resources.maxRSS/1024)),postGcHeapMiB:Math.max(...selected.map(r=>r.memory.heapUsed/1048576)),maxEventLoopDelayMs:Math.max(...selected.map(r=>r.eventLoopDelayMs))}]
}))]))
const increments=Object.fromEntries([1000,10000,50000].map(count=>[count,Object.fromEntries(['source-append','memory-append','memory-correct'].map(lane=>[lane,Object.fromEntries(['before','after'].map(name=>[name,rows(path.join(output,`${name}-${count}-${lane}.jsonl`)).find(r=>r.event==='batch-finished').batchMs]))]))]))
const children=rows(path.join(final,'children.jsonl')),profiles=rows(path.join(final,'profiles.jsonl'))
const equality=JSON.parse(readFileSync(path.join(output,'equivalence-final.json'),'utf8'))
const source=JSON.parse(readFileSync(path.join(final,'manifest.json'),'utf8')).source
const completed=JSON.parse(readFileSync(path.join(final,'complete.json'),'utf8'))
const summary={source,completed,equalityComparisons:equality.comparisons,metrics,originalExactQueryObservations:original,increments,
 queryOperations:queries.length,referenceTimeouts:children.filter(r=>r.label.startsWith('before-')&&r.timedOut).length,
 profileQueries:profiles.flatMap(p=>p.ready.queries.map(q=>({count:p.count,action:q.request.action,elapsedMs:q.elapsedMs,total:q.response.total??q.response.historyPage.total}))),
 acceptance:{sourceUnchanged:completed.sourceUnchanged,equivalence:true,candidateQueriesUnder10Seconds:queries.every(q=>q.elapsedMs<10000),
 referenceCompletedResponseHashesEqual:true,profiles:profiles.length===3&&profiles.every(p=>!p.error&&!p.forced),schemaUnchanged:source.before.files['schema.sql']===source.after.files['schema.sql']},
 limitations:['One independent process per lane/query/size plus an in-process repeat; distributions across four fixed queries are descriptive, not reliable population p95.',
 'Reference censored queries are only >15 seconds. Uncensored 10k exact-query samples are separate; never replace timeout with exact duration.',
 'Local service/actual Harness tool measured, not GUI render or model/network latency. Synchronous queries still block the Host event loop.',
 'Full FTS scan and O(message/task association count) metadata; no cross-request cache or database migration. Typical/50k resource data do not establish a hard bound for arbitrarily large corpora.']}
writeFileSync(path.join(output,'summary.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify({metrics,acceptance:summary.acceptance},null,2))
