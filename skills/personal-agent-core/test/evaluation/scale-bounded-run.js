/** Preregistered single-query censoring after the full traversal exposed severe scale latency. */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, rmSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { performance } from 'node:perf_hooks'
import { defaultSource, digest, sourceManifest } from './fixture.js'
import { scaleProtocol, scaleQueries } from './scale-corpus.js'
import { profileCheckoutManifest, runScaleProfile } from './scale-profile.js'

const source = path.resolve(process.argv[2] ?? defaultSource)
const checkout = path.resolve(process.argv[3])
const output = path.resolve(process.argv[4])
const protocol = { version: 'b0-service-scale-bounded-v1', priorProtocol: '../full/manifest.json',
  reason: 'Full traversal observed a 48604 ms first exact query at 10000 messages. Preserve that run separately; measure independent requests with an interactive diagnostic deadline.',
  scales: scaleProtocol.scales, repetitions: 3, lanes: ['history', 'memory'], query: 'Exact first-task token; selected before bounded execution, same first case as full traversal.',
  queryDeadlineMs: 10000, startupDeadlineMs: 120000, buildDeadlineMs: 120000,
  censoring: 'Kill only owned child at 10000 ms from receipt of query-start. No response is right-censored at at least 10000 ms; failures are included, not assigned fabricated latency/p95. Parent timer IPC delay is recorded. Timeout RSS and post-GC values are unavailable.',
  repetitionsMeaning: 'Each lane and repetition starts a new process with a fresh copy of identical fixture database. OS caches are not flushed. No warm-repeat query is attempted in this bounded lane.',
  profiles: 'Three isolated supported source Web profiles per scale, actual production plugin health after appReady; no GUI rendering, no background jobs or inference.',
  distribution: scaleProtocol, performanceThreshold: null,
}
mkdirSync(output, { recursive: true })
const production = sourceManifest(source)
const files = ['scale-bounded-run.js', 'scale-worker.js', 'scale-corpus.js', 'scale-profile.js', 'scale-profile-probe.js', 'fixture.js']
const manifest = { frozenAt: new Date().toISOString(), protocol, source: production,
  tools: Object.fromEntries(files.map(file => [file, digest(readFileSync(path.join(import.meta.dirname, file)))])),
  profile: profileCheckoutManifest(checkout), command: [process.execPath, import.meta.filename, ...process.argv.slice(2)],
  environment: { node: process.version, sqlite: process.versions.sqlite, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model },
  queries: Object.fromEntries(protocol.scales.map(count => [count, scaleQueries(count)[0]])), status: 'frozen-before-execution' }
writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
mkdirSync(path.join(output, 'protocol-source'))
for (const file of files) copyFileSync(path.join(import.meta.dirname, file), path.join(output, 'protocol-source', file))
const root = mkdtempSync(path.join(os.tmpdir(), 'personal-agent-scale-bounded-'))
const builds = [], samples = [], profiles = []
let failure, cleanup

async function childRun(mode, count, repetition, directory) {
  const label = `${count}-${mode}-${repetition}`, rows = []
  const started = performance.now()
  let buffer = '', readyMs, requestStarted, deadlineKind = null, parseError = null, spawnError = null
  const child = spawn(process.execPath, ['--expose-gc', path.join(import.meta.dirname, 'scale-worker.js'), mode, directory, source, String(count)],
    { cwd: source, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, TMPDIR: root, TZ: 'UTC', LANG: 'C.UTF-8' } })
  let timer = setTimeout(() => { deadlineKind = mode === 'build' ? 'build' : 'startup'; child.kill('SIGKILL') }, mode === 'build' ? protocol.buildDeadlineMs : protocol.startupDeadlineMs)
  const consume = line => {
    if (!line.trim()) return
    try {
      const row = JSON.parse(line); rows.push(row)
      if (row.event === 'ready') readyMs = performance.now() - started
      if (row.event === 'query-start') {
        clearTimeout(timer)
        requestStarted = performance.now()
        timer = setTimeout(() => { deadlineKind = 'query'; child.kill('SIGKILL') }, protocol.queryDeadlineMs)
      }
      if (row.event === 'query') clearTimeout(timer)
    } catch (error) { parseError = { name: error.name, message: error.message } }
  }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    appendFileSync(path.join(output, `${label}.jsonl`), chunk)
    buffer += chunk
    const lines = buffer.split('\n'); buffer = lines.pop()
    for (const line of lines) consume(line)
  })
  child.stderr.on('data', chunk => appendFileSync(path.join(output, `${label}.stderr.txt`), chunk))
  child.once('error', error => { spawnError = { name: error.name, message: error.message } })
  const exit = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  clearTimeout(timer)
  if (buffer) consume(buffer)
  const query = rows.find(row => row.event === 'query')
  const result = { mode, count, repetition, readyMs, wallMs: performance.now() - started,
    status: deadlineKind === 'query' ? 'right-censored' : exit.code === 0 && !parseError && !spawnError && !query?.error ? 'completed' : 'failed',
    lowerBoundMs: deadlineKind === 'query' ? protocol.queryDeadlineMs : null,
    requestStartToExitMs: requestStarted ? performance.now() - requestStarted : null,
    deadlineKind, exit, parseError, spawnError, query: query ?? null,
    ready: rows.find(row => row.event === 'ready') ?? null, resources: rows.find(row => row.event === 'resources') ?? null }
  appendFileSync(path.join(output, 'children.jsonl'), JSON.stringify(result) + '\n')
  if (mode === 'build') {
    const build = rows.find(row => row.event === 'build')
    if (result.status !== 'completed' || !build) throw new Error(`Fixture build ${count} failed; see raw records`)
    builds.push(build)
  } else samples.push(result)
  process.stdout.write(JSON.stringify({ label, status: result.status, elapsedMs: query?.elapsedMs ?? null, lowerBoundMs: result.lowerBoundMs }) + '\n')
}

