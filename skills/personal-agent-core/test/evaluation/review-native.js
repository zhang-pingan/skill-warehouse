/** Evidence and accounting diagnostics for native outputs; semantic pass/fail needs source review. */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { loadJson } from './fixture.js'
const output = path.resolve(process.argv[2])
const rows = readFileSync(path.join(output,'results.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line))
const corpus=loadJson('corpus.json'), cases=loadJson('cases.json')
const sourceKeys = new Map()
for(const family of corpus.families.filter(f=>f.split!=='holdout')) for(const session of family.sessions) for(const [i,message] of session.messages.entries()) sourceKeys.set(message.id,`${session.sourceSystem??(session.worker==='codex'?'codex':'dsh')}:${session.id}@seq:${i+1}`)
const items=rows.map(row=>{
  const c=cases.cases.find(c=>c.id===row.caseId)
  const result=row.result,text=result.text??''
  const citedIds=Object.entries(result.evidenceMap??{}).filter(([id])=>text.includes(id)).map(([,original])=>original)
  const citedSourceKeys = new Set(text.match(/(?:dsh|codex):session-[\w-]+@seq:\d+/gu) ?? [])
  for(const [id,key] of sourceKeys) if(citedSourceKeys.has(key)) citedIds.push(id)
  const required=c?.expected.evidenceMessageIds??[]
  const coverage=required.length?required.filter(id=>citedIds.includes(id)).length/required.length:null
  const usage=result.attempts?.map(attempt=>attempt.usage)??[]
  const usageComplete=usage.length>0&&usage.every(Boolean)
  return {caseId:row.caseId,repeat:row.repeat,completed:result.ok,elapsedMs:result.elapsedMs,text,
    originalEvidenceCoverage:coverage,citedIds:[...new Set(citedIds)],requiredEvidenceIds:required,
    attempts:usage.length,usageComplete,usage:Object.fromEntries(['inputTokens','cacheReadTokens','outputTokens','totalTokens'].map(key=>[key,usage.reduce((sum,u)=>sum+(u?.[key]??0),0)])),
    toolNames:result.toolCalls?.map(call=>call.name)??[],error:result.error??null}
})
const diagnostics={recordedAt:new Date().toISOString(),kind:'Evidence identifier and token accounting diagnostics; not semantic answer quality',
  cacheConvention:'pi-ai omits zero cache reads; token fields are per-attempt, not cumulative sessions.',items,
  usage:Object.fromEntries(['inputTokens','cacheReadTokens','outputTokens','totalTokens'].map(key=>[key,items.reduce((sum,row)=>sum+row.usage[key],0)]))}
writeFileSync(path.join(output,'diagnostics.json'),JSON.stringify(diagnostics,null,2)+'\n')
console.log(JSON.stringify({rows:items.length,completed:items.filter(r=>r.completed).length,fullEvidence:items.filter(r=>r.originalEvidenceCoverage===1).length,usage:diagnostics.usage}))
