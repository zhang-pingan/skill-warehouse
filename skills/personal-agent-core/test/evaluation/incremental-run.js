/** Freeze and execute bounded incremental writes; seed cost never enters update timings. */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { incrementalProtocol, incrementalPayloads } from './incremental-protocol.js'
import { defaultSource, digest, sourceManifest } from './fixture.js'

const source = path.resolve(process.argv[2] ?? defaultSource)
const output = path.resolve(process.argv[3])
const smoke = process.argv.includes('--smoke')
const scales = smoke ? [400] : incrementalProtocol.scales
const repetitions = smoke ? 1 : incrementalProtocol.repetitions
const production = sourceManifest(source)
if (production.sha256 !== incrementalProtocol.expectedSourceSha256) throw new Error('Production source differs from preregistered incremental baseline')
mkdirSync(output, { recursive: true })
const files = ['incremental-run.js', 'incremental-worker.js', 'incremental-protocol.js', 'scale-worker.js', 'scale-corpus.js', 'fixture.js']
const tools = Object.fromEntries(files.map(file => [file, digest(readFileSync(path.join(import.meta.dirname, file)))]))
const manifest = { frozenAt: new Date().toISOString(), status: 'frozen-before-execution', source: production, tools,
  protocol: incrementalProtocol, scales, repetitions, smoke, command: [process.execPath, import.meta.filename, ...process.argv.slice(2)],
  payloads: Object.fromEntries(incrementalProtocol.lanes.map(lane => [lane, incrementalPayloads(lane)])),
  environment: { node: process.version, sqlite: process.versions.sqlite, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model } }
writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
mkdirSync(path.join(output, 'protocol-source'))
for (const file of files) copyFileSync(path.join(import.meta.dirname, file), path.join(output, 'protocol-source', file))
const root = mkdtempSync(path.join(os.tmpdir(), 'personal-agent-incremental-'))
const runs = [], samples = [], builds = []
let failure, cleanup

async function runChild(mode, count, repetition, directory) {
  const label = `${count}-${mode}-${repetition}`
  const args = mode === 'build' ? ['--expose-gc', path.join(import.meta.dirname, 'scale-worker.js'), 'build', directory, source, String(count)]
    : ['--expose-gc', path.join(import.meta.dirname, 'incremental-worker.js'), source, directory, mode, String(count)]
  const started = performance.now()
  const rows = []
  let pending = '', deadlineKind = null, parseError, spawnError
  const child = spawn(process.execPath, args, { cwd: source, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, TMPDIR: root, TZ: 'UTC', LANG: 'C.UTF-8' } })
  const wallTimer = setTimeout(() => { deadlineKind = 'child'; child.kill('SIGKILL') }, incrementalProtocol.limits.childMs)
  let batchTimer
  const consume = line => {
    if (!line.trim()) return
    try {
      const row = JSON.parse(line); rows.push(row)
      if (row.event === 'batch-start') batchTimer = setTimeout(() => { deadlineKind = 'batch'; child.kill('SIGKILL') }, incrementalProtocol.limits.batchMs)
      if (row.event === 'batch-finished') clearTimeout(batchTimer)
    } catch (error) { parseError = { message: error.message } }
  }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    appendFileSync(path.join(output, `${label}.jsonl`), chunk)
    pending += chunk
    const lines = pending.split('\n'); pending = lines.pop()
    for (const line of lines) consume(line)
  })
  child.stderr.on('data', chunk => appendFileSync(path.join(output, `${label}.stderr.txt`), chunk))
  child.once('error', error => { spawnError = { message: error.message, code: error.code } })
  const exit = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  clearTimeout(wallTimer); clearTimeout(batchTimer)
  if (pending.trim()) consume(pending)
  const verified = rows.find(row => row.event === 'verified')
  const result = { mode, count, repetition, wallMs: performance.now() - started, exit, deadlineKind,
    parseError: parseError ?? null, spawnError: spawnError ?? null,
    status: deadlineKind === 'batch' ? 'right-censored' : exit.code === 0 && !parseError && !spawnError && (mode === 'build' || verified) ? 'completed' : 'failed',
    lowerBoundMs: deadlineKind === 'batch' ? incrementalProtocol.limits.batchMs : null }
  runs.push(result)
  appendFileSync(path.join(output, 'children.jsonl'), JSON.stringify(result) + '\n')
  if (mode === 'build') {
    const build = rows.find(row => row.event === 'build')
    if (result.status !== 'completed' || !build) throw new Error(`Seed build failed at ${count}`)
    builds.push(build)
  } else samples.push({ ...result, measurement: verified ?? null, failure: rows.find(row => row.event === 'failure') ?? null })
  process.stdout.write(JSON.stringify({ label, status: result.status, batchMs: verified?.batchMs ?? null, checkpointMs: verified?.checkpointMs ?? null }) + '\n')
}

