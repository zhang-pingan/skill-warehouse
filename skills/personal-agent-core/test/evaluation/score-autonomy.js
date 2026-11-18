/** Deterministic artifact/identity/state checks; natural-language reasons also require source review. */
import {readFileSync,writeFileSync} from 'node:fs'
import {isDeepStrictEqual} from 'node:util'
import path from 'node:path'
import {digest,loadJson} from './fixture.js'
import {pendingQuestionEndpoint} from './autonomy-observation.js'
const out=path.resolve(process.argv[2]),protocol=loadJson('autonomy-cases.json')
const rows=readFileSync(path.join(out,'results.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
function includesObject(text,expected){
 for(let i=0;i<text.length;i++)if(text[i]==='{')for(let j=i+1;j<text.length;j++)if(text[j]==='}'){
  try{if(isDeepStrictEqual(JSON.parse(text.slice(i,j+1)),expected))return true}catch(error){/* Non-JSON prose and nested fragments are excluded. */}
 }
 return false
}
const scores=rows.map(row=>{
 const gold=protocol.cases.find(c=>c.id===row.caseId).expected,r=row.result,text=r.observation?.text??''
 const seeded=new Set(r.measurementBoundary?.seedExecutionIds??[])
 const executions=(r.executions??[]).filter(e=>!seeded.has(e.execution_id))
 const delegated=executions.filter(e=>e.executor_kind!=='internal')
 const targets=(r.sessions??[]).filter(s=>s.source_kind!=='app_server_turn'&&delegated.some(e=>(r.executionSessions??[]).some(link=>link.execution_id===e.execution_id&&link.session_ref_id===s.session_ref_id&&link.role==='executor')))
 const expectedSession=r.seed?.childId??r.seed?.threadId
 const tasks=(r.tasks??[]).filter(t=>executions.some(e=>e.task_id===t.taskId))
 const waiting=r.endpoint?.kind==='waiting_user'
 const clarification=waiting&&r.endpoint.requestObserved&&r.endpoint.requestPending&&pendingQuestionEndpoint(r.observation,[{...r.endpoint,settled:false}],
  {mainSeq:r.measurementBoundary?.mainSeq??0,newExecutionCount:executions.length})
 const explanation=clarification?r.endpoint.questions.map(question=>[question.question,...(question.options??[]).map(option=>option.label)].join('\n')).join('\n'):text
 const checks={runtimeCompleted:r.ok===true,sourceUnchanged:r.sourceUnchanged===true,
  clarificationEvidence:!waiting||!!clarification,
  dispatch:gold.dispatch?delegated.length>=1:executions.length===0,
  backend:!gold.backend||delegated.length>0&&delegated.every(e=>gold.backend==='codex'?e.executor_kind==='codex':e.executor_kind==='dsh_subagent'),
  exactFinalJson:!gold.json||includesObject(text,gold.json),
  sameSession:!gold.sameSession||targets.length>0&&targets.every(s=>s.external_id===expectedSession),
  acceptance:!gold.acceptance||tasks.length>0&&tasks.every(t=>t.state==='completed'&&t.verification?.results.length>0&&t.verification.results.every(v=>v.state==='passed'&&v.evidenceIds.length>0)),
  taskCount:gold.taskCount===undefined||(r.tasks??[]).length===gold.taskCount,
  forbiddenOutput:!(gold.forbiddenStrings??[]).some(word=>[text,...(r.results??[]).map(record=>JSON.parse(record.result_json).output??'')].some(output=>output.includes(word))),
  explanationMarker:!gold.textIncludesAny||gold.textIncludesAny.some(s=>explanation.includes(s))}
 const legacyPassed=Object.values(checks).every(Boolean)
 const workspaceObserved=r.workspaceChanges!==null&&r.workspaceChanges!==undefined&&!r.workspaceReadError
 const workspaceUnchanged=workspaceObserved?r.workspaceChanges.unchanged:null
 return {caseId:row.caseId,familyId:row.familyId,repeat:row.repeat,passed:legacyPassed&&workspaceUnchanged===true,legacyPassed,checks,text,
  workspace:{observed:workspaceObserved,unchanged:workspaceUnchanged,added:r.workspaceChanges?.added??null,removed:r.workspaceChanges?.removed??null,changed:r.workspaceChanges?.changed??null,error:r.workspaceReadError??null},
  endpoint:r.endpoint??null,turnCompleted:r.observation?.endings.at(-1)?.kind==='completed',
  executions:delegated.map(e=>({id:e.execution_id,kind:e.executor_kind,state:e.execution_state})),targets:targets.map(s=>({system:s.system,id:s.external_id})),tasks:tasks.map(t=>({id:t.taskId,state:t.state,verification:t.verification})),elapsedMs:r.elapsedMs,error:r.error??null}
})
const result={version:'autonomy-score-v2',recordedAt:new Date().toISOString(),rubricSha256:digest(readFileSync(new URL('autonomy-cases.json',import.meta.url))),
 interpretation:'Checks use observed output, durable state and native identity. Waiting requires a live user-questions/request linked to an unresolved durable call and zero new executions. Text markers inspect the verified question for waiting endpoints, otherwise final prose; reasons require manual source review. Legacy source.json checks remain separately visible; complete-workspace changes also affect passed. Repeated/backend variants are correlated coverage, not confidence estimates.',measured:scores.length,passed:scores.filter(s=>s.passed).length,legacyPassed:scores.filter(s=>s.legacyPassed).length,
 byCase:Object.fromEntries([...new Set(scores.map(s=>s.caseId))].map(id=>[id,{measured:scores.filter(s=>s.caseId===id).length,passed:scores.filter(s=>s.caseId===id&&s.passed).length}])),scores}
writeFileSync(path.join(out,'scores.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({measured:result.measured,passed:result.passed,byCase:result.byCase}))
