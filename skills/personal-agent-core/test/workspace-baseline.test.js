import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { promisify } from 'node:util'
import { fixture } from './helpers.js'
import { captureWorkspaceBaseline } from '../lib/workspace-baseline.js'

const exec = promisify(execFile)

test('baseline captures git state and never follows relevant symlinks', async () => {
  const f = fixture()
  try {
    const workspace = `${f.root}/workspace`
    mkdirSync(workspace)
    await exec('git', ['init', workspace])
    await exec('git', ['-C', workspace, 'config', 'user.email', 'test@example.com'])
    await exec('git', ['-C', workspace, 'config', 'user.name', 'Test'])
    writeFileSync(`${workspace}/tracked.txt`, 'base\n')
    await exec('git', ['-C', workspace, 'add', 'tracked.txt'])
    await exec('git', ['-C', workspace, 'commit', '-m', 'base'])
    writeFileSync(`${workspace}/tracked.txt`, 'changed\n')
    writeFileSync(`${f.root}/secret.txt`, 'secret\n')
    symlinkSync(`${f.root}/secret.txt`, `${workspace}/link.txt`)
    const baseline = await captureWorkspaceBaseline(workspace, { relevantPaths: ['link.txt'] })
    assert.ok(baseline.gitHead)
    assert.match(baseline.statusPorcelain, /tracked\.txt/)
    assert.equal(baseline.pathHashes['tracked.txt'].state, 'hashed')
    assert.equal(baseline.pathHashes['link.txt'].state, 'symlink')
    assert.equal(baseline.captureComplete, true)
  } finally { f.close() }
})

test('baseline rejects relative workspace paths and outside-root relevant paths', async () => {
  await assert.rejects(captureWorkspaceBaseline('relative'), /absolute/)
  const f = fixture()
  try {
    const baseline = await captureWorkspaceBaseline(f.root, { relevantPaths: ['../outside'] })
    assert.equal(baseline.pathHashes['../outside'].state, 'outside_root')
    assert.equal(baseline.captureComplete, false)
  } finally { f.close() }
})
