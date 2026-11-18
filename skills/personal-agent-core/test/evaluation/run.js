/** Reproducible production-retrieval measurements over a synthetic, frozen corpus. */
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
import { setImmediate } from 'node:timers/promises'
import { createFixture, defaultSource, digest, loadJson, sourceManifest } from './fixture.js'
import { familyInterval, mean, quantile, scoreRetrieval } from './score.js'

export const protocol = {
  version: 'b0-retrieval-v1', asOf: '2026-11-18T00:00:00.000Z', splits: ['explore', 'validation'], repetitions: 3,
  limits: [10, 50], bodyStates: ['hot', 'archived'], cachePasses: ['first-pass', 'repeat-pass'],
  bootstrap: { unit: 'source-family', draws: 2000, seed: 18427 },
  evidenceMetric: 'Coverage of gold original-message IDs in the API matches/sources of its top K returned task and memory records. Not a global evidence ranking.',
  queries: 'Use case.searchQuery as authored before measuring; otherwise use the full query. No gold IDs or answer terms are supplied to retrieval.',
  context: 'Synthetic, pre-segmented and pre-extracted snapshots. Extraction quality, native worker execution and end-to-end answer quality are not measured.',
  cache: 'Fresh SQLite fixture per repetition/body state; first pass follows fixture creation. OS filesystem caches are not flushed.',
  gates: { qualityGainPercentagePoints: 5, qualityConfidenceLowerBound: 0, qualityRegressionTolerancePercentagePoints: 1,
    efficiencyReductionPercent: 20, p95LatencyIncreaseLimitPercent: 10, tokenIncreaseLimitPercent: 10,
    criticalRegressionsAllowed: 0, retrievalAloneAllowsApplication: false },
}

/** Validate ownership, split separation, chronology, and exact source quotations without showing held-out answers. */
export function validateDataset(corpus, labels) {
  if (corpus.synthetic !== true || corpus.datasetId !== labels.datasetId) throw new Error('Synthetic corpus/labels identity mismatch')
  const families = new Map(), messages = new Map(), tasks = new Map(), memories = new Map(), ids = new Set()
  const unique = id => { if (!id || ids.has(id)) throw new Error(`Duplicate or missing ID: ${id}`); ids.add(id) }
  for (const family of corpus.families) {
    unique(family.id); families.set(family.id, family)
    if (!['explore', 'validation', 'holdout'].includes(family.split)) throw new Error(`Invalid split: ${family.id}`)
    for (const session of family.sessions) {
      unique(session.id)
      if (!session.title || !['dsh', 'codex'].includes(session.sourceSystem ?? session.worker)) throw new Error(`Session metadata missing: ${session.id}`)
      for (const message of session.messages) {
        unique(message.id)
        if (!message.text || !Number.isFinite(Date.parse(message.createdAt)) || Date.parse(message.createdAt) > Date.parse(protocol.asOf)) throw new Error(`Source text/time invalid: ${message.id}`)
        messages.set(message.id, { ...message, familyId: family.id, sessionId: session.id })
      }
    }
    for (const task of family.sessionTasks) {
      unique(task.id); tasks.set(task.id, family.id)
      const sessionId = task.sessionId ?? task.sessionIds?.[0]
      if (!family.sessions.some(session => session.id === sessionId)) throw new Error(`Task session missing: ${task.id}`)
      for (const id of task.sourceMessageIds) if (messages.get(id)?.familyId !== family.id || messages.get(id)?.sessionId !== sessionId) throw new Error(`Task source ownership mismatch: ${task.id}`)
    }
    for (const memory of family.memories) {
      unique(memory.id); memories.set(memory.id, family.id)
      if (!['candidate', 'confirmed', 'user-stated', 'superseded', 'retracted'].includes(memory.status)) throw new Error(`Unknown memory state: ${memory.id}`)
      for (const evidence of memory.evidence) {
        const message = messages.get(evidence.messageId)
        if (message?.familyId !== family.id || !message.text.includes(evidence.quote) || !evidence.quote.trim()) throw new Error(`Invalid exact quote: ${memory.id}`)
      }
    }
  }
  for (const item of labels.cases) {
    unique(item.id)
    if (families.get(item.familyId)?.split !== item.split) throw new Error(`Case split mismatch: ${item.id}`)
    if (!item.query || !item.searchQuery) throw new Error(`Unfrozen request/query: ${item.id}`)
    for (const id of item.expected.sessionTaskIds) if (tasks.get(id) !== item.familyId) throw new Error(`Gold task mismatch: ${item.id}`)
    for (const id of item.expected.memoryIds) if (memories.get(id) !== item.familyId) throw new Error(`Gold memory mismatch: ${item.id}`)
    for (const id of item.expected.evidenceMessageIds) if (messages.get(id)?.familyId !== item.familyId) throw new Error(`Gold evidence mismatch: ${item.id}`)
  }
  const splitCounts = Object.fromEntries(['explore', 'validation', 'holdout'].map(split => [split, { families: corpus.families.filter(family => family.split === split).length, cases: labels.cases.filter(item => item.split === split).length }]))
  if (corpus.families.length !== 60 || labels.cases.length !== 300 || Object.values(splitCounts).some(row => row.cases !== row.families * 5)) throw new Error('Expected 60 source families and 300 cases, five per family')
  return { families: families.size, messages: messages.size, sessionTasks: tasks.size, memories: memories.size, cases: labels.cases.length, splitCounts }
}

