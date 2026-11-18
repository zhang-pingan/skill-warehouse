import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { resolveConfig } from '../lib/config.js'
import { defaultRuntimeSettings, resolveRuntimeSettings } from '../lib/runtime-settings.js'

const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const helpers = client.slice(client.indexOf('const settingUnits = Object.freeze('), client.indexOf('    function presetLabel('))
const controller = client.slice(client.indexOf('    function createSettingsController('), client.indexOf('    async function requestMemory('))
const plain = value => JSON.parse(JSON.stringify(value))

function fixture(overrides = {}) {
  const defaults = defaultRuntimeSettings(resolveConfig())
  let saved = { ...defaults }, writes = [], codexWrites = [], timers = new Map(), sequence = 0
  const response = () => ({ settings: structuredClone(saved), defaults, presets: overrides.presets ?? ['standard', 'cordis', 'ptc', 'minimal'].map(id => ({ id })), jobs: [], progress: {} })
  const make = runInNewContext(`${helpers}\n${controller}\ncreateSettingsController`, {
    TextEncoder,
    setTimeout: fn => { const id = ++sequence; timers.set(id, fn); return id },
    clearTimeout: id => timers.delete(id),
    requestSettings: async (method, patch) => {
      if (method === 'PUT') {
        writes.push(plain(patch))
        await overrides.put?.(patch, writes.length)
        saved = resolveRuntimeSettings(plain(patch), saved)
      }
      return response()
    },
    requestCodexToggle: async enabled => {
      codexWrites.push(enabled)
      await overrides.codex?.(enabled)
      saved = { ...saved, codexWorkerEnabled: enabled }
      return response()
    },
  })
  return { store: make(key => key), writes, codexWrites, timers, saved: () => saved }
}

function barrier() { return Promise.withResolvers() }
async function settle(store) { await store.flush(); await store.flush() }

test('switches apply only their changed field and pending edits survive page subscriptions', async () => {
  const f = fixture(); await f.store.load()
  const unsubscribe = f.store.subscribe(() => {})
  f.store.edit({ backupEnabled: false }, true)
  await settle(f.store)
  assert.deepEqual(f.writes, [{ backupEnabled: false }])
  assert.equal(f.store.getSnapshot().saveState, 'saved')
  f.store.edit({ historyRetentionDays: 45 })
  unsubscribe()
  await f.store.flush()
  assert.equal(f.saved().historyRetentionDays, 45)
  assert.equal(f.timers.size, 0)
  await f.store.dispose()
})

test('an in-flight write cannot replace a newer edit and writes remain serial', async () => {
  const started = barrier(), release = barrier()
  const f = fixture({ put: async (_, count) => { if (count === 1) { started.resolve(); await release.promise } } })
  await f.store.load()
  f.store.edit({ backupEnabled: false }, true)
  await started.promise
  f.store.edit({ backupEnabled: true, historyRetentionDays: 50 }, true)
  assert.equal(f.writes.length, 1)
  release.resolve()
  await settle(f.store)
  assert.deepEqual(f.writes, [{ backupEnabled: false }, { backupEnabled: true, historyRetentionDays: 50 }])
  assert.equal(f.store.getSnapshot().draft.historyRetentionDays, 50)
  assert.equal(f.saved().backupEnabled, true)
  await f.store.dispose()
})

test('unfinished numeric and model policy edits stay visible while unrelated valid changes apply', async () => {
  const f = fixture(); await f.store.load()
  f.store.edit({ historyRetentionDays: '', modelPolicies: [{ _key: 'new', name: 'analysis', worker: 'dsh_subagent', provider: '', model: '' }] })
  f.store.edit({ backupEnabled: false }, true)
  await settle(f.store)
  assert.deepEqual(f.writes, [{ backupEnabled: false }])
  assert.equal(f.store.getSnapshot().saveState, 'invalid')
  assert.equal(f.store.getSnapshot().draft.historyRetentionDays, '')
  assert.ok(f.store.getSnapshot().formErrors['policy-new-provider'])
  f.store.edit({ historyRetentionDays: 40, modelPolicies: [{ _key: 'new', name: 'analysis', worker: 'dsh_subagent', provider: 'fixture', model: 'model', effort: '' }] })
  await settle(f.store)
  assert.equal(f.saved().modelPolicies.analysis.model, 'model')
  assert.equal(f.saved().historyRetentionDays, 40)
  await f.store.dispose()
})

