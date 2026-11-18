/** Repeat native lifecycle phases, restart the actual isolated profile, and retain every result. */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { digest, sourceManifest } from './fixture.js'
import { startHarness } from './run-harness.js'

const config = JSON.parse(readFileSync(process.argv[2], 'utf8')), output = path.resolve(process.argv[3])
mkdirSync(output, { recursive: true })
const manifest = { version: 'b0-lifecycle-v1', startedAt: new Date().toISOString(), repetitions: 3, source: sourceManifest(),
  model: { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort ?? 'provider-default' },
  budgets: { prepareMs: 360000, restoredMs: 120000 }, phases: ['lifecycle-prepare', 'lifecycle-restored'],
  coverage: ['native manual compaction', 'corrected facts after compaction', 'actual profile process restart', 'same main-session binding and context injection count',
    'duplicate native DSH worker request before and after restart', 'stale extraction/segmentation commit rejection', 'versioned history read rejection', 'latest-attempt acceptance'],
  limits: ['three synthetic repetitions; not long-running production reliability', 'manual compaction; not automatic pressure-triggered compaction',
    'clean process shutdown; not kill-9 or in-flight crash recovery', 'late results are deterministically injected; not a model quality estimate'],
  evaluationTools: Object.fromEntries(['lifecycle-run.js', 'lifecycle-probe.js', 'lifecycle-guards.js', 'run-harness.js', 'fixture.js'].map(file => [file, digest(readFileSync(new URL(file, import.meta.url)))])) }
writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
writeFileSync(path.join(output, 'run-config.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx' })
const rows = [], cleanups = [], runtimes = []; let failure = null, harness = null
const capture = async (request, repeat) => {
  appendFileSync(path.join(output, 'inputs.jsonl'), JSON.stringify({ repeat, request }) + '\n')
  let result
  try { result = await harness.infer(request) } catch (error) { result = error.measurement ?? { ok: false, error: { name: error.name, message: error.message } } }
  const row = { repeat, caseId: request.purpose, result }
  rows.push(row); appendFileSync(path.join(output, 'results.jsonl'), JSON.stringify(row) + '\n')
  console.log(JSON.stringify({ repeat: repeat + 1, phase: request.purpose, ok: result.ok, elapsedMs: result.elapsedMs, error: result.error ?? null }))
  return result
}
try {
  for (let repeat = 0; repeat < manifest.repetitions; repeat++) {
    harness = await startHarness({ ...config, probe: 'lifecycle-probe.js' })
    const root = harness.root
    runtimes.push({ repeat, root }); writeFileSync(path.join(output, 'runtimes.json'), JSON.stringify(runtimes, null, 2) + '\n')
    const prepared = await capture({ purpose: 'lifecycle-prepare', input: { seed: `lifecycle-${repeat + 1}` }, budgetMs: manifest.budgets.prepareMs }, repeat)
    cleanups.push({ repeat, phase: 'prepare', ...await harness.close() }); harness = null
    if (!prepared.ok) continue
    harness = await startHarness({ ...config, root: undefined, restoreRoot: root, probe: 'lifecycle-probe.js' })
    const restored = await capture({ purpose: 'lifecycle-restored', budgetMs: manifest.budgets.restoredMs }, repeat)
    if (restored.ok && restored.processId === prepared.processId) throw new Error('Restart must use a different OS process')
    cleanups.push({ repeat, phase: 'restored', ...await harness.close() }); harness = null
  }
} catch (error) { failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  if (harness) cleanups.push({ phase: 'finally', ...await harness.close() })
  const summary = { completedAt: new Date().toISOString(), plannedPhases: 6, completedPhases: rows.length, failed: rows.filter(row => !row.result.ok).length,
    failure, cleanups, runtimes, sourceUnchanged: sourceManifest().sha256 === manifest.source.sha256,
    nativeCompactionPasses: rows.filter(row => row.caseId === 'lifecycle-prepare' && row.result.ok).length,
    restartedContinuationPasses: rows.filter(row => row.caseId === 'lifecycle-restored' && row.result.ok).length,
    deterministicGuardCasesPassed: rows.reduce((count, row) => count + (row.result.guards?.rows.filter(item => item.ok).length ?? 0), 0) }
  summary.ok = summary.completedPhases === summary.plannedPhases && !summary.failed && !failure && summary.sourceUnchanged && cleanups.every(cleanup => !cleanup.forced && cleanup.code === 0)
  writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n'); console.log(JSON.stringify(summary))
  if (!summary.ok) process.exitCode = 1
}