export function requestFor(item, fixture) {
  const filters = { ...item.filters }
  if (filters.projectId) filters.projectId = fixture.maps.projects.get(filters.projectId) ?? filters.projectId
  return { query: item.searchQuery, ...filters, asOf: item.asOf ?? protocol.asOf }
}

export function observedIds(lane, value, fixture) {
  const reverseMemories = new Map([...fixture.maps.memories].map(([alias, native]) => [native, alias]))
  const records = lane === 'history' ? value.results : lane === 'memory' ? value.sessionTasks : value.candidates
  const taskIds = records.map(record => record.sessionTaskId ?? record.id ?? record.candidateId)
  const nativeEvidence = [
    ...records.flatMap(record => (record.matches ?? record.messages ?? []).map(hit => hit.evidenceId ?? hit.evidence_id)),
    ...(value.supplementary ?? value.experiences ?? []).map(hit => hit.evidenceId),
    ...(value.memories ?? []).flatMap(record => record.sources.map(source => source.evidenceId ?? source.evidence_id)),
  ].filter(Boolean)
  return { taskIds, evidenceIds: [...new Set(nativeEvidence.map(id => fixture.maps.evidence.get(id)).filter(Boolean))],
    memoryIds: (value.memories ?? []).map(record => reverseMemories.get(record.id)).filter(Boolean) }
}

export function summarize(rows) {
  const grouped = new Map()
  for (const row of rows) {
    for (const category of ['all', row.category]) {
      const key = [row.split, category, row.lane, row.limit, row.bodyState, row.cachePass].join('/')
      if (!grouped.has(key)) grouped.set(key, [])
      grouped.get(key).push(row)
    }
  }
  return Object.fromEntries([...grouped].map(([key, records]) => [key, {
    observations: records.length, independentCases: new Set(records.map(row => row.caseId)).size,
    taskRecall: familyInterval(records, 'taskRecall'), evidenceRecall: familyInterval(records, 'evidenceRecall'),
    memoryRecall: familyInterval(records, 'memoryRecall'), taskMrr: familyInterval(records, 'taskMrr'),
    latencyMs: { p50: quantile(records.map(row => row.elapsedMs), 0.5), p95: quantile(records.map(row => row.elapsedMs), 0.95), mean: mean(records.map(row => row.elapsedMs)) },
    errors: records.filter(row => row.error).length, truncated: records.filter(row => row.coverage?.truncated).length,
  }]))
}

