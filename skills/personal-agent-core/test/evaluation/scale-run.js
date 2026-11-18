/** Serialize fresh-process service-scale measurements and preserve frozen inputs and failures. */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, rmSync, existsSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import os from 'node:os'
import path from 'node:path'
import { scaleProtocol, scaleQueries } from './scale-corpus.js'
import { defaultSource, digest, sourceManifest } from './fixture.js'
import { profileCheckoutManifest, runScaleProfile } from './scale-profile.js'

const source = path.resolve(process.argv[2] ?? defaultSource)
const output = path.resolve(process.argv[3] ?? path.join(import.meta.dirname, 'results', `b0-service-scale-${Date.now()}`))
const smoke = process.argv.includes('--smoke')
const profileOption = process.argv.indexOf('--profile-checkout')
const checkout = profileOption >= 0 ? path.resolve(process.argv[profileOption + 1]) : null
const scales = smoke ? [100] : scaleProtocol.scales
const repetitions = smoke ? 1 : scaleProtocol.repetitions
const quantile = (values, fraction) => {
  const sorted = values.toSorted((a, b) => a - b)
  const location = (sorted.length - 1) * fraction, lower = Math.floor(location)
  return sorted[lower] + (sorted[Math.ceil(location)] - sorted[lower]) * (location - lower)
}
const stats = values => ({ observations: values.length, p50: quantile(values, 0.5), p95: quantile(values, 0.95), min: Math.min(...values), max: Math.max(...values) })
mkdirSync(output, { recursive: true })
const production = sourceManifest(source)
const toolFiles = ['scale-run.js', 'scale-worker.js', 'scale-corpus.js', 'scale-profile.js', 'scale-profile-probe.js', 'fixture.js']
const tools = Object.fromEntries(toolFiles.map(file => [file, digest(readFileSync(path.join(import.meta.dirname, file)))]))
const manifest = { frozenAt: new Date().toISOString(), protocol: scaleProtocol, smoke, scales, repetitions,
  source: production, tools, sourcePath: source, profile: checkout ? profileCheckoutManifest(checkout) : null,
  command: [process.execPath, import.meta.filename, ...process.argv.slice(2)],
  environment: { node: process.version, sqlite: process.versions.sqlite, platform: process.platform, arch: process.arch,
    cpu: os.cpus()[0]?.model, cpus: os.cpus().length, totalMemoryBytes: os.totalmem(), release: os.release() },
  queries: Object.fromEntries(scales.map(count => [count, scaleQueries(count)])),
  status: 'frozen-before-execution', data: 'Deterministic generated original messages, published task metadata and memories. Synthetic generator hash frozen here before build; exact logical body hashes recorded by build children.' }
writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
const root = mkdtempSync(path.join(os.tmpdir(), 'personal-agent-scale-'))
const childRuns = [], builds = [], samples = [], allQueries = [], profiles = []
let failure = null, cleanup

/** Capture each child until exit, including timeout diagnostics; the owned tree is removed afterward. */
async function runChild(mode, directory, count, repetition) {
  const label = `${count}-${mode}-${repetition}`
  const stdoutPath = path.join(output, `${label}.jsonl`)
  const stderrPath = path.join(output, `${label}.stderr.txt`)
  const rows = [], started = performance.now()
  const args = ['--expose-gc', path.join(import.meta.dirname, 'scale-worker.js'), mode, directory, source, String(count)]
  let pending = '', spawnToReadyMs = null, timedOut = false, spawnError = null, outputError = null
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: source,
    env: { PATH: process.env.PATH, TMPDIR: root, TZ: 'UTC', LANG: 'C.UTF-8' } })
  const consume = line => {
    if (!line.trim()) return
    try {
      const row = JSON.parse(line)
      rows.push(row)
      if (row.event === 'ready') spawnToReadyMs = performance.now() - started
    } catch (error) { outputError = { name: error.name, message: error.message } }
  }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    appendFileSync(stdoutPath, chunk)
    pending += chunk.toString()
    const lines = pending.split('\n'); pending = lines.pop()
    for (const line of lines) consume(line)
  })
  child.stderr.on('data', chunk => appendFileSync(stderrPath, chunk))
  child.on('error', error => { spawnError = { message: error.message, code: error.code } })
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, scaleProtocol.childTimeoutMs)
  const exit = await new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })))
  clearTimeout(timer)
  if (pending.trim()) consume(pending)
  const record = { mode, count, repetition, args, spawnToReadyMs, childWallMs: performance.now() - started, timedOut, spawnError, outputError, ...exit }
  childRuns.push(record)
  appendFileSync(path.join(output, 'children.jsonl'), JSON.stringify(record) + '\n')
  if (exit.code !== 0 || timedOut || spawnError || outputError || rows.some(row => row.event === 'failure')) throw new Error(`Child ${label} failed; retained stdout/stderr and exit details`)
  if (mode === 'build') {
    const build = rows.find(row => row.event === 'build')
    if (!build) throw new Error(`Child ${label} did not publish a complete fixture`)
    builds.push(build)
  } else {
    const ready = rows.find(row => row.event === 'ready'), resources = rows.find(row => row.event === 'resources')
    if (!ready || !resources || !rows.some(row => row.event === 'disposed')) throw new Error(`Child ${label} did not reach its endpoint and disposal`)
    samples.push({ count, repetition, spawnToReadyMs, ...ready, ...resources })
    allQueries.push(...rows.filter(row => row.event === 'query').map(row => ({ ...row, repetition })))
  }
  process.stdout.write(JSON.stringify({ label, wallMs: record.childWallMs, queries: rows.filter(row => row.event === 'query').length }) + '\n')
}

