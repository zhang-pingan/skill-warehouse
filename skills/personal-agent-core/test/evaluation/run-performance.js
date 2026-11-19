/** Current B0 performance: sequential isolated synthetic reads, native profiles and writes. */
import { spawn } from 'node:child_process'
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,rmSync,appendFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { sourceManifest,digest } from './fixture.js'
import { runScaleProfile,profileCheckoutManifest } from './scale-profile.js'
import { verifyThreadReads } from './query-thread-equivalence.js'
const [source,output,checkout]=process.argv.slice(2).map(v=>path.resolve(v))
mkdirSync(output,{recursive:true})
const root=mkdtempSync(path.join(os.tmpdir(),'pac-b0-performance-'))
const protocol={baseline:'B0',scales:[1000,10000,50000],queries:['scaleitem000000','reconnect','恢复队列','nonexistentquasarpayload'],
  lanes:['history','memory'],passes:['first','repeat'],repetitions:3,queryBudgetMs:10000,
  cache:'Fresh process per query/lane/repetition. First includes lazy reader startup; repeat reuses it. OS cache not flushed.',
  endpoint:'Production service operations plus supported source Web profile registered personal_agent tool. No inference or daily storage.',
  timer:'Query excludes startup, serialization, hashing and post-query GC. Host timer sampled every 5ms throughout query and final continuation.',
  source:sourceManifest(source),harness:profileCheckoutManifest(checkout),
  environment:{node:process.version,sqlite:process.versions.sqlite,platform:process.platform,arch:process.arch,cpu:os.cpus()[0].model}}
