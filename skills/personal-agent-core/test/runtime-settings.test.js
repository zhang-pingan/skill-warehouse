import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../lib/config.js'
import { PersonalAgentService } from '../lib/service.js'
import { defaultRuntimeSettings, resolveRuntimeSettings } from '../lib/runtime-settings.js'

test('runtime settings validate user-editable values and keep first-run Cordis defaults', () => {
  const config = resolveConfig({ importIntervalMs: 20 * 60_000, historyRetentionDays: 45, backupRetention: 20, dshWorkerEnabled: false, dshWorkerPresets: ['standard', 'cordis'], defaultDshPreset: 'cordis', workerBudgetMs: 60_000, routeResumeThreshold: 0.9 })
  const defaults = defaultRuntimeSettings(config)
  assert.equal(defaults.importIntervalMs, 20 * 60_000)
  assert.equal(defaults.historyRetentionDays, 45)
  assert.equal(defaults.backupRetention, 20)
  assert.equal(defaults.historyStartupSyncEnabled, true)
  assert.equal(defaults.historyPeriodicSyncEnabled, true)
  assert.equal(defaults.codexWorkerEnabled, false)
  assert.equal(defaults.dshWorkerEnabled, false)
  assert.deepEqual(defaults.dshWorkerPresets, ['standard', 'cordis'])
  assert.equal(defaults.defaultDshPreset, 'cordis')
  assert.equal(defaults.workerBudgetMs, 60_000)
  assert.equal(defaults.routeResumeThreshold, 0.9)
  assert.throws(() => resolveRuntimeSettings({ backupRetention: 1 }, defaults), /backupRetention/)
  assert.throws(() => resolveRuntimeSettings({ inboxRetryEnabled: 'false' }, defaults), /inboxRetryEnabled/)
  assert.throws(() => resolveRuntimeSettings({ codexMutations: true }, defaults), /Unknown setting/)
  assert.throws(() => resolveRuntimeSettings({ dshWorkerPresets: ['standard'], defaultDshPreset: 'cordis' }, defaults), /defaultDshPreset must be included/)
  const changed = resolveRuntimeSettings({ historyStartupSyncEnabled: false, historyPeriodicSyncEnabled: true, dshWorkerEnabled: true, dshWorkerPresets: ['standard', 'ptc'], defaultDshPreset: 'ptc', workerBudgetMs: 90_000, routeResumeThreshold: 0.75 }, defaults)
  assert.equal(changed.historyStartupSyncEnabled, false)
  assert.equal(changed.historyPeriodicSyncEnabled, true)
  assert.equal(changed.defaultDshPreset, 'ptc')
  assert.equal(changed.routeResumeThreshold, 0.75)
})

test('runtime settings persist across service restarts and update extraction atomically', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'personal-agent-settings-test-'))
  const config = resolveConfig({ dataDir: path.join(root, 'data'), codexHome: path.join(root, 'codex') })
  const first = new PersonalAgentService(config)
  let second
  try {
    await first.initialize()
    const current = first.runtimeSettingsView().settings
    const changed = first.updateRuntimeSettings({
      ...current,
      historySyncEnabled: false,
      importIntervalMs: 30 * 60_000,
      inboxRetryEnabled: false,
      backupRetention: 21,
      historyRetentionDays: 45,
      historyBatchSize: 16,
      memoryExtractionEnabled: false,
    })
    assert.equal(changed.previous.historySyncEnabled, true)
    assert.equal(changed.settings.historySyncEnabled, false)
    assert.equal(changed.settings.memoryExtractionEnabled, false)
    assert.equal(first.historyConfig.historyRetentionDays, 45)
    assert.equal(first.codexImporter.config.historyBatchSize, 16)
    const row = first.database.db.prepare('SELECT settings_json FROM runtime_settings WHERE singleton=1').get()
    assert.equal(JSON.parse(row.settings_json).historyRetentionDays, 45)
    assert.equal(JSON.parse(row.settings_json).memoryExtractionEnabled, false)
    assert.throws(() => first.updateRuntimeSettings({ ...changed.settings, backupRetention: 1 }), /backupRetention/)
    assert.equal(first.runtimeSettingsView().settings.memoryExtractionEnabled, false)
    await first.dispose()

    second = new PersonalAgentService(config)
    await second.initialize()
    assert.equal(second.runtimeSettingsView().settings.importIntervalMs, 30 * 60_000)
    assert.equal(second.runtimeSettingsView().settings.historyRetentionDays, 45)
    assert.equal(second.runtimeSettingsView().settings.backupRetention, 21)
    assert.equal(second.runtimeSettingsView().settings.memoryExtractionEnabled, false)
  } finally {
    await second?.dispose()
    if (!first.disposed) await first.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})


test('Inbox retry budgets validate at profile load and when saving runtime settings', () => {
  const config = resolveConfig({ inboxBatchSize: 3, inboxRetryLimit: 2, inboxRetryBudgetMs: 20 })
  const defaults = defaultRuntimeSettings(config)
  assert.equal(defaults.inboxBatchSize, 3)
  assert.equal(defaults.inboxRetryLimit, 2)
  assert.equal(defaults.inboxRetryBudgetMs, 20)
  for (const [key,value] of [['inboxBatchSize',0],['inboxRetryLimit',21],['inboxRetryBudgetMs',60001]]) {
    assert.throws(() => resolveConfig({ [key]: value }), new RegExp(key))
    assert.throws(() => resolveRuntimeSettings({ [key]: value }, defaults), new RegExp(key))
  }
})
