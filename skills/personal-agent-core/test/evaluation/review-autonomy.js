/** Inspect all delivered main-session reports without replacing the frozen last-report score. */
import {readFileSync,writeFileSync} from 'node:fs'
import {isDeepStrictEqual} from 'node:util'
import path from 'node:path'
import {digest,loadJson} from './fixture.js'
const out=path.resolve(process.argv[2]),protocol=loadJson('autonomy-cases.json')
if(!JSON.parse(readFileSync(path.join(out,'summary.json'))).completedAt)throw new Error('Run must be closed')
const rows=readFileSync(path.join(out,'results.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
function aggregates(text){
 const values=[]
 for(let i=0;i<text.length;i++)if(text[i]==='{')for(let j=i+1;j<text.length;j++)if(text[j]==='}'){
  try{const value=JSON.parse(text.slice(i,j+1));if(value&&typeof value==='object'&&'currency' in value&&Array.isArray(value.groups))values.push(value)}catch(error){/* Only complete aggregation objects count. */}
 }
 return values
}
const reviews=rows.map(row=>{
 const expected=protocol.cases.find(c=>c.id===row.caseId).expected
 const reports=(row.result.observation?.events??[]).filter(e=>e.type==='assistant/message'&&e.surfaceOp==='append'&&e.seq>=(row.result.measurementBoundary?.mainSeq??0)&&!e.data.message.content.some(b=>b.type==='tool-call'))
  .map(e=>({seq:e.seq,turn:e.data.turn,text:e.data.message.content.filter(b=>b.type==='text').map(b=>b.text).join('\n')}))
 const objects=reports.flatMap(r=>aggregates(r.text))
 return {caseId:row.caseId,repeat:row.repeat,reportCount:reports.length,mainTurnsWithReports:[...new Set(reports.map(r=>r.turn))],
  anyExpectedJson:expected.json?objects.some(v=>isDeepStrictEqual(v,expected.json)):null,
  conflictingJson:expected.json?objects.some(v=>!isDeepStrictEqual(v,expected.json)):null,
  reports,executionResultNotices:(row.result.observation?.events??[]).filter(e=>e.type==='user/message'&&JSON.stringify(e.data).includes('personalAgentResultNotice')).length}
})
const result={recordedAt:new Date().toISOString(),reviewerSha256:digest(readFileSync(new URL(import.meta.url))),inputSha256:digest(readFileSync(path.join(out,'results.jsonl'))),
 method:'Post-run descriptive review of the complete response window. The predeclared last-report exact JSON score remains unchanged; a later notification may omit an artifact already delivered in an earlier report. No pass/fail threshold is changed.',reviews}
writeFileSync(path.join(out,'response-review.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({rows:reviews.length,artifactRows:reviews.filter(r=>r.anyExpectedJson!==null).length,artifactDelivered:reviews.filter(r=>r.anyExpectedJson&&!r.conflictingJson).length,multiTurnReports:reviews.filter(r=>r.mainTurnsWithReports.length>1).length}))