try {
  for (const count of protocol.scales) {
    const seed = path.join(root, `seed-${count}`)
    mkdirSync(seed)
    await childRun('build', count, 0, seed)
    for (let repetition = 0; repetition < protocol.repetitions; repetition++) for (const lane of protocol.lanes) {
      const directory = path.join(root, `${count}-${lane}-${repetition}`)
      mkdirSync(path.join(directory, 'data'), { recursive: true })
      copyFileSync(path.join(seed, 'data', 'ledger.sqlite'), path.join(directory, 'data', 'ledger.sqlite'))
      await childRun(lane, count, repetition, directory)
      rmSync(directory, { recursive: true })
    }
    for (let repetition = 0; repetition < protocol.repetitions; repetition++) {
      const directory = path.join(root, `${count}-profile-${repetition}`)
      profiles.push(await runScaleProfile({ checkout, source, directory, seedDatabase: path.join(seed, 'data', 'ledger.sqlite'), count, repetition, output }))
      rmSync(directory, { recursive: true })
      process.stdout.write(JSON.stringify({ label: `${count}-profile-${repetition}`, readyMs: profiles.at(-1).ready.spawnToReadyMs }) + '\n')
    }
    rmSync(seed, { recursive: true })
  }
} catch (error) { failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }
finally { rmSync(root, { recursive: true, force: true }); cleanup = { removed: !existsSync(root), temporaryRoot: root } }
const stats = values => {
  if (!values.length) return null
  const sorted = values.toSorted((a, b) => a - b)
  const q = fraction => { const i = (sorted.length - 1) * fraction, low = Math.floor(i); return sorted[low] + (sorted[Math.ceil(i)] - sorted[low]) * (i - low) }
  return { observations: values.length, p50: q(0.5), p95: q(0.95), min: sorted[0], max: sorted.at(-1) }
}
const metrics = Object.fromEntries(protocol.scales.map(count => {
  const observations = samples.filter(row => row.count === count), hosts = profiles.filter(row => row.count === count)
  return [count, { serviceReadyMs: stats(observations.map(row => row.readyMs).filter(Number.isFinite)),
    serviceInitializeMs: stats(observations.map(row => row.ready?.initializeMs).filter(Number.isFinite)),
    query: Object.fromEntries(protocol.lanes.map(lane => {
      const rows = observations.filter(row => row.mode === lane), censored = rows.filter(row => row.status === 'right-censored').length
      return [lane, { planned: protocol.repetitions, completed: rows.filter(row => row.status === 'completed').length,
        censored, failed: rows.filter(row => row.status === 'failed').length,
        latencyMs: censored ? null : stats(rows.map(row => row.query?.elapsedMs).filter(Number.isFinite)),
        censoredLowerBoundMs: censored ? protocol.queryDeadlineMs : null }]
    })),
    profile: { completed: hosts.length, spawnToReadyMs: stats(hosts.map(row => row.ready.spawnToReadyMs)),
      peakRssMiB: stats(hosts.map(row => row.ready.resourceUsage.maxRSS / 1024)), toolHealthMs: stats(hosts.map(row => row.ready.toolHealthMs)) } }]
}))
const summary = { completedAt: new Date().toISOString(), failure: failure ?? null, cleanup, builds, metrics,
  samples, profileCount: profiles.length, queryAttempts: samples.length,
  rightCensoredQueries: samples.filter(row => row.status === 'right-censored').length,
  failedQueries: samples.filter(row => row.status === 'failed').length,
  sourceUnchanged: sourceManifest(source).sha256 === production.sha256,
  measurementComplete: !failure && samples.length === 18 && profiles.length === 9,
  interpretation: 'Complete measurement includes right-censored queries and does not mean acceptable performance. p50/p95 are omitted for any censored lane. No production optimization applied. See full/ for successful first/repeat traversals at 1000 messages and the original slow 10000-message observation.' }
writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' })
if (!summary.sourceUnchanged || !summary.measurementComplete || summary.failedQueries) process.exitCode = 1
process.stdout.write(JSON.stringify({ output, measurementComplete: summary.measurementComplete, rightCensoredQueries: summary.rightCensoredQueries, sourceUnchanged: summary.sourceUnchanged }) + '\n')