async function main() {
  const source = process.argv[2] ? path.resolve(process.argv[2]) : defaultSource
  const output = process.argv[3] ? path.resolve(process.argv[3]) : path.join(import.meta.dirname, 'results', `b0-${Date.now()}`)
  const corpus = loadJson('corpus.json'), labels = loadJson('cases.json')
  const dataset = validateDataset(corpus, labels)
  const cases = labels.cases.filter(item => protocol.splits.includes(item.split))
  const familyById = new Map(corpus.families.map(family => [family.id, family]))
  const visibleCorpus = { ...corpus, families: corpus.families.filter(family => protocol.splits.includes(family.split)) }
  const sourceIdentity = sourceManifest(source)
  const { discoverExecutionTargets } = await import(pathToFileURL(path.join(source, 'lib/execution-discovery.js')))
  mkdirSync(output, { recursive: true })
  const manifest = { startedAt: new Date().toISOString(), protocol, dataset, source: sourceIdentity, sourcePath: source,
    corpusSha256: digest(readFileSync(path.join(import.meta.dirname, 'corpus.json'))), casesSha256: digest(readFileSync(path.join(import.meta.dirname, 'cases.json'))),
    runnerSha256: digest(readFileSync(import.meta.filename)), scorerSha256: digest(readFileSync(path.join(import.meta.dirname, 'score.js'))),
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, sqlite: process.versions.sqlite },
    holdout: { executed: false, cases: dataset.splitCounts.holdout.cases }, status: 'frozen-before-execution' }
  writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  const rows = [], builds = []
  const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable()
  for (const bodyState of protocol.bodyStates) for (let repeat = 0; repeat < protocol.repetitions; repeat++) {
    const start = performance.now()
    const fixture = await createFixture(visibleCorpus, { source, asOf: protocol.asOf, coldBodies: bodyState === 'archived' })
    builds.push({ bodyState, repeat, buildMs: performance.now() - start, counts: fixture.counts, bytes: fixture.bytes, indexBytes: fixture.indexBytes })
    try {
      for (const cachePass of protocol.cachePasses) for (const [position, item] of cases.entries()) {
        const request = requestFor(item, fixture)
        for (const limit of protocol.limits) for (const lane of ['history', 'memory', 'discovery']) {
          const measured = performance.now()
          let value, error = null
          try {
            value = lane === 'discovery' ? discoverExecutionTargets(fixture.service, { ...request, objective: item.query, limit })
              : await fixture.service.operate({ action: lane === 'history' ? 'search_history' : 'memory_search', ...request, limit })
          } catch (failure) { error = { name: failure.name, message: failure.message, code: failure.code ?? null } }
          const elapsedMs = performance.now() - measured
          const observed = value ? observedIds(lane, value, fixture) : { taskIds: [], evidenceIds: [], memoryIds: [] }
          const scores = scoreRetrieval(item, observed)
          if (lane !== 'memory') scores.memoryRecall = null
          const row = { caseId: item.id, familyId: item.familyId, split: item.split, category: familyById.get(item.familyId).category, kind: item.kind,
            repeat, bodyState, cachePass, lane, limit, elapsedMs, ...scores, observed, error, coverage: value?.coverage ?? null }
          rows.push(row)
          appendFileSync(path.join(output, 'retrieval.jsonl'), JSON.stringify(row) + '\n')
        }
        if (position % 10 === 0) await setImmediate()
      }
    } finally { await fixture.close() }
    console.log(JSON.stringify({ bodyState, repeat: repeat + 1, completed: rows.length }))
  }
  lag.disable()
  const summary = { completedAt: new Date().toISOString(), builds, metrics: summarize(rows),
    resourceUsage: process.resourceUsage(), eventLoopDelayMs: { p95: lag.percentile(95) / 1e6, max: lag.max / 1e6 },
    sourceUnchanged: sourceManifest(source).sha256 === sourceIdentity.sha256,
    notMeasured: ['model semantic quality', 'main conversation end-to-end', 'DSH worker execution', 'Codex worker execution', 'extraction quality', 'application startup', 'index incremental update cost'] }
  writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  console.log(JSON.stringify({ output, sourceUnchanged: summary.sourceUnchanged, errors: rows.filter(row => row.error).length }))
  if (rows.some(row => row.error) || !summary.sourceUnchanged) process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) await main()
