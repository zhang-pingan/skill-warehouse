/** Freeze and measure native main-session decisions through production worker result/acceptance paths. */
import {appendFileSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import path from 'node:path'
import {digest,sourceManifest,loadJson} from './fixture.js'
import {startHarness} from './run-harness.js'
import {quantile} from './score.js'
const config=JSON.parse(readFileSync(process.argv[2],'utf8')),output=path.resolve(process.argv[3])
const protocol=loadJson('autonomy-cases.json')
const mode=process.argv[4]??'all'
const selectedCase=/^case:([a-z0-9-]+):([0-2])$/.exec(mode)
if(!selectedCase&&!['all','smoke','repeat-0','repeat-1','repeat-2'].includes(mode))throw new Error('Mode must be all, smoke, repeat-0/1/2, or case:ID:REPEAT')
const smoke=mode==='smoke',repeatStart=selectedCase?Number(selectedCase[2]):mode.startsWith('repeat-')?Number(mode.slice(7)):0
const cases=selectedCase?protocol.cases.filter(c=>c.id===selectedCase[1]):smoke?[protocol.cases.find(c=>c.id==='new-dsh')]:protocol.cases
if(!cases.length)throw new Error('Unknown case')
mkdirSync(output,{recursive:true})
const manifest={version:'b0-autonomy-v2',startedAt:new Date().toISOString(),smoke,repeatStart,repetitions:mode==='all'?protocol.repetitions:1,
 cases:cases.map(c=>({id:c.id,familyId:c.familyId})),source:sourceManifest(),model:{provider:config.provider,model:config.model,reasoningEffort:'provider-default'},
 budgets:{analysisInputChars:100000,perCaseMs:240000},sampling:protocol.scope,
 endpoints:'Completed native turn, or live user-questions/request matched to a pending durable ask_user_question call with no new execution. Cleanup cancellation follows the captured waiting endpoint.',
 workspaceMetrics:'Legacy sourceUnchanged remains source.json-only; workspaceChanges covers all entries from setup through endpoint, measuredWorkspaceChanges excludes seed/setup changes.',
 evaluationTools:Object.fromEntries(['run-autonomy.js','run-autonomy-batch.js','autonomy-probe.js','autonomy-observation.js','autonomy-cases.json','score-autonomy.js','account-autonomy.js','account-autonomy-tree.js','postprocess-autonomy-batch.js','review-autonomy.js','run-harness.js','fixture.js','score.js'].map(f=>[f,digest(readFileSync(new URL(f,import.meta.url)))]))}
writeFileSync(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'})
writeFileSync(path.join(output,'run-config.json'),JSON.stringify(config,null,2)+'\n',{flag:'wx'})
const rows=[];let harness,failure=null,cleanup=null
try {
 harness=await startHarness({...config,probe:'autonomy-probe.js'})
 writeFileSync(path.join(output,'runtime.json'),JSON.stringify({root:harness.root},null,2)+'\n')
 for(let repeat=repeatStart;repeat<repeatStart+manifest.repetitions;repeat++)for(const item of cases){
  const request={purpose:'autonomy',input:item.input,budgetMs:manifest.budgets.perCaseMs}
  appendFileSync(path.join(output,'inputs.jsonl'),JSON.stringify({caseId:item.id,repeat,request})+'\n')
  let result
  try{result=await harness.infer(request)}catch(error){result=error.measurement??{ok:false,error:{name:error.name,message:error.message}}}
  rows.push({caseId:item.id,familyId:item.familyId,repeat,result})
  appendFileSync(path.join(output,'results.jsonl'),JSON.stringify(rows.at(-1))+'\n')
  console.log(JSON.stringify({caseId:item.id,repeat:repeat+1,ok:result.ok,elapsedMs:result.elapsedMs,error:result.error??null}))
 }
}catch(error){failure={name:error.name,message:error.message}}
finally{
 if(harness)cleanup=await harness.close()
 const summary={completedAt:new Date().toISOString(),planned:cases.length*manifest.repetitions,completed:rows.length,failed:rows.filter(r=>!r.result.ok).length,failure,cleanup,
 sourceUnchanged:sourceManifest().sha256===manifest.source.sha256,latencyMs:{p50:quantile(rows.map(r=>r.result.elapsedMs).filter(Number.isFinite),.5),p95:quantile(rows.map(r=>r.result.elapsedMs).filter(Number.isFinite),.95)},sessionLogRoot:harness?.root??null}
 writeFileSync(path.join(output,'summary.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary))
 if(failure||summary.failed||!summary.sourceUnchanged)process.exitCode=1
}
