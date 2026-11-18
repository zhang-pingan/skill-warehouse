/** Real-model managed-analysis probe mounted only in an isolated DSH Web profile. */
import { timingSafeEqual } from 'node:crypto'
import { realpath, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { managedAnalysis } from '../../lib/managed-analysis.js'

export const inject = ['webServer', 'agents', 'subagents', 'agentPresets', 'sessionPersistence', 'workspaceRegistry']

const usageKeys = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']

/** Read native attempt accounting without counting a message's stream twice. */
async function measurement(persistence, sessionId) {
  if (!sessionId || !await persistence.stat(sessionId)) return { attempts: [], usage: null, usageComplete: false }
  const handle = await persistence.open(sessionId, 'read')
  const attempts = []
  const endings = []
  let eventCount = 0
  try {
    while (true) {
      const { events } = await handle.read(eventCount, 256)
      if (!events.length) break
      eventCount += events.length
      for (const event of events) {
        if (event.type === 'turn/end') endings.push({ seq: event.seq, reason: event.data.reason })
        if (!['assistant/message', 'assistant/attempt'].includes(event.type)) continue
        const nativeUsage = event.data.usage ?? event.data.stream?.findLast(record => record.type === 'chunk' && record.chunk.type === 'usage')?.chunk.usage
        attempts.push({ seq: event.seq, type: event.type, turn: event.data.turn, step: event.data.step, usage: nativeUsage ?? null })
      }
    }
  } finally { await handle.close() }
  const available = attempts.filter(attempt => attempt.usage !== null)
  const usageComplete = attempts.length > 0 && available.length === attempts.length
  const usage = available.length ? Object.fromEntries(usageKeys
    .filter(key => available.every(attempt => Number.isFinite(attempt.usage[key])))
    .map(key => [key, available.reduce((sum, attempt) => sum + attempt.usage[key], 0)])) : null
  return { attempts, usage, usageComplete, eventCount, endings }
}

function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

async function readRequest(req) {
  let bytes = 0
  const chunks = []
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > 1_048_576) throw new Error('Evaluation request exceeds 1 MiB')
    chunks.push(chunk)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Evaluation request must be an object')
  for (const key of ['purpose', 'instructions']) if (typeof value[key] !== 'string' || !value[key]) throw new Error(`${key} must be nonempty text`)
  if (!value.input || typeof value.input !== 'object') throw new Error('input must be JSON source material')
  for (const key of ['budgetMs', 'maxInputChars', 'maxOutputChars']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 1) throw new Error(`${key} must be a positive integer`)
  }
  if (value.budgetMs > 600_000 || value.maxInputChars > 512_000 || value.maxOutputChars > 128_000) throw new Error('Evaluation budgets exceed probe limits')
  return value
}

/** Mount a bounded inference endpoint; shutdown aborts and joins all accepted analyses. */
export async function apply(ctx) {
  const root = await realpath(process.env.DSH_EVALUATION_ROOT ?? '')
  const dshHome = await realpath(process.env.DSH_HOME ?? '')
  const codexHome = await realpath(process.env.CODEX_HOME ?? '')
  if (dshHome !== path.join(root, 'harness-home') || codexHome !== path.join(root, 'codex-home')
    || [path.join(os.homedir(), '.dsh'), path.join(os.homedir(), '.codex')].some(home => root === home || root.startsWith(home + path.sep))) {
    throw new Error('Evaluation requires private DSH_HOME and CODEX_HOME beneath DSH_EVALUATION_ROOT')
  }
  const token = process.env.DSH_EVALUATION_TOKEN
  if (!token || token.length < 32) throw new Error('Evaluation requires a private request token')
  const selection = JSON.parse(process.env.DSH_EVALUATION_SELECTION ?? '{}')
  if (!selection.provider || !selection.model) throw new Error('Evaluation requires an explicit model selection')
  await ctx.workspaceRegistry.initializeDefault(async () => path.join(root, 'workspace'))
  const lifetime = new AbortController()
  const pending = new Set()
  const authorized = req => {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return false
    const actual = Buffer.from(String(req.headers.authorization ?? ''))
    const expected = Buffer.from(`Bearer ${token}`)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }
  ctx.effect(() => {
    const unregister = ctx.webServer.register({ kind: 'exact', path: '/api/evaluation/infer', handler: async (req, res) => {
      if (!authorized(req)) { send(res, 403, { error: 'Evaluation request is not authorized' }); return }
      if (req.method !== 'POST') { send(res, 405, { error: 'Use POST' }); return }
      if (lifetime.signal.aborted) { send(res, 503, { error: 'Evaluation is stopping' }); return }
      if (pending.size) { send(res, 409, { error: 'An evaluation is already running; requests must be sequential' }); return }
      const abortRequest = () => req.destroy()
      lifetime.signal.addEventListener('abort', abortRequest, { once: true })
      const run = (async () => {
        let options
        try { options = await readRequest(req) } catch (error) { send(res, 400, { error: error.message }); return }
        const started = performance.now()
        let ids = {}
        let value
        let failure
        try {
          value = await managedAnalysis(ctx, { purpose: options.purpose, instructions: options.instructions, input: options.input,
            cwd: path.join(root, 'workspace'), selection, signal: lifetime.signal,
            budgetMs: options.budgetMs, maxInputChars: options.maxInputChars, maxOutputChars: options.maxOutputChars,
            onSession: observed => { ids = observed } })
        } catch (error) { failure = { name: error.name, message: error.message, reason: error.reason ?? null } }
        const durationMs = performance.now() - started
        let observed
        try { observed = await measurement(ctx.sessionPersistence, ids.sessionId) }
        catch (error) { observed = { attempts: [], usage: null, usageComplete: false, measurementError: error.message } }
        send(res, 200, { ok: !failure, ...value, ...ids, model: selection, durationMs, ...observed, ...(failure ? { error: failure } : {}) })
      })()
      pending.add(run)
      try { await run } finally { pending.delete(run); lifetime.signal.removeEventListener('abort', abortRequest) }
    } })
    return async () => {
      unregister()
      lifetime.abort(new Error('Evaluation profile is stopping'))
      await Promise.allSettled([...pending])
    }
  })
  const ready = path.join(root, 'ready.json')
  await writeFile(ready + '.tmp', JSON.stringify({ endpoint: `http://127.0.0.1:${ctx.webServer.port}/api/evaluation/infer`, model: selection }) + '\n', { mode: 0o600, flag: 'wx' })
  await rename(ready + '.tmp', ready)
}
