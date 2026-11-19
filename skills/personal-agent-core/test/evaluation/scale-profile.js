/** Launch the production plugin through an isolated, keyless source Web profile. */
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, writeFile, readFile, realpath } from 'node:fs/promises'
import { appendFileSync, copyFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { performance } from 'node:perf_hooks'
import { digest } from './fixture.js'

/** Identify the source-launch inputs; source CLI startup includes its TypeScript loader. */
export function profileCheckoutManifest(checkout) {
  return { checkout, revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim(),
    trackedChanges: execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: checkout, encoding: 'utf8' }).trim(),
    cliSha256: digest(readFileSync(path.join(checkout, 'apps/cli/src/bin.ts'))),
    packageSha256: digest(readFileSync(path.join(checkout, 'package.json'))),
    endpoint: 'Supported source Web profile appReady plus registered production personal_agent health; no rendering or inference. Source-loader overhead is included.' }
}

/** Measure one cold process and await termination; all persistence lives below directory. */
export async function runScaleProfile({ checkout, source, directory, seedDatabase, count, repetition, output, queries = null }) {
  for (const name of ['harness-home', 'codex-home', 'user-home', 'workspace', 'data']) await mkdir(path.join(directory, name), { recursive: true, mode: 0o700 })
  directory = await realpath(directory)
  copyFileSync(seedDatabase, path.join(directory, 'data', 'ledger.sqlite'))
  if (queries) await writeFile(path.join(directory, 'profile-queries.json'), JSON.stringify(queries) + '\n', { flag: 'wx' })
  const patchPath = path.join(directory, 'scale.patch.json')
  await writeFile(patchPath, JSON.stringify([
    { id: 'hmr', disabled: true }, { id: 'session-title-llm', disabled: true },
    { id: 'session-log-deepseek', config: { enabled: false } },
    { id: 'credentials', config: { path: path.join(directory, 'harness-home', '.credentials.yaml'), watch: false } },
    { id: 'workspace-controller', config: { documentsDirectory: directory } },
    { insert: [
      { id: 'personal-agent-core-scale', name: pathToFileURL(path.join(source, 'index.js')).href, config: {
        dataDir: path.join(directory, 'data'), codexHome: path.join(directory, 'codex-home'),
        wechatLockDir: path.join(directory, 'locks'), allowedWorkspaceRoots: [directory],
        dshWorkerEnabled: true, codexWorkerEnabled: false, manageCodexDaemon: false, wechatEnabled: false,
        historySyncEnabled: false, historyStartupSyncEnabled: false, historyPeriodicSyncEnabled: false,
        memoryExtractionEnabled: false, semanticRoutingEnabled: false, cleanupEnabled: false, backupEnabled: false, inboxRetryEnabled: false,
      } },
      { id: 'personal-agent-scale-probe', name: new URL('./scale-profile-probe.js', import.meta.url).href },
    ] },
  ], null, 2) + '\n', { flag: 'wx' })
  const resolve = createRequire(path.join(checkout, 'package.json')).resolve
  const args = ['--import', pathToFileURL(resolve('tsx/esm')).href, path.join(checkout, 'apps/cli/src/bin.ts'),
    '--profile', 'web', '--patch', patchPath, '--no-open', '--port', '0']
  const logPath = path.join(output, `${count}-profile-${repetition}.log`)
  const started = performance.now()
  const spawnedAtEpochMs = Date.now()
  const child = spawn(process.execPath, args, { cwd: path.join(directory, 'workspace'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, TMPDIR: directory, TZ: 'UTC', LANG: 'C.UTF-8', HOME: path.join(directory, 'user-home'),
      DSH_HOME: path.join(directory, 'harness-home'), CODEX_HOME: path.join(directory, 'codex-home'),
      DSH_AGENTS_HOME: path.join(directory, 'agents-home'), DSH_TELEMETRY_DISABLED: '1',
      DSH_SCALE_PROFILE_ROOT: directory, DSH_SCALE_PROFILE_MESSAGES: String(count), TSX_TSCONFIG_PATH: path.join(checkout, 'tsconfig.json') } })
  const capture = chunk => appendFileSync(logPath, chunk.toString().replace(/([?&]token=)[^\s&]+/gu, '$1[redacted]'))
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  let exitState, spawnError
  const closed = new Promise(resolveClose => {
    child.once('error', error => { spawnError = { name: error.name, message: error.message } })
    child.once('close', (code, signal) => { exitState = { code, signal }; resolveClose(exitState) })
  })
  let ready, error, forced = false
  try {
    const deadline = performance.now() + 120000
    while (!ready) {
      if (exitState || spawnError) throw new Error(`Profile exited before readiness: ${JSON.stringify({ exitState, spawnError })}`)
      if (performance.now() >= deadline) throw new Error('Profile readiness exceeded 120000 ms')
      try { const failure = await readFile(path.join(directory, 'profile-failure.json'), 'utf8'); throw new Error(`Readiness probe failed: ${failure}`) }
      catch (failure) { if (failure.code !== 'ENOENT') throw failure }
      try { ready = JSON.parse(await readFile(path.join(directory, 'profile-ready.json'), 'utf8')) }
      catch (failure) { if (failure.code !== 'ENOENT') throw failure }
      if (!ready) await Promise.race([delay(25), closed])
    }
    ready.spawnToProbeFinishedMs = performance.now() - started
    ready.spawnToReadyMs = ready.healthReadyAtEpochMs - spawnedAtEpochMs
  } catch (failure) { error = { name: failure.name, message: failure.message, stack: failure.stack } }
  finally {
    if (!exitState) child.kill('SIGTERM')
    let timeout
    const normal = await Promise.race([closed.then(() => true), new Promise(resolveTimeout => { timeout = setTimeout(() => resolveTimeout(false), 30000) })])
    clearTimeout(timeout)
    if (!normal) { forced = true; child.kill('SIGKILL'); await closed }
  }
  const result = { count, repetition, args, ready: ready ?? null, error: error ?? null, forced, exitState, spawnError: spawnError ?? null }
  appendFileSync(path.join(output, 'profiles.jsonl'), JSON.stringify(result) + '\n')
  if (error || forced || spawnError) throw new Error(`Profile ${count}/${repetition} failed; see profiles.jsonl and captured log`)
  return result
}
