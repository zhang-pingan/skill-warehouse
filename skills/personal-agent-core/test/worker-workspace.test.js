import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, symlink, rm, readdir, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { canonicalDirectory, assertAllowedDirectory, normalizeWorkspaceRoots, codexDefaultWorkspaceRoot, createCodexWorkspace } from '../lib/worker-workspace.js'
import { resolveConfig } from '../lib/config.js'
import { PersonalAgentService } from '../lib/service.js'

async function fixture(t) {
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'pac-workspaces-')))
  t.after(()=>rm(root,{recursive:true,force:true}))
  return root
}

test('workspace roots accept empty lists and canonicalize duplicates but reject relative paths',()=>{
  assert.deepEqual(resolveConfig({},{}).allowedWorkspaceRoots,[])
  assert.deepEqual(normalizeWorkspaceRoots(['/projects/a','/projects/a/','/projects/b']),['/projects/a','/projects/b'])
  for(const value of [null,'/project',['relative'],['/one\n/two'],['']])assert.throws(()=>normalizeWorkspaceRoots(value))
})

test('allowlist includes descendants but rejects sibling prefixes and symlink escapes',async t=>{
  const root=await fixture(t),allowed=path.join(root,'allowed'),outside=path.join(root,'allowed-other')
  await mkdir(path.join(allowed,'child'),{recursive:true});await mkdir(outside)
  await symlink(outside,path.join(allowed,'escape'))
  for(const directory of [allowed,path.join(allowed,'child')])await assertAllowedDirectory(await canonicalDirectory(directory),[allowed])
  for(const directory of [outside,path.join(allowed,'escape')])await assert.rejects(assertAllowedDirectory(await canonicalDirectory(directory),[allowed]),{code:'WORKER_WORKSPACE_NOT_ALLOWED'})
  await assertAllowedDirectory(outside,[])
  await symlink(path.join(root,'missing'),path.join(allowed,'dangling'))
  await assert.rejects(canonicalDirectory(path.join(allowed,'dangling','child'),{allowMissing:true}),{code:'ENOENT'})
})

test('Codex defaults honor desktop and managed roots with a user-home based fallback',async()=>{
  for(const [desktop,managed,expected] of [[null,null,'/user/Documents/Codex'],['/custom',null,'/custom'],['/custom','/managed','/managed']]) {
    const adapter={request:async method=>method==='config/read'?{config:{desktop:{projectlessWorkspaceRoot:desktop}}}:{requirements:{application:{storage:{projectlessWorkspaceRoot:managed}}}}}
    assert.equal(await codexDefaultWorkspaceRoot(adapter,'/user'),expected)
  }
  await assert.rejects(codexDefaultWorkspaceRoot({request:async()=>{throw new Error('disconnected')}},'/user'),/disconnected/)
  await assert.rejects(codexDefaultWorkspaceRoot({request:async()=>({config:{desktop:{projectlessWorkspaceRoot:'relative'}}})},'/user'),/绝对路径/)
})

test('Codex projectless directories use local date and task names and never reuse an existing task folder',async t=>{
  const root=await fixture(t)
  const authorize=directory=>canonicalDirectory(directory,{allowMissing:true})
  const options={root,objective:'Make a report',date:new Date(2026,10,18,12),authorize}
  const [first,second]=await Promise.all([createCodexWorkspace(options),createCodexWorkspace(options)])
  assert.notEqual(first,second)
  assert.deepEqual(new Set([path.basename(first),path.basename(second)]),new Set(['make-a-report','make-a-report-2']))
  assert.equal(path.dirname(first),path.join(root,'2026-11-18'))
  assert.deepEqual((await readdir(first)).sort(),['outputs','work'])
  const chinese=await createCodexWorkspace({...options,objective:'整理文档'})
  assert.equal(path.basename(chinese),'new-chat')
})

test('a disallowed default creates no directories and cancellation stops preparation',async t=>{
  const root=await fixture(t),allowed=path.join(root,'allowed');await mkdir(allowed)
  const authorize=async directory=>{const value=await canonicalDirectory(directory,{allowMissing:true});await assertAllowedDirectory(value,[allowed]);return value}
  await assert.rejects(createCodexWorkspace({root:path.join(root,'outside'),objective:'Task',authorize}),{code:'WORKER_WORKSPACE_NOT_ALLOWED'})
  assert.deepEqual(await readdir(root),['allowed'])
  const controller=new AbortController();controller.abort()
  await assert.rejects(createCodexWorkspace({root:allowed,objective:'Task',authorize,signal:controller.signal}),{name:'AbortError'})
  assert.deepEqual(await readdir(allowed),[])
})

test('shared roots persist through settings reload and empty values override installation defaults',async t=>{
  const root=await fixture(t),config=resolveConfig({dataDir:path.join(root,'data'),codexHome:path.join(root,'codex'),allowedWorkspaceRoots:[root]})
  const service=new PersonalAgentService(config)
  await service.initialize()
  try {
    service.updateRuntimeSettings({allowedWorkspaceRoots:[]})
    assert.deepEqual(service.config.allowedWorkspaceRoots,[])
    assert.throws(()=>service.updateRuntimeSettings({allowedWorkspaceRoots:['relative']}))
    assert.deepEqual(service.config.allowedWorkspaceRoots,[])
  } finally {await service.dispose()}
  const restored=new PersonalAgentService(config)
  try {await restored.initialize();assert.deepEqual(restored.config.allowedWorkspaceRoots,[])}
  finally {await restored.dispose()}
})
