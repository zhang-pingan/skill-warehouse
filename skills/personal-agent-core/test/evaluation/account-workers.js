/** Count native worker usage without adding repeated observations or cumulative totals. */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { digest } from './fixture.js'

const output = path.resolve(process.argv[2])
const rows = readFileSync(path.join(output, 'results.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
const dsh = rows.filter(row => row.caseId === 'worker-dsh-aggregate').map(row => {
  const attempts = new Map()
  const turns = (row.result.turns ?? []).map(turn => {
    const observed = turn.observation
    const added = []
    for (const attempt of observed?.attempts ?? []) {
      const key = `${observed.sessionId}:${attempt.seq}`
      if (!attempts.has(key)) { attempts.set(key, attempt); added.push(attempt) }
    }
    return { attempts: added.length, usageComplete: added.length > 0 && added.every(attempt => attempt.usage),
      usage: Object.fromEntries(['inputTokens', 'cacheReadTokens', 'outputTokens', 'totalTokens'].map(key => [key, added.reduce((sum, attempt) => sum + (attempt.usage?.[key] ?? 0), 0)])) }
  })
  return { caseId: row.caseId, repeat: row.repeat, turns, modelAttempts: attempts.size }
})
const codexRows = rows.filter(row => row.caseId === 'worker-codex-aggregate' && row.result.ok)
const codex = []
if (codexRows.length) {
  const archive = path.join(output, 'codex-sessions.tar.gz')
  const names = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n')
    .filter(name => name.endsWith('.jsonl') && !path.basename(name).startsWith('._'))
  for (const name of names) {
    const events = execFileSync('tar', ['-xOzf', archive, name], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim().split('\n').map(JSON.parse)
    const firstTurn = events.find(event => event.type === 'event_msg' && event.payload?.type === 'task_started')?.payload.turn_id
    const row = codexRows.find(item => item.result.turns[0].native.thread.turns.some(turn => turn.id === firstTurn))
    if (!row) throw new Error(`Unmatched Codex native rollout: ${name}`)
    const tokens = events.filter(event => event.type === 'event_msg' && event.payload?.type === 'token_count' && event.payload.info).map(event => event.payload.info)
    const totals = tokens.at(-1)?.total_token_usage
    if (!totals || !tokens.length) throw new Error('Codex rollout has no native token accounting')
    const checks = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens']
    for (const key of checks) if (tokens.reduce((sum, event) => sum + event.last_token_usage[key], 0) !== totals[key]) throw new Error(`Repeated or missing token counts: ${key}`)
    const adapterFinal = row.result.usage.map(item => item.usage.total).sort((a, b) => b.totalTokens - a.totalTokens)[0]
    if (adapterFinal.totalTokens !== totals.total_tokens) throw new Error('Codex adapter and native final totals differ')
    codex.push({ caseId: row.caseId, repeat: row.repeat, modelCompletionsWithUsage: tokens.length, archiveMember: name,
      usage: { inputIncludingCache: totals.input_tokens, cacheReadTokens: totals.cached_input_tokens, nonCachedInputTokens: totals.input_tokens - totals.cached_input_tokens,
        outputTokens: totals.output_tokens, reasoningOutputTokens: totals.reasoning_output_tokens, totalTokens: totals.total_tokens } })
  }
  if (codex.length !== codexRows.length) throw new Error('Codex rollout count differs from successful measurements')
}
const sums = items => Object.fromEntries([...new Set(items.flatMap(item => Object.keys(item)))].map(key => [key, items.reduce((sum, item) => sum + item[key], 0)]))
const result = { version: 'native-worker-accounting-v1', recordedAt: new Date().toISOString(), postprocessorSha256: digest(readFileSync(new URL(import.meta.url))),
  resultsSha256: digest(readFileSync(path.join(output, 'results.jsonl'))),
  method: 'DSH: deduplicate observations by sessionId/seq. Codex: final native per-session total only, verified against summed per-completion last usage and adapter final total. Cached tokens are a subset of Codex input; reasoning is a subset of output.',
  limitation: 'Codex modelCompletionsWithUsage does not reveal transport retries without a completed usage record. No price estimate. DSH omitted cache field is zero for this pi-ai provider; separate reasoning usage is unavailable.',
  dsh: { rows: dsh, modelAttempts: dsh.reduce((sum, row) => sum + row.modelAttempts, 0), usage: sums(dsh.flatMap(row => row.turns.map(turn => turn.usage))) },
  codex: { rows: codex, modelCompletionsWithUsage: codex.reduce((sum, row) => sum + row.modelCompletionsWithUsage, 0), usage: sums(codex.map(row => row.usage)) } }
writeFileSync(path.join(output, 'usage-diagnostics.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify(result))
