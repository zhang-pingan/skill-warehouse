import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import test from 'node:test'
import { resolveConfig } from '../lib/config.js'
import { PersonalAgentService } from '../lib/service.js'

const workerFlags = ['codex.daemon.connect', 'codex.new_thread.execute', 'routing.resume', 'routing.fork']

test('Codex workspace capabilities default on independently of worker authorization and accept explicit overrides', () => {
  const defaults = resolveConfig({}, {})
  assert.equal(defaults.experimentalCodexApi, true)
  assert.equal(defaults.codexWorkerEnabled, false)
  assert.equal(resolveConfig({}, { DSH_PERSONAL_AGENT_CODEX_EXPERIMENTAL: 'false' }).experimentalCodexApi, false)
  assert.equal(resolveConfig({ experimentalCodexApi: false }, { DSH_PERSONAL_AGENT_CODEX_EXPERIMENTAL: 'true' }).experimentalCodexApi, false)
  assert.equal(resolveConfig({ experimentalCodexApi: true }, { DSH_PERSONAL_AGENT_CODEX_EXPERIMENTAL: 'false' }).experimentalCodexApi, true)
})

async function fixture(t, enabled = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pac-codex-setting-'))
  const config = resolveConfig({ dataDir: path.join(root, 'data'), codexHome: path.join(root, 'codex'), codexWorkerEnabled: enabled })
  const service = new PersonalAgentService(config)
  t.after(async () => { await service.dispose(); rmSync(root, { recursive: true, force: true }) })
  await service.initialize()
  return { service, config }
}

test('the Codex switch enables task operations together and disables them with the connection', async t => {
  const { service } = await fixture(t)
  await service.setCodexEnabled(true)
  for (const key of workerFlags) assert.equal(service.flags.enabled(key), true)
  for (const method of ['thread/start', 'thread/resume', 'thread/fork', 'turn/start']) assert.equal(service.isCodexMutationAuthorized(method), true)
  assert.equal(service.flags.enabled('control.steer'), false)
  assert.equal(service.flags.enabled('control.queue'), false)
  service.updateRuntimeSettings({ defaultWorkerPriority: 'codex' })
  await service.setCodexEnabled(false)
  for (const key of workerFlags) assert.equal(service.flags.enabled(key), false)
  assert.equal(service.config.defaultWorkerPriority, 'dsh_standard')
  assert.equal(service.adapter.initialized, false)
  assert.equal(service.isCodexMutationAuthorized('turn/start'), false)
})

test('saved enablement repairs old closed flags on restart without connecting during initialization', async t => {
  const { service, config } = await fixture(t)
  await service.setCodexEnabled(true)
  service.database.db.prepare("UPDATE feature_flags SET enabled=0,source='default' WHERE flag_name IN ('codex.daemon.connect','codex.new_thread.execute','routing.resume','routing.fork')").run()
  await service.dispose()
  const restored = new PersonalAgentService(config)
  try {
  await restored.initialize()
  assert.equal(restored.config.codexWorkerEnabled, true)
  for (const key of workerFlags) assert.equal(restored.flags.enabled(key), true)
  assert.equal(restored.adapter.connectionEpoch, 0)
  assert.equal(restored.workerCapabilities().codex.connected, false)
  } finally { await restored.dispose() }
})

test('disabling Codex selects an allowed default without expanding worker permissions', async t => {
  const { service } = await fixture(t, true)
  service.updateRuntimeSettings({ defaultWorkerPriority: 'codex', dshWorkerPresets: ['cordis'], dshWorkerEnabled: false })
  await service.setCodexEnabled(false)
  assert.equal(service.config.defaultWorkerPriority, 'dsh_cordis')
  assert.deepEqual(service.config.dshWorkerPresets, ['cordis'])
  assert.equal(service.config.dshWorkerEnabled, false)
  for (const key of workerFlags) assert.equal(service.flags.enabled(key), false)

  await service.setCodexEnabled(true)
  assert.equal(service.config.defaultWorkerPriority, 'dsh_cordis')
  service.updateRuntimeSettings({ dshWorkerPresets: ['cordis', 'standard'] })
  await service.setCodexEnabled(false)
  assert.equal(service.config.defaultWorkerPriority, 'dsh_cordis')

  await service.setCodexEnabled(true)
  service.updateRuntimeSettings({ defaultWorkerPriority: 'codex' })
  await service.setCodexEnabled(false)
  assert.equal(service.config.defaultWorkerPriority, 'dsh_standard')
})

test('disabling Codex without an allowed fallback preserves settings and permissions', async t => {
  const { service } = await fixture(t, true)
  service.updateRuntimeSettings({ defaultWorkerPriority: 'codex', dshWorkerPresets: ['ptc'] })
  const before = service.runtimeSettingsView().settings
  const cleanup = t.mock.method(service, 'waitForCodexHistoryScans', async () => {})
  await assert.rejects(service.setCodexEnabled(false), error => {
    assert.equal(error.code, 'CODEX_DEFAULT_WORKER_REQUIRED')
    assert.match(error.message, /标准模式.*创造模式/u)
    return true
  })
  assert.deepEqual(service.runtimeSettingsView().settings, before)
  for (const key of workerFlags) assert.equal(service.flags.enabled(key), true)
  assert.equal(cleanup.mock.callCount(), 0)
})