try {
  for (const count of scales) {
    const seed = path.join(root, `seed-${count}`)
    mkdirSync(seed)
    await runChild('build', count, 0, seed)
    for (let repetition = 0; repetition < repetitions; repetition++) for (const lane of incrementalProtocol.lanes) {
      const directory = path.join(root, `${count}-${lane}-${repetition}`)
      mkdirSync(path.join(directory, 'data'), { recursive: true })
      copyFileSync(path.join(seed, 'data', 'ledger.sqlite'), path.join(directory, 'data', 'ledger.sqlite'))
      await runChild(lane, count, repetition, directory)
      rmSync(directory, { recursive: true })
    }
    rmSync(seed, { recursive: true })
  }
} catch (error) { failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }
finally { rmSync(root, { recursive: true, force: true }); cleanup = { temporaryRoot: root, removed: !existsSync(root) } }
const stats = values => {
  if (!values.length) return null
  const sorted = values.toSorted((a, b) => a - b)
  const q = fraction => { const i = (sorted.length - 1) * fraction, lo = Math.floor(i); return sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo) }
  return { observations: sorted.length, p50: q(0.5), p95: q(0.95), min: sorted[0], max: sorted.at(-1) }
}
const metrics = Object.fromEntries(scales.map(count => [count, Object.fromEntries(incrementalProtocol.lanes.map(lane => {
  const rows = samples.filter(row => row.count === count && row.mode === lane)
  const measured = rows.filter(row => row.measurement).map(row => row.measurement)
  const censored = rows.filter(row => row.status === 'right-censored').length
  return [lane, { attempted: rows.length, completed: measured.length, censored, failed: rows.filter(row => row.status === 'failed').length,
    batchMs: censored ? null : stats(measured.map(row => row.batchMs)), checkpointMs: stats(measured.map(row => row.checkpointMs)),
    peakRssMiB: stats(measured.map(row => row.resourceUsage.maxRSS / 1024)),
    databaseDeltaBytes: stats(measured.map(row => row.after.storage.databaseBytes - row.before.storage.databaseBytes)),
    evidenceFtsDeltaBytes: stats(measured.map(row => row.after.storage.indexBytes.evidence_fts - row.before.storage.indexBytes.evidence_fts)),
    memoryFtsDeltaBytes: stats(measured.map(row => row.after.storage.indexBytes.memory_fts - row.before.storage.indexBytes.memory_fts)) }]
}))]))
const summary = { completedAt: new Date().toISOString(), failure: failure ?? null, cleanup, builds, metrics,
  planned: scales.length * repetitions * incrementalProtocol.lanes.length, observed: samples.length,
  completed: samples.filter(row => row.status === 'completed').length, censored: samples.filter(row => row.status === 'right-censored').length,
  failures: samples.filter(row => row.status === 'failed'), sourceUnchanged: sourceManifest(source).sha256 === production.sha256,
  toolsUnchanged: Object.entries(tools).every(([file, sha]) => digest(readFileSync(path.join(import.meta.dirname, file))) === sha),
  allOperationsVerified: samples.length === scales.length * repetitions * incrementalProtocol.lanes.length && samples.every(row => row.status === 'completed') }
writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' })
if (failure || !summary.sourceUnchanged || !summary.toolsUnchanged || !summary.allOperationsVerified) process.exitCode = 1
process.stdout.write(JSON.stringify({ output, completed: summary.completed, allOperationsVerified: summary.allOperationsVerified, sourceUnchanged: summary.sourceUnchanged }) + '\n')
