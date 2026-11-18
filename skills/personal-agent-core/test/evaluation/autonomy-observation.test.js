/** Focused regressions for request-backed clarification and complete workspace mutation detection. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { pendingQuestionEndpoint, snapshotWorkspace, compareWorkspaces } from './autonomy-observation.js'

const questions=[{id:'project',question:'Which project should continue?',options:[{label:'Ruby'},{label:'Sapphire'}]}]
const call={type:'tool/call',seq:21,data:{name:'ask_user_question',callId:'ask-1',arguments:JSON.stringify({questions})}}
const observation={sessionId:'main',events:[call]}
const request={sessionId:'main',callId:'ask-1',questions,settled:false,observedAt:'2026-11-18T00:00:00Z'}

test('waiting requires a live matching request and unresolved durable tool call without dispatch',()=>{
 const endpoint=pendingQuestionEndpoint(observation,[request],{mainSeq:20})
 assert.equal(endpoint.kind,'waiting_user')
 assert.equal(endpoint.callId,'ask-1')
 assert.equal(endpoint.callSeq,21)
 assert.equal(pendingQuestionEndpoint(observation,[]),null)
 assert.equal(pendingQuestionEndpoint({...observation,events:[]},[request]),null)
 assert.equal(pendingQuestionEndpoint(observation,[{...request,callId:'other'}]),null)
 assert.equal(pendingQuestionEndpoint(observation,[{...request,sessionId:'child'}]),null)
 assert.equal(pendingQuestionEndpoint(observation,[{...request,questions:[{id:'project',question:'Unrelated?'}]}]),null)
 assert.equal(pendingQuestionEndpoint(observation,[request],{mainSeq:22}),null)
 assert.equal(pendingQuestionEndpoint(observation,[request],{newExecutionCount:1}),null)
 assert.equal(pendingQuestionEndpoint(observation,[{...request,settled:true}]),null)
 assert.equal(pendingQuestionEndpoint(observation,[{...request,signal:AbortSignal.abort()}]),null)
 const answered={type:'tool/result',seq:22,data:{message:{toolCallId:'ask-1'}}}
 assert.equal(pendingQuestionEndpoint({...observation,events:[call,answered]},[request]),null)
})

test('legacy indefinite requests without call id must match exactly one durable question batch',()=>{
 const legacy={...request,callId:null}
 assert.equal(pendingQuestionEndpoint(observation,[legacy]).callId,'ask-1')
 const other={...call,seq:22,data:{...call.data,callId:'ask-2'}}
 assert.equal(pendingQuestionEndpoint({...observation,events:[call,other]},[legacy]),null)
 const prose={type:'assistant/message',seq:23,data:{message:{content:[{type:'text',text:'Which project should continue?'}]}}}
 assert.equal(pendingQuestionEndpoint({...observation,events:[prose]},[legacy]),null)
})

test('workspace observation detects extra files, removed files, changed content and symlinks with source.json intact',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'autonomy-observation-'))
 try{
  await writeFile(path.join(root,'source.json'),'{}\n')
  await writeFile(path.join(root,'remove.txt'),'remove')
  await writeFile(path.join(root,'change.txt'),'before')
  const before=await snapshotWorkspace(root)
  assert.equal(compareWorkspaces(before,await snapshotWorkspace(root)).unchanged,true)
  await writeFile(path.join(root,'acceptance.json'),'{}\n')
  await rm(path.join(root,'remove.txt'))
  await writeFile(path.join(root,'change.txt'),'after')
  await mkdir(path.join(root,'empty'))
  await symlink('missing-target',path.join(root,'link'))
  const after=await snapshotWorkspace(root)
  assert.deepEqual(before.entries['source.json'],after.entries['source.json'])
  const changes=compareWorkspaces(before,after)
  assert.equal(changes.unchanged,false)
  assert.deepEqual(changes.added,['acceptance.json','empty','link'])
  assert.deepEqual(changes.removed,['remove.txt'])
  assert.deepEqual(changes.changed,['change.txt'])
  assert.equal(after.entries.link.target,'missing-target')
 }finally{await rm(root,{recursive:true,force:true})}
})

test('scorer accepts a request-backed clarification and separately rejects an extra workspace file',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'autonomy-score-'))
 try{
  const declared=JSON.parse(await readFile(new URL('./autonomy-cases.json',import.meta.url),'utf8')).cases.find(item=>item.id==='ambiguous-project')
  const question={id:'identify',question:'请确认哪个项目需要继续？'}
  const recorded={sessionId:'main',text:'',endings:[],events:[{...call,data:{...call.data,arguments:JSON.stringify({questions:[question]})}}]}
  const endpoint=pendingQuestionEndpoint(recorded,[{...request,questions:[question]}],{mainSeq:20})
  const unchanged={unchanged:true,added:[],removed:[],changed:[]}
  const base={caseId:declared.id,familyId:declared.familyId,repeat:0,result:{ok:true,sourceUnchanged:true,
   endpoint,observation:recorded,measurementBoundary:{mainSeq:20,seedExecutionIds:[]},executions:[],
   tasks:[{taskId:'a'},{taskId:'b'}],workspaceChanges:unchanged}}
  const changed=structuredClone(base);changed.repeat=1;changed.result.workspaceChanges={...unchanged,unchanged:false,added:['acceptance.json']}
  const prose=structuredClone(base);prose.repeat=2;prose.result.observation.events=[]
  await writeFile(path.join(root,'results.jsonl'),[base,changed,prose].map(row=>JSON.stringify(row)).join('\n')+'\n')
  execFileSync(process.execPath,[new URL('./score-autonomy.js',import.meta.url).pathname,root],{stdio:'pipe'})
  const scores=JSON.parse(await readFile(path.join(root,'scores.json'),'utf8')).scores
  assert.equal(scores[0].passed,true)
  assert.equal(scores[0].turnCompleted,false)
  assert.equal(scores[1].legacyPassed,true)
  assert.equal(scores[1].passed,false)
  assert.deepEqual(scores[1].workspace.added,['acceptance.json'])
  assert.equal(scores[2].checks.clarificationEvidence,false)
  assert.equal(scores[2].passed,false)
 }finally{await rm(root,{recursive:true,force:true})}
})