try {
  for (const count of scales) {
    const seed = path.join(root, `seed-${count}`)
    mkdirSync(seed)
    await runChild('build', seed, count, 0)
    for (let repetition = 0; repetition < repetitions; repetition++) {
      const directory = path.join(root, `sample-${count}-${repetition}`)
      mkdirSync(path.join(directory, 'data'), { recursive: true })
      copyFileSync(path.join(seed, 'data', 'ledger.sqlite'), path.join(directory, 'data', 'ledger.sqlite'))
      await runChild('sample', directory, count, repetition)
      rmSync(directory, { recursive: true })
    }
    if (checkout) for (let repetition = 0; repetition < repetitions; repetition++) {
      const directory = path.join(root, `profile-${count}-${repetition}`)
      profiles.push(await runScaleProfile({ checkout, source, directory, seedDatabase: path.join(seed, 'data', 'ledger.sqlite'), count, repetition, output }))
      rmSync(directory, { recursive: true })
      process.stdout.write(JSON.stringify({ label: `${count}-profile-${repetition}`, readyMs: profiles.at(-1).ready.spawnToReadyMs }) + '\n')
    }
    rmSync(seed, { recursive: true })
  }
} catch (error) {
  failure = { name: error.name, message: error.message, stack: error.stack }
  process.exitCode = 1
} finally {
  rmSync(root, { recursive: true, force: true })
  cleanup = { temporaryRoot: root, removed: !existsSync(root), completedAt: new Date().toISOString() }
}
const metrics = Object.fromEntries(scales.map(count => {
  const rows = samples.filter(row => row.count === count)
  const queries = allQueries.filter(row => row.count === count)
  return [count, { completedSamples: rows.length,
    readiness: rows.length ? Object.fromEntries(['spawnToReadyMs', 'initializeMs', 'healthMs', 'capabilitiesMs'].map(key => [key, stats(rows.map(row => row[key]))])) : {},
    memory: rows.length ? { peakRssMiB: stats(rows.map(row => row.resourceUsage.maxRSS / 1024)),
      postGcRssMiB: stats(rows.map(row => row.postGcMemory.rss / 1048576)), postGcHeapMiB: stats(rows.map(row => row.postGcMemory.heapUsed / 1048576)) } : {},
    queries: Object.fromEntries(scaleProtocol.passes.flatMap(pass => ['history', 'memory'].flatMap(lane => ['all', 'exact', 'broad', 'absent'].map(kind => {
      const selected = queries.filter(row => row.pass === pass && row.lane === lane && (kind === 'all' || row.query.kind === kind))
      return [`${pass}/${lane}/${kind}`, selected.length ? { ...stats(selected.map(row => row.elapsedMs)), errors: selected.filter(row => row.error).length } : null]
    })))),
    queryErrors: queries.filter(row => row.error).length,
  }]
}))
const unchanged = sourceManifest(source).sha256 === production.sha256
const profileMetrics = Object.fromEntries(scales.map(count => {
  const rows = profiles.filter(row => row.count === count)
  return [count, rows.length ? { completedSamples: rows.length, spawnToReadyMs: stats(rows.map(row => row.ready.spawnToReadyMs)),
    toolHealthMs: stats(rows.map(row => row.ready.toolHealthMs)), peakRssMiB: stats(rows.map(row => row.ready.resourceUsage.maxRSS / 1024)) } : null]
}))
const summary = { completedAt: new Date().toISOString(), sourceUnchanged: unchanged, failure, cleanup, builds, samples, metrics, profileMetrics,
  childProcesses: childRuns.length, queryOperations: allQueries.length, queryErrors: allQueries.filter(row => row.error).length,
  measurementComplete: !failure && samples.length === scales.length * repetitions && allQueries.length === scales.length * repetitions * scaleQueries(scales[0]).length * 4 && (!checkout || profiles.length === scales.length * repetitions),
  exclusions: scaleProtocol.excluded, interpretation: 'Queries pool fixed cases and independent processes; cases within a process are correlated. Three-process readiness/RSS quantiles have low precision. No performance pass/fail threshold or optimization claim.' }
writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' })
if (!unchanged || summary.queryErrors || !summary.measurementComplete) process.exitCode = 1
process.stdout.write(JSON.stringify({ output, sourceUnchanged: unchanged, queryErrors: summary.queryErrors, measurementComplete: summary.measurementComplete }) + '\n')
