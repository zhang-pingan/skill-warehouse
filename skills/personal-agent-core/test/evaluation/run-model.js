/** Real-model measurement of the production task-association stage, without dispatching work. */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { createFixture, defaultSource, digest, loadJson, sourceManifest } from './fixture.js'
import { protocol, requestFor, validateDataset } from './run.js'
import { startHarness } from './run-harness.js'
import { familyInterval, mean, quantile } from './score.js'

const configFile = process.argv[2]
if (!configFile) throw new Error('Usage: node test/evaluation/run-model.js /absolute/private-run-config.json /absolute/result-directory')
const output = path.resolve(process.argv[3])
const runConfig = JSON.parse(readFileSync(configFile, 'utf8'))
const candidateLimit = runConfig.candidateLimit ?? 50
if (![10, 50].includes(candidateLimit)) throw new Error('candidateLimit must be 10 or 50, matching the retrieval protocol')
const source = runConfig.source ? path.resolve(runConfig.source) : defaultSource
const corpus = loadJson('corpus.json'), labels = loadJson('cases.json')
validateDataset(corpus, labels)
const visible = { ...corpus, families: corpus.families.filter(family => family.split !== 'holdout') }
const categories = new Set()
const families = visible.families.filter(family => family.split === 'explore' && !categories.has(family.category) && categories.add(family.category))
const cases = families.flatMap(family => labels.cases.filter(item => item.familyId === family.id && item.kind === 'route'))
const fixture = await createFixture(visible, { source, analysisInputChars: runConfig.analysisInputChars })
const metadata = { version: 'b0-task-association-probe-v3', startedAt: new Date().toISOString(),
  source: sourceManifest(source), datasetId: corpus.datasetId, corpusSha256: digest(readFileSync(path.join(import.meta.dirname, 'corpus.json'))),
  casesSha256: digest(readFileSync(path.join(import.meta.dirname, 'cases.json'))),
  selection: { provider: runConfig.provider, model: runConfig.model, reasoningEffort: runConfig.reasoningEffort ?? 'provider-default' },
  sampling: 'First explore family in each corpus category; only route case; fixed before inference. No holdout.',
  caseIds: cases.map(item => item.id), repetitions: 3, candidateLimit,
  evaluationTools: Object.fromEntries(['run-model.js', 'run-harness.js', 'harness-probe.js', 'fixture.js', 'run.js', 'score.js']
    .map(file => [file, digest(readFileSync(path.join(import.meta.dirname, file)))])),
  scope: 'Production semanticCandidates and managedAnalysis. Not final route, main conversation, native preflight or worker execution.',
  threshold: fixture.service.config.routeResumeThreshold, ambiguityGap: fixture.service.config.routeAmbiguityGap,
  budgetMs: fixture.service.config.analysisBudgetMs, maxInputChars: fixture.service.config.analysisInputChars, maxOutputChars: fixture.service.config.analysisOutputChars,
  status: 'frozen-before-execution' }
mkdirSync(output, { recursive: true })
writeFileSync(path.join(output, 'model-manifest.json'), JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' })
let harness
const rows = []
let harnessError = null
try {
  harness = await startHarness(runConfig)
  fixture.service.context = { sessionController: {}, agentDefaultModel: { currentSelection: () => harness.selection } }
  let measurements = []
  fixture.service.analysisRuns.run = async options => {
    const request = { purpose: options.purpose, instructions: options.instructions, input: options.input, budgetMs: options.budgetMs,
      maxInputChars: options.maxInputChars, maxOutputChars: options.maxOutputChars }
    const inputSha256 = digest(JSON.stringify(request))
    appendFileSync(path.join(output, 'model-inputs.jsonl'), JSON.stringify({ inputSha256, request }) + '\n')
    try {
      const result = await harness.infer(request)
      measurements.push({ inputSha256, ...result })
      return result
    } catch (error) {
      measurements.push({ inputSha256, ...(error.measurement ?? {}), error: { name: error.name, message: error.message } })
      throw error
    }
  }
  for (let repeat = 0; repeat < metadata.repetitions; repeat++) for (const item of cases) {
    measurements = []
    const started = performance.now()
    let result = null, error = null
    try { result = await fixture.service.semanticCandidates({ ...requestFor(item, fixture), objective: item.query, limit: candidateLimit }) }
    catch (failure) { error = { name: failure.name, message: failure.message, code: failure.code ?? null } }
    const ranked = result?.candidates.filter(candidate => candidate.objectiveCompatible && candidate.score >= metadata.threshold) ?? []
    const expectedIds = item.expected.sessionTaskIds
    const topCompatibleCorrect = expectedIds.length ? Number(!error && expectedIds.includes(ranked[0]?.sessionTaskId)) : null
    const row = { caseId: item.id, familyId: item.familyId, repeat, elapsedMs: performance.now() - started,
      topCompatibleCorrect, expectedTargetAvailable: expectedIds.length ? Number(result?.candidates.some(candidate => expectedIds.includes(candidate.sessionTaskId)) ?? false) : null,
      qualifiedCandidateIds: ranked.map(candidate => candidate.candidateId), coverage: result?.coverage ?? null,
      modelCalls: measurements.reduce((sum, measurement) => sum + (measurement.attempts?.length ?? 0), 0), measurements, error }
    rows.push(row)
    appendFileSync(path.join(output, 'model-results.jsonl'), JSON.stringify(row) + '\n')
    console.log(JSON.stringify({ caseId: item.id, repeat: repeat + 1, durationMs: row.elapsedMs, ok: !error, modelCalls: row.modelCalls }))
  }
} catch (error) { harnessError = { name: error.name, message: error.message } }
finally {
  if (harness) await harness.close()
  await fixture.close()
  const nativeUsages = rows.flatMap(row => row.measurements).map(measurement => measurement.usage).filter(Boolean)
  const summary = { completedAt: new Date().toISOString(), planned: cases.length * metadata.repetitions, completed: rows.length,
    failed: rows.filter(row => row.error).length, harnessError,
    topCompatibleCorrect: familyInterval(rows, 'topCompatibleCorrect'), expectedTargetAvailable: familyInterval(rows, 'expectedTargetAvailable'),
    latencyMs: { p50: quantile(rows.map(row => row.elapsedMs), 0.5), p95: quantile(rows.map(row => row.elapsedMs), 0.95), mean: mean(rows.map(row => row.elapsedMs)) },
    modelCalls: rows.reduce((sum, row) => sum + row.modelCalls, 0),
    nativeUsage: Object.fromEntries(['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'reasoningTokens'].filter(key => nativeUsages.length && nativeUsages.every(value => Number.isFinite(value[key]))).map(key => [key, nativeUsages.reduce((sum, value) => sum + value[key], 0)])),
    usageComplete: rows.length > 0 && rows.flatMap(row => row.measurements).length > 0 && rows.flatMap(row => row.measurements).every(measurement => measurement.usageComplete),
    sourceUnchanged: sourceManifest(source).sha256 === metadata.source.sha256, sessionLogRoot: harness?.root ?? null,
    notMeasured: ['grounded-answer quality', 'context constraint adherence', 'final route decisions', 'main conversation end-to-end', 'native DSH worker', 'native Codex worker'] }
  writeFileSync(path.join(output, 'model-summary.json'), JSON.stringify(summary, null, 2) + '\n')
  console.log(JSON.stringify(summary))
  if (harnessError || summary.failed || !summary.sourceUnchanged) process.exitCode = 1
}