test('a failed import or cleanup preserves the previous switch and task permissions', async t => {
  const { service } = await fixture(t)
  const original = service.codexImporter.run
  service.codexImporter.run = async () => { throw new Error('fixture import failure') }
  await assert.rejects(service.setCodexEnabled(true), /fixture import failure/)
  assert.equal(service.config.codexWorkerEnabled, false)
  for (const key of workerFlags) assert.equal(service.flags.enabled(key), false)
  service.codexImporter.run = original
  await service.setCodexEnabled(true)
  service.updateRuntimeSettings({ defaultWorkerPriority: 'codex' })
  t.mock.method(service, 'waitForCodexHistoryScans', async () => { throw new Error('fixture cleanup failure') })
  await assert.rejects(service.setCodexEnabled(false), /fixture cleanup failure/)
  assert.equal(service.config.codexWorkerEnabled, true)
  assert.equal(service.config.defaultWorkerPriority, 'codex')
  for (const key of workerFlags) assert.equal(service.flags.enabled(key), true)
})

test('settings and permission flags commit atomically', async t => {
  const { service } = await fixture(t)
  const set = service.flags.set.bind(service.flags)
  t.mock.method(service.flags, 'set', (key, enabled, options) => {
    if (key === 'routing.resume') throw new Error('fixture write failure')
    return set(key, enabled, options)
  })
  await assert.rejects(service.setCodexEnabled(true), /fixture write failure/)
  assert.equal(service.config.codexWorkerEnabled, false)
  assert.equal(service.database.db.prepare('SELECT 1 FROM runtime_settings').get(), undefined)
  for (const key of workerFlags) assert.equal(service.flags.enabled(key), false)
})

test('connection attempts coalesce, expose failure and allow a later retry', async t => {
  const { service } = await fixture(t, true)
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  let attempts = 0
  t.mock.method(service.daemon, 'ensureStarted', async () => { attempts++; entered.resolve(); await release.promise; return {} })
  t.mock.method(service.adapter, 'connect', async () => { throw new Error('fixture connection unavailable') })
  const first = service.connectCodex(), second = service.connectCodex()
  const outcomes = Promise.allSettled([first, second])
  await entered.promise
  assert.equal(first, second)
  assert.equal(service.workerCapabilities().codex.connecting, true)
  assert.equal(service.workerCapabilities().codex.connected, false)
  release.resolve()
  assert.ok((await outcomes).every(result => result.status === 'rejected'))
  assert.equal(attempts, 1)
  assert.equal(service.workerCapabilities().codex.connectionError, 'fixture connection unavailable')
  assert.equal(service.config.codexWorkerEnabled, true)
  t.mock.method(service.adapter, 'connect', async () => { service.adapter.initialized = true; return {} })
  await service.connectCodex()
  assert.equal(service.workerCapabilities().codex.connectionError, null)
  assert.equal(service.workerCapabilities().codex.connected, true)
})

test('turning off during a pending connection drains it without reopening the socket', async t => {
  const { service } = await fixture(t, true)
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  let connections = 0
  t.mock.method(service.daemon, 'ensureStarted', async () => { entered.resolve(); await release.promise; return {} })
  t.mock.method(service.adapter, 'connect', async () => { connections++; return {} })
  const connecting = service.connectCodex()
  const outcome = Promise.allSettled([connecting])
  await entered.promise
  const scans = Promise.withResolvers()
  t.mock.method(service, 'waitForCodexHistoryScans', async () => { scans.resolve() })
  const disabled = service.setCodexEnabled(false)
  await scans.promise
  assert.equal(service.config.codexWorkerEnabled, false)
  release.resolve()
  await disabled
  assert.equal((await outcome)[0].status, 'rejected')
  assert.equal(connections, 0)
  assert.equal(service.codexConnectionOperation, null)
  assert.equal(service.codexConnectionError, null)
})

test('active or uncertain Codex work keeps the switch enabled', async t => {
  const { service } = await fixture(t, true)
  const task = service.ledger.createTask({ objective: 'Fixture work', acceptance: ['Verified'] })
  service.ledger.planExecution({ taskId: task.taskId, executorKind: 'codex', method: 'thread/start', params: {}, mutatesWorkspace: false })
  await assert.rejects(service.setCodexEnabled(false), { code: 'CODEX_WORKER_BUSY' })
  assert.equal(service.config.codexWorkerEnabled, true)
  for (const key of workerFlags) assert.equal(service.flags.enabled(key), true)
})

test('models cannot enable Codex and operator flags cannot bypass the settings switch', async t => {
  const { service } = await fixture(t)
  await assert.rejects(service.operate({ action: 'set_feature', key: 'codex.daemon.connect', enabled: true }), /authenticated operator/)
  await assert.rejects(service.operate({ action: 'set_feature', key: 'codex.daemon.connect', enabled: true }, { featureAuthority: true }), /Codex settings switch/)
  assert.equal(service.config.codexWorkerEnabled, false)
})
