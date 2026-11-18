/** Exact JSON and original-session checks for the fixed native aggregation task. */
import {readFileSync,writeFileSync} from 'node:fs'
import {isDeepStrictEqual} from 'node:util'
import path from 'node:path'
const output=path.resolve(process.argv[2])
const manifest=JSON.parse(readFileSync(path.join(output,'manifest.json')))
const rows=readFileSync(path.join(output,'results.jsonl'),'utf8').trim().split('\n').map(JSON.parse)
const expected=[{currency:'CNY',groups:[{group:'A',total:17},{group:'B',total:8}]},{currency:'CNY',groups:[{group:'A',total:17},{group:'B',total:12}]}]
const scores=rows.map(row=>{
 const result=row.result
 const turns=(result.turns??[]).map((turn,i)=>{
  const text=turn.observation?.text??turn.native?.thread?.turns?.at(-1)?.items?.filter(item=>item.type==='agentMessage').at(-1)?.text??''
  let parsed=null,parseError=null
  try{parsed=JSON.parse(text.trim().replace(/^```(?:json)?\s*/u,'').replace(/\s*```$/u,''))}catch(error){parseError=error.message}
  return {stage:i===0?'new':'continue',completed:turn.ok,text,parsed,parseError,exactOutput:isDeepStrictEqual(parsed,expected[i])}
 })
 return {caseId:row.caseId,repeat:row.repeat,elapsedMs:result.elapsedMs,sameSession:result.sameSession??false,sourceUnchanged:result.sourceUnchanged??null,
  passed:result.ok===true&&turns.length===2&&turns.every(t=>t.completed&&t.exactOutput)&&result.sameSession===true&&result.sourceUnchanged===true,turns,error:result.error??null}
})
writeFileSync(path.join(output,'scores.json'),JSON.stringify({scoring:'Exact JSON, unchanged source, same backend session; no worker self-rating.',expected,planned:manifest.cases.length*manifest.repetitions,measured:scores.length,passed:scores.filter(s=>s.passed).length,scores},null,2)+'\n')
console.log(JSON.stringify({measured:scores.length,passed:scores.filter(s=>s.passed).length,scores}))
