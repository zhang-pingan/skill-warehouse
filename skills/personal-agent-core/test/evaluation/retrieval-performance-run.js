/** Reproducible sequential comparison on private copies of the fixed scale corpus. */
import {spawn} from 'node:child_process'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,rmSync,appendFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {sourceManifest,digest} from './fixture.js'
import {runScaleProfile} from './scale-profile.js'
const [before,after,output,checkout]=process.argv.slice(2).map(v=>path.resolve(v))
mkdirSync(output,{recursive:true})
const root=mkdtempSync(path.join(os.tmpdir(),'pac-retrieval-compare-'))
const protocol={scales:[1000,10000,50000],queries:['scaleitem000000','reconnect','恢复队列','nonexistentquasarpayload'],passes:['first','repeat'],
  beforeBudgetMs:15000,afterBudgetMs:10000,repetitions:1,cache:'Fresh process per lane/query; OS cache not flushed. Repeated pass shares process. Deadlines start at query-start.',
  endpoint:'Production service operation; query timer excludes startup, serialization, hashing and post-request GC; event-loop delay includes pending immediate. RSS includes service/modules.',
  acceptance:'Complete response equality where reference finishes; after queries each under 10s; retained B0 untouched. Before timeout is a lower bound, never exact latency.',
  source:{before:sourceManifest(before),after:sourceManifest(after)},environment:{node:process.version,sqlite:process.versions.sqlite,platform:process.platform,arch:process.arch}}
writeFileSync(path.join(output,'manifest.json'),JSON.stringify(protocol,null,2)+'\n',{flag:'wx'})
async function child(args,label,queryBudget=120000){
 const proc=spawn(process.execPath,args,{env:{PATH:process.env.PATH,TMPDIR:root,TZ:'UTC',LANG:'C.UTF-8'},stdio:['ignore','pipe','pipe']})
 let pending='',rows=[],timedOut=false,spawnError=null
 const stop=()=>{timedOut=true;proc.kill('SIGKILL')}
 let timer=setTimeout(stop,120000)
 proc.once('error',e=>{spawnError=e.message})
 proc.stdout.on('data',chunk=>{
  appendFileSync(path.join(output,label+'.jsonl'),chunk);pending+=chunk
  const lines=pending.split('\n');pending=lines.pop()
  for(const line of lines)if(line.trim()){
   const row=JSON.parse(line);rows.push(row)
   if(row.event==='query-start'){clearTimeout(timer);timer=setTimeout(stop,queryBudget)}
   if(row.event==='query'){clearTimeout(timer);timer=setTimeout(stop,120000)}
  }
 })
 proc.stderr.on('data',chunk=>appendFileSync(path.join(output,label+'.stderr'),chunk))
 const exit=await new Promise(resolve=>proc.once('close',(code,signal)=>resolve({code,signal})));clearTimeout(timer)
 const result={label,...exit,timedOut,spawnError};appendFileSync(path.join(output,'children.jsonl'),JSON.stringify(result)+'\n')
 if(spawnError||exit.code!==0&&!timedOut)throw new Error(JSON.stringify(result))
 return {rows,...result}
}
try {
 for(const count of protocol.scales){
  const seed=path.join(root,`seed-${count}`);mkdirSync(seed)
  const build=await child([path.join(import.meta.dirname,'scale-worker.js'),'build',seed,before,String(count)],`build-${count}`)
  if(build.code!==0)throw new Error('Corpus build did not complete')
  for(const lane of ['history','memory'])for(const [q,query] of protocol.queries.entries()){
   const hashes={}
   for(const [name,source] of [['before',before],['after',after]]){
    const dir=path.join(root,`${name}-${count}-${lane}-${q}`);mkdirSync(path.join(dir,'data'),{recursive:true})
    copyFileSync(path.join(seed,'data/ledger.sqlite'),path.join(dir,'data/ledger.sqlite'))
    const label=`${name}-${count}-${lane}-${q}`
    const result=await child(['--expose-gc',path.join(import.meta.dirname,'retrieval-performance-worker.js'),source,dir,path.join(output,label),lane,query],label,name==='before'?protocol.beforeBudgetMs:protocol.afterBudgetMs)
    if(name==='after'&&result.timedOut)throw new Error('Candidate exceeded query budget')
    hashes[name]=result.rows.filter(r=>r.event==='query').map(r=>r.sha256)
    rmSync(dir,{recursive:true})
   }
   if(hashes.before.length&&hashes.before.some((h,i)=>h!==hashes.after[i]))throw new Error('Response changed')
  }
  const queries=['search_history','memory_search'].map(action=>({action,query:'scaleitem000000',limit:20,includeCandidates:true,asOf:'2026-11-18T00:00:00.000Z'}))
  await runScaleProfile({checkout,source:after,directory:path.join(root,`profile-${count}`),seedDatabase:path.join(seed,'data/ledger.sqlite'),count,repetition:'candidate',output,queries})
 }
} finally {rmSync(root,{recursive:true,force:true});writeFileSync(path.join(output,'cleanup.json'),JSON.stringify({removed:true})+'\n')}
writeFileSync(path.join(output,'complete.json'),JSON.stringify({complete:true,sourceUnchanged:sourceManifest(after).sha256===protocol.source.after.sha256})+'\n')
