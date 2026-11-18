/** Start a real DSH profile with private persistence for managed-analysis measurements. */
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Launch the supported source CLI with an isolated Web profile and selected provider only.
 * @param options - Checkout, optional empty run root or closed evaluation restoreRoot, exact model, provider patch and credential file. Omitted experimentalCodexApi uses the plugin default.
 * @returns A sequential infer client and an awaited close operation; session logs remain in root.
 */
export async function startHarness({ checkout, root, restoreRoot, provider, model, reasoningEffort, providerPatchPath, credentialPath, codexInstallPath, experimentalCodexApi, probe = 'harness-probe.js', startupTimeoutMs = 120_000 }) {
  if (!['harness-probe.js', 'native-probe.js', 'autonomy-probe.js', 'lifecycle-probe.js'].includes(probe)) throw new Error('Unknown evaluation probe')
  if (experimentalCodexApi !== undefined && typeof experimentalCodexApi !== 'boolean') throw new TypeError('experimentalCodexApi must be a boolean')
  if (!checkout || !provider || !model || !providerPatchPath) throw new Error('checkout, provider, model and providerPatchPath are required')
  const checkoutRoot = await realpath(checkout)
  if (root && restoreRoot) throw new Error('Specify root or restoreRoot, not both')
  const runRoot = restoreRoot ? path.resolve(restoreRoot) : root ? path.resolve(root) : await mkdtemp(path.join(os.tmpdir(), 'personal-agent-evaluation-'))
  await mkdir(runRoot, { recursive: true, mode: 0o700 })
  const canonicalRoot = await realpath(runRoot)
  for (const home of [path.join(os.homedir(), '.dsh'), path.join(os.homedir(), '.codex'), process.env.DSH_HOME, process.env.CODEX_HOME].filter(Boolean)) {
    const canonicalHome = await realpath(home).catch(error => { if (error.code === 'ENOENT') return path.resolve(home); throw error })
    if (canonicalRoot === canonicalHome || canonicalRoot.startsWith(canonicalHome + path.sep) || canonicalHome.startsWith(canonicalRoot + path.sep)) throw new Error('Evaluation root must be separate from daily DSH and Codex homes')
  }
  const closedPath = path.join(canonicalRoot, 'evaluation-closed.json')
  let priorClosure
  if (restoreRoot) {
    if (!/^\d+\n$/u.test(await readFile(path.join(canonicalRoot, 'evaluation-owner'), 'utf8'))) throw new Error('Restore root has no evaluation ownership marker')
    priorClosure = JSON.parse(await readFile(closedPath, 'utf8'))
    if (priorClosure.version !== 1 || priorClosure.closed !== true) throw new Error('Restore root was not closed by the evaluation harness')
  } else await writeFile(path.join(canonicalRoot, 'evaluation-owner'), `${process.pid}\n`, { mode: 0o600, flag: 'wx' })
  const dshHome = path.join(canonicalRoot, 'harness-home')
  const codexHome = path.join(canonicalRoot, 'codex-home')
  const userHome = path.join(canonicalRoot, 'user-home')
  for (const directory of [dshHome, codexHome, userHome, path.join(canonicalRoot, 'workspace')]) {
    if (restoreRoot) { if (await realpath(directory) !== directory) throw new Error('Restored evaluation directories must stay inside the isolated root') }
    else await mkdir(directory, { mode: 0o700 })
  }
  const requireFromCheckout = createRequire(path.join(checkoutRoot, 'package.json'))
  const yaml = requireFromCheckout('js-yaml')
  const patches = yaml.load(await readFile(providerPatchPath, 'utf8'))
  const providerConfig = patches?.find(patch => patch.id === 'llm-pi-ai')?.config?.providers?.[provider]
  if (!providerConfig) throw new Error(`The provider patch does not configure ${provider}`)
  if (!providerConfig.apiKeyEnv) throw new Error('The isolated probe requires an explicit API key reference; ambient OAuth discovery is not used')
  const isolatedCredentials = path.join(dshHome, '.credentials.yaml')
  let credentialDocument
  if (credentialPath) {
    try { credentialDocument = yaml.load(await readFile(credentialPath, 'utf8')) }
    catch (_error) { throw new Error('The credentials file could not be read as valid YAML') }
    const value = credentialDocument?.refs?.[providerConfig.apiKeyEnv]
    if (typeof value !== 'string' || !value) throw new Error(`Credential reference ${providerConfig.apiKeyEnv} is unavailable`)
  } else if (!process.env[providerConfig.apiKeyEnv]) throw new Error(`No credentials file or environment value is available for ${providerConfig.apiKeyEnv}`)
  const selection = { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }
  const fingerprint = createHash('sha256').update(JSON.stringify({ checkoutRoot, selection, providerConfig, codexInstallPath, experimentalCodexApi, probe })).digest('hex')
  if (restoreRoot && priorClosure.fingerprint !== fingerprint) throw new Error('Restored evaluation profile must use the same probe and model configuration')
  const patchPath = path.join(canonicalRoot, 'evaluation.patch.json')
  await writeFile(patchPath, JSON.stringify([
    { id: 'hmr', disabled: true },
    { id: 'session-title-llm', disabled: true },
    { id: 'session-log-deepseek', config: { enabled: false } },
    { id: 'credentials', config: { path: isolatedCredentials, watch: false } },
    { id: 'llm-pi-ai', config: { providers: { [provider]: providerConfig } } },
    { id: 'agent-default-model', config: selection },
    { id: 'workspace-controller', config: { documentsDirectory: canonicalRoot } },
    { insert: [{ id: 'personal-agent-evaluation', name: new URL(probe, import.meta.url).href }] },
  ], null, 2) + '\n', { mode: 0o600 })
  const token = randomBytes(32).toString('hex')
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(PATH|TMPDIR|TEMP|TMP|LANG|LC_ALL|TZ|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|SystemRoot|WINDIR)$/i.test(name)
      || (credentialPath === undefined && name === providerConfig.apiKeyEnv)))
  if (!credentialPath) env[providerConfig.apiKeyEnv] = process.env[providerConfig.apiKeyEnv]
  if (credentialPath) await writeFile(isolatedCredentials, yaml.dump({ version: 1, refs: { [providerConfig.apiKeyEnv]: credentialDocument.refs[providerConfig.apiKeyEnv] } }), { mode: 0o600, flag: 'wx' })
  credentialDocument = undefined
  if (restoreRoot) {
    await unlink(path.join(canonicalRoot, 'ready.json'))
    await unlink(closedPath)
  }
  const child = spawn(process.execPath, ['--import', pathToFileURL(requireFromCheckout.resolve('tsx/esm')).href, path.join(checkoutRoot, 'apps/cli/src/bin.ts'), '--profile', 'web', '--patch', patchPath, '--no-open', '--port', '0'], {
    cwd: path.join(canonicalRoot, 'workspace'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, HOME: userHome, DSH_HOME: dshHome, CODEX_HOME: codexHome, DSH_AGENTS_HOME: path.join(canonicalRoot, 'agents-home'),
      TSX_TSCONFIG_PATH: path.join(checkoutRoot, 'tsconfig.json'), DSH_TELEMETRY_DISABLED: '1', DSH_EVALUATION_ROOT: canonicalRoot, DSH_EVALUATION_TOKEN: token, DSH_EVALUATION_SELECTION: JSON.stringify(selection),
      DSH_EVALUATION_PROVIDER: JSON.stringify({ baseURL: providerConfig.baseURL, apiKeyEnv: providerConfig.apiKeyEnv }),
      ...(codexInstallPath ? { DSH_EVALUATION_CODEX_INSTALL: await realpath(codexInstallPath) } : {}),
      ...(experimentalCodexApi === undefined ? {} : { DSH_EVALUATION_CODEX_EXPERIMENTAL: String(experimentalCodexApi) }) },
  })
  let output = ''
  const capture = chunk => { output = (output + chunk.toString()).slice(-48_000) }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  const exited = new Promise(resolve => {
    child.once('error', error => resolve({ error: error.message }))
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  let exitState
  exited.then(value => { exitState = value })
  let closing
  const close = () => closing ??= (async () => {
    if (!exitState) child.kill('SIGTERM')
    let timer
    const graceful = await Promise.race([exited.then(value => ({ value })), new Promise(resolve => { timer = setTimeout(() => resolve(null), 30_000) })])
    clearTimeout(timer)
    if (!graceful) { child.kill('SIGKILL'); await exited }
    // The selected API key is needed only while the profile is alive.
    if (credentialPath) await unlink(isolatedCredentials)
    await writeFile(closedPath, JSON.stringify({ version: 1, closed: true, fingerprint, exitState, forced: !graceful, closedAt: new Date().toISOString() }) + '\n', { mode: 0o600, flag: 'wx' })
    return { ...exitState, forced: !graceful }
  })()
  try {
    const deadline = performance.now() + startupTimeoutMs
    let ready
    while (!ready) {
      if (exitState) throw new Error(`Evaluation profile exited before readiness: ${JSON.stringify(exitState)}\n${output}`)
      if (performance.now() >= deadline) throw new Error(`Evaluation profile did not become ready within ${startupTimeoutMs} ms\n${output}`)
      try { ready = JSON.parse(await readFile(path.join(canonicalRoot, 'ready.json'), 'utf8')) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      if (!ready) await Promise.race([delay(100), exited])
    }
    return {
      root: canonicalRoot, endpoint: ready.endpoint, selection,
      async infer(options) {
        if (closing || exitState) throw new Error('Evaluation profile is no longer running')
        const response = await fetch(ready.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(options), signal: AbortSignal.timeout(options.budgetMs + 30_000) })
        const result = await response.json()
        if (!response.ok || !result.ok) throw Object.assign(new Error(result.error?.message ?? result.error ?? `HTTP ${response.status}`), { measurement: result })
        return result
      },
      close,
    }
  } catch (error) { await close(); throw error }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configPath = process.argv[2]
  if (!configPath) throw new Error('Usage: node test/evaluation/run-harness.js /absolute/path/to/private-run-config.json')
  const harness = await startHarness(JSON.parse(await readFile(configPath, 'utf8')))
  try {
    const result = await harness.infer({ purpose: 'evaluation-smoke', instructions: 'Return exactly the JSON object {"ok":true}.', input: { synthetic: true }, budgetMs: 60_000, maxInputChars: 1000, maxOutputChars: 1000 })
    await writeFile(path.join(harness.root, 'smoke-result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
    console.log(JSON.stringify({ root: harness.root, ok: result.value.ok, durationMs: result.durationMs, usage: result.usage, usageComplete: result.usageComplete }))
  } catch (error) {
    if (error.measurement) await writeFile(path.join(harness.root, 'smoke-result.json'), JSON.stringify(error.measurement, null, 2) + '\n', { mode: 0o600 })
    throw error
  } finally { await harness.close() }
}