test('coupled heartbeat settings apply atomically after the pair becomes valid', async () => {
  const f = fixture(); await f.store.load()
  f.store.edit({ workerHeartbeatMs: 150 })
  await f.store.flush()
  assert.equal(f.writes.length, 0)
  assert.ok(f.store.getSnapshot().formErrors.workerHeartbeatMs)
  f.store.edit({ leaseTtlMs: 400 })
  await settle(f.store)
  assert.deepEqual(f.writes, [{ leaseTtlMs: 400000, workerHeartbeatMs: 150000 }])
  await f.store.dispose()
})

test('default priority and allowed presets apply atomically', async () => {
  const f=fixture();await f.store.load()
  f.store.edit({dshWorkerPresets:['cordis'],defaultWorkerPriority:'dsh_cordis'},true)
  await settle(f.store)
  assert.equal(f.writes.length,1)
  assert.deepEqual(f.saved().dshWorkerPresets,['cordis'])
  assert.equal(f.saved().defaultWorkerPriority,'dsh_cordis')
  await f.store.dispose()
})

test('failed saves keep the draft and stop until an explicit retry', async () => {
  const f = fixture({ put: (_, count) => { if (count === 1) throw new Error('offline') } })
  await f.store.load()
  f.store.edit({ backupEnabled: false })
  await f.store.flush()
  assert.equal(f.store.getSnapshot().saveState, 'error')
  assert.equal(f.store.getSnapshot().error, 'offline')
  assert.equal(f.store.getSnapshot().draft.backupEnabled, false)
  assert.equal(f.writes.length, 1)
  assert.equal(f.timers.size, 0)
  await settle(f.store)
  assert.equal(f.saved().backupEnabled, false)
  assert.equal(f.store.getSnapshot().error, '')
  await f.store.dispose()
})

test('Codex uses its dedicated endpoint and teardown waits for the accepted operation', async () => {
  const started = barrier(), release = barrier()
  const f = fixture({ codex: async () => { started.resolve(); await release.promise } })
  await f.store.load()
  const operation = f.store.toggleCodex(true)
  await started.promise
  assert.equal(f.store.getSnapshot().codexBusy, 'enabling')
  assert.equal(f.store.getSnapshot().draft.codexWorkerEnabled, false)
  await f.store.toggleCodex(true)
  assert.deepEqual(f.codexWrites, [true])
  let disposed = false
  const teardown = f.store.dispose().then(() => { disposed = true })
  await Promise.resolve()
  assert.equal(disposed, false)
  release.resolve(); await operation; await teardown
  assert.equal(f.saved().codexWorkerEnabled, true)
  assert.equal(f.writes.length, 0)
  assert.equal(f.timers.size, 0)
})

test('teardown flushes the pending debounce and refuses new edits', async () => {
  const started = barrier(), release = barrier()
  const f = fixture({ put: async () => { started.resolve(); await release.promise } })
  await f.store.load()
  f.store.edit({ historyRetentionDays: 55 })
  const teardown = f.store.dispose()
  await started.promise
  f.store.edit({ historyRetentionDays: 60 }, true)
  release.resolve(); await teardown
  assert.equal(f.saved().historyRetentionDays, 55)
  assert.equal(f.timers.size, 0)
})

test('an unavailable worker preset does not prevent changing an unrelated setting', async () => {
  const f = fixture({ presets: [{ id: 'standard' }] }); await f.store.load()
  f.store.edit({ backupEnabled: false }, true)
  await settle(f.store)
  assert.deepEqual(f.writes, [{ backupEnabled: false }])
  await f.store.dispose()
})

test('Codex priority is rejected while Codex is disabled', async () => {
  const f=fixture();await f.store.load()
  f.store.edit({defaultWorkerPriority:'codex'},true)
  await settle(f.store)
  assert.equal(f.writes.length,0)
  assert.equal(f.store.getSnapshot().saveState,'invalid')
  await f.store.dispose()
})

test('conversation names autosave while empty and over-budget names stay in the draft', async () => {
  const f = fixture(); await f.store.load()
  f.store.edit({ mainSessionTitle: '小鲸鱼' }); await settle(f.store)
  assert.equal(f.saved().mainSessionTitle, '小鲸鱼')
  for (const value of ['', '鲸'.repeat(17)]) {
    f.store.edit({ mainSessionTitle: value }); await settle(f.store)
    assert.ok(f.store.getSnapshot().formErrors.mainSessionTitle)
    assert.equal(f.saved().mainSessionTitle, '小鲸鱼')
  }
  f.store.edit({ mainSessionTitle: '鲸鱼娘' }); await settle(f.store)
  assert.equal(f.saved().mainSessionTitle, '鲸鱼娘')
  await f.store.dispose()
})