writeFileSync(path.join(output,'manifest.json'),JSON.stringify(protocol,null,2)+'\n',{flag:'wx'})
async function child(args,label){
  const proc=spawn(process.execPath,args,{env:{PATH:process.env.PATH,TMPDIR:root,TZ:'UTC',LANG:'C.UTF-8'},stdio:['ignore','pipe','pipe']})
  let pending='',rows=[],spawnError
  const timer=setTimeout(()=>proc.kill('SIGKILL'),120000)
  proc.once('error',error=>{spawnError=error.message})
  proc.stdout.on('data',chunk=>{
    appendFileSync(path.join(output,label+'.jsonl'),chunk);pending+=chunk
    const lines=pending.split('\n');pending=lines.pop()
    for(const line of lines)if(line.trim())rows.push(JSON.parse(line))
  })
  proc.stderr.on('data',chunk=>appendFileSync(path.join(output,label+'.stderr'),chunk))
  const exit=await new Promise(resolve=>proc.once('close',(code,signal)=>resolve({code,signal})));clearTimeout(timer)
  const result={label,...exit,spawnError:spawnError??null};appendFileSync(path.join(output,'children.jsonl'),JSON.stringify(result)+'\n')
  assert.equal(spawnError,undefined);assert.equal(exit.code,0,JSON.stringify(result))
  return rows
}
const reads=[],writes=[],profiles=[],builds=[]
const stats=values=>{const v=[...values].sort((a,b)=>a-b);return {n:v.length,p50:v.length%2?v[(v.length-1)/2]:(v[v.length/2-1]+v[v.length/2])/2,p95:v[Math.ceil(v.length*.95)-1],max:v.at(-1)}}
try {
  const equality=await verifyThreadReads()
  writeFileSync(path.join(output,'equivalence.json'),JSON.stringify(equality,null,2)+'\n')
  for(const count of protocol.scales){
    const seed=path.join(root,`seed-${count}`);mkdirSync(seed)
    const built=await child([path.join(import.meta.dirname,'scale-worker.js'),'build',seed,source,String(count)],`build-${count}`)
    builds.push(built.find(row=>row.event==='build'))
    for(let repetition=0;repetition<protocol.repetitions;repetition++){
      for(const lane of protocol.lanes)for(const [q,query] of protocol.queries.entries()){
        const label=`read-${count}-${repetition}-${lane}-${q}`,dir=path.join(root,label)
        mkdirSync(path.join(dir,'data'),{recursive:true});copyFileSync(path.join(seed,'data/ledger.sqlite'),path.join(dir,'data/ledger.sqlite'))
        const rows=await child(['--expose-gc',path.join(import.meta.dirname,'retrieval-performance-worker.js'),source,dir,path.join(output,label),lane,query],label)
        const results=rows.filter(row=>row.event==='query')
        assert.equal(results.length,2);assert.equal(results[0].sha256,results[1].sha256)
        for(const row of results){assert(row.elapsedMs<protocol.queryBudgetMs);reads.push({count,repetition,lane,query,initializeMs:rows.find(r=>r.event==='ready').initializeMs,...row})}
        rmSync(dir,{recursive:true})
      }
      const queries=['search_history','memory_search'].flatMap(action=>Array.from({length:2},()=>({action,query:'scaleitem000000',limit:20,includeCandidates:true,asOf:'2026-11-18T00:00:00.000Z'})))
      profiles.push(await runScaleProfile({checkout,source,directory:path.join(root,`profile-${count}-${repetition}`),seedDatabase:path.join(seed,'data/ledger.sqlite'),count,repetition,output,queries}))
      for(const lane of ['source-append','memory-append','memory-correct']){
        const label=`write-${count}-${repetition}-${lane}`,dir=path.join(root,label)
        mkdirSync(path.join(dir,'data'),{recursive:true});copyFileSync(path.join(seed,'data/ledger.sqlite'),path.join(dir,'data/ledger.sqlite'))
        const rows=await child(['--expose-gc',path.join(import.meta.dirname,'incremental-worker.js'),source,dir,lane,String(count)],label)
        assert.equal(rows.filter(r=>r.event==='verified').length,1)
        writes.push({count,repetition,lane,...rows.find(r=>r.event==='verified')})
        rmSync(dir,{recursive:true})
      }
    }
    process.stdout.write(`Completed ${count} messages\n`)
  }
  const summary={baseline:'B0',sourceSha256:protocol.source.sha256,equalityComparisons:equality.comparisons,reads:reads.length,profiles:profiles.length,profileReads:profiles.reduce((n,p)=>n+p.ready.queries.length,0),writes:writes.length*20,
    scales:protocol.scales.map(count=>({count,databaseBytes:builds.find(b=>b.count===count).databaseBytes,
      initializeMs:stats(reads.filter(r=>r.count===count&&r.pass==='first').map(r=>r.initializeMs)),
      queries:protocol.lanes.flatMap(lane=>protocol.passes.map(pass=>{const rows=reads.filter(r=>r.count===count&&r.lane===lane&&r.pass===pass);return {lane,pass,elapsedMs:stats(rows.map(r=>r.elapsedMs)),hostDelayMs:stats(rows.map(r=>r.heartbeat.maxDelayMs)),rssBytes:stats(rows.map(r=>r.memory.rss))}})),
      profileStartupMs:stats(profiles.filter(p=>p.count===count).map(p=>p.ready.spawnToReadyMs)),
      profileQueries:profiles.filter(p=>p.count===count).flatMap(p=>p.ready.queries.map(q=>({elapsedMs:q.elapsedMs,heartbeat:q.heartbeat}))),
      writes:['source-append','memory-append','memory-correct'].map(lane=>({lane,batchMs:stats(writes.filter(w=>w.count===count&&w.lane===lane).map(w=>w.batchMs))}))})),
    sourceUnchanged:sourceManifest(source).sha256===protocol.source.sha256}
  assert(summary.sourceUnchanged)
  writeFileSync(path.join(output,'summary.json'),JSON.stringify(summary,null,2)+'\n')
} finally {rmSync(root,{recursive:true,force:true});writeFileSync(path.join(output,'cleanup.json'),JSON.stringify({removed:true})+'\n')}
