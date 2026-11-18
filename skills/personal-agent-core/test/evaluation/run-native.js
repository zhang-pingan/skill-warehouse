/** Frozen exploratory native-model baseline; no optimization and no holdout queries. */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { digest, loadJson, sourceManifest } from './fixture.js'
import { startHarness } from './run-harness.js'
import { quantile } from './score.js'
import { resolveConfig } from '../../lib/config.js'

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const output = path.resolve(process.argv[3])
const stage = process.argv[4] ?? 'main'
if (!['main','workers','codex'].includes(stage)) throw new Error('Stage must be main, workers or codex')
const corpus = loadJson('corpus.json'), labels = loadJson('cases.json')
const categories = new Set()
const families = corpus.families.filter(f => f.split === 'explore' && !categories.has(f.category) && categories.add(f.category))
const selected = families.map(f => labels.cases.find(c => c.familyId === f.id && c.kind === 'qa'))
selected.push(...labels.cases.filter(c => ['case-001-abstain','case-006-abstain'].includes(c.id)))
const source = { records: [{ id:'r1', group:'A', amount:12, active:true },{ id:'r2', group:'B', amount:8, active:true },{ id:'r3', group:'A', amount:5, active:true },{ id:'r4', group:'A', amount:100, active:false }],
  rules: ['仅统计 active=true 的记录。','输出按 group 升序排列的 groups 数组，每个对象只有 group 和 total。','顶层保留 currency=CNY；不要改写源文件。'], note: '这是合成测试数据。' }
const query = '这是全新任务。读取工作目录中的 source.json，按其中规则汇总记录。最终只输出 JSON 对象，包含 currency 和 groups。无需创建或修改文件，不需要查询其他历史。'
const continuation = '继续同一任务，沿用上轮数据和规则，新增一条 group=B、amount=4、active=true 的记录后重新汇总。只输出相同结构的 JSON，不修改源文件。'
const cases = stage === 'main' ? selected.map(c => ({ id:c.id, familyId:c.familyId, purpose:'native-main', input:{query:c.query, asOf:c.request.asOf, observedAt:corpus.asOf ?? '2026-11-18T00:00:00.000Z', timeZone:'UTC'} }))
  : (stage==='codex'?['codex']:['dsh','codex']).map(backend => ({id:`worker-${backend}-aggregate`,familyId:'worker-aggregate',purpose:'native-worker',input:{backend,source,query,continuation}}))
mkdirSync(output,{recursive:true})
const manifest = {version:'b0-native-v5',startedAt:new Date().toISOString(),stage,repetitions:3,cases:cases.map(c=>({id:c.id,familyId:c.familyId})),
  experimentalCodexApi:resolveConfig({experimentalCodexApi:config.experimentalCodexApi},{}).experimentalCodexApi,
  source:sourceManifest(),corpusSha256:digest(readFileSync(new URL('./corpus.json',import.meta.url))),casesSha256:digest(readFileSync(new URL('./cases.json',import.meta.url))),
  model:{provider:config.provider,model:config.model,reasoningEffort:'provider-default'},budgets:{analysisInputChars:100000,perCaseMs:stage==='main'?120000:240000},
  sampling:stage==='main'?'First explore family in every category, QA only, plus fixed no-evidence cases 001 and 006; no holdout.':'One synthetic arithmetic/artifact scenario, new and continued session, three repetitions per real backend. Not an estimate of broad coding quality.',
  scoring:'Original responses and native endings retained; QA reviewed against independent source/evidence rubric. Worker exact JSON and same-session assertion. Errors retained.',
  evaluationTools:Object.fromEntries(['run-native.js','native-probe.js','run-harness.js','fixture.js','score.js',...(stage!=='main'?['score-workers.js']:[])].map(f=>[f,digest(readFileSync(new URL(f,import.meta.url)))]))}
writeFileSync(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'})
writeFileSync(path.join(output,'run-config.json'),JSON.stringify(config,null,2)+'\n',{flag:'wx'})
const rows=[];let harness, failure=null, cleanup=null
try {
  harness=await startHarness({...config,probe:'native-probe.js'})
  writeFileSync(path.join(output,'runtime.json'),JSON.stringify({root:harness.root},null,2)+'\n')
  for(let repeat=0;repeat<3;repeat++) for(const item of cases) {
    const request={purpose:item.purpose,input:item.input,budgetMs:manifest.budgets.perCaseMs}
    appendFileSync(path.join(output,'inputs.jsonl'),JSON.stringify({caseId:item.id,repeat,request})+'\n')
    let result
    try { result=await harness.infer(request) } catch(error) {result=error.measurement??{ok:false,error:{name:error.name,message:error.message}}}
    const row={caseId:item.id,familyId:item.familyId,repeat,result}
    rows.push(row);appendFileSync(path.join(output,'results.jsonl'),JSON.stringify(row)+'\n')
    console.log(JSON.stringify({caseId:item.id,repeat:repeat+1,ok:result.ok,elapsedMs:result.elapsedMs,error:result.error??null}))
  }
} catch(error) {failure={name:error.name,message:error.message}}
finally {
  if(harness)cleanup=await harness.close()
  const summary={completedAt:new Date().toISOString(),planned:cases.length*3,completed:rows.length,failed:rows.filter(r=>!r.result.ok).length,failure,cleanup,sourceUnchanged:sourceManifest().sha256===manifest.source.sha256,
    latencyMs:{p50:quantile(rows.map(r=>r.result.elapsedMs).filter(Number.isFinite),0.5),p95:quantile(rows.map(r=>r.result.elapsedMs).filter(Number.isFinite),0.95)},qualityScoring:'pending independent source review',sessionLogRoot:harness?.root??null}
  writeFileSync(path.join(output,'summary.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary))
  if(failure||summary.failed||!summary.sourceUnchanged)process.exitCode=1
}
