/** Preserve each closed case, then summarize fixed scores without merging correlated repeats into new families. */
import {readdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import path from 'node:path'
const batch=path.resolve(process.argv[2]),rows=[]
for(const dir of readdirSync(batch,{withFileTypes:true}).filter(d=>d.isDirectory())){
 const out=path.join(batch,dir.name)
 if(!existsSync(path.join(out,'summary.json')))continue
 for(const [script,target] of [['score-autonomy.js','scores.json'],['archive-run.js','cleanup.json'],['account-autonomy-tree.js','usage-tree-diagnostics.json'],['review-autonomy.js','response-review.json']]){
  if(!existsSync(path.join(out,target)))execFileSync(process.execPath,[path.join(import.meta.dirname,script),out],{stdio:'inherit'})
 }
 const scores=JSON.parse(readFileSync(path.join(out,'scores.json'))),review=JSON.parse(readFileSync(path.join(out,'response-review.json'))),usage=JSON.parse(readFileSync(path.join(out,'usage-tree-diagnostics.json')))
 rows.push({caseId:dir.name,scores:scores.scores,review:review.reviews,usage:{dsh:usage.dsh,codex:usage.codex}})
}
const summary={recordedAt:new Date().toISOString(),scored:rows.length,passed:rows.reduce((s,r)=>s+r.scores.filter(v=>v.passed).length,0),rows}
if(existsSync(path.join(batch,'batch-summary.json')))writeFileSync(path.join(batch,'scored-summary.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({batch,scored:summary.scored,passed:summary.passed}))
