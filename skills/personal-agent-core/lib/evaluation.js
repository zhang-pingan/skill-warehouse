import { criteriaOf } from './acceptance.js'
import { parseJson } from './ids.js'

/** Summarize ledger executions; unsupplied criterion results remain pending. */
export function executionEvaluation(db) {
  const byState = db.prepare(`SELECT executor_kind,execution_state,COUNT(*) AS count,
    AVG(CASE WHEN started_at IS NOT NULL AND finished_at IS NOT NULL THEN (julianday(finished_at)-julianday(started_at))*86400000 END) AS average_ms
    FROM executions GROUP BY executor_kind,execution_state ORDER BY executor_kind,execution_state`).all()
    .map(row => ({ worker: row.executor_kind, state: row.execution_state, count: Number(row.count), averageMs: row.average_ms === null ? null : Math.round(row.average_ms) }))
  const results = new Map()
  for (const row of db.prepare('SELECT * FROM acceptance_results ORDER BY sequence').all()) {
    if (!results.has(row.execution_id)) results.set(row.execution_id, new Map())
    results.get(row.execution_id).set(row.criterion_id, { state: row.state, evidenceIds: parseJson(row.evidence_ids_json, []) })
  }
  const quality = { passed: 0, pending: 0, failed: 0, verifiedExecutionCount: 0 }
  const workers = new Map()
  for (const execution of db.prepare(`SELECT e.*,COALESCE(s.acceptance_json,t.acceptance_json) AS definitions
    FROM executions e JOIN tasks t USING(task_id) LEFT JOIN task_steps s USING(step_id)
    WHERE e.executor_kind<>'codex' OR EXISTS(SELECT 1 FROM outbox o WHERE o.execution_id=e.execution_id AND o.method='turn/start')`).all()) {
    const criteria = criteriaOf(parseJson(execution.definitions, []))
    let verified = execution.execution_state === 'succeeded' && criteria.length > 0
    for (const criterion of criteria) {
      const item = results.get(execution.execution_id)?.get(criterion.id)
      const passed = execution.execution_state === 'succeeded' && item?.state === 'passed' && item.evidenceIds.length > 0
        && item.evidenceIds.every(id => db.prepare('SELECT 1 FROM evidence WHERE evidence_id=? AND execution_id=? AND task_id=?').get(id, execution.execution_id, execution.task_id))
      quality[passed ? 'passed' : item?.state === 'failed' ? 'failed' : 'pending'] += 1
      verified &&= passed
    }
    if (verified) quality.verifiedExecutionCount += 1
    if (!workers.has(execution.executor_kind)) workers.set(execution.executor_kind, { worker: execution.executor_kind, count: 0, durations: [] })
    const worker = workers.get(execution.executor_kind)
    worker.count += 1
    const duration = Date.parse(execution.finished_at) - Date.parse(execution.started_at)
    if (Number.isFinite(duration) && duration >= 0) worker.durations.push(duration)
  }
  const total = quality.passed + quality.pending + quality.failed
  quality.acceptancePassRate = total ? quality.passed / total : null
  const byWorker = [...workers.values()].map(({ worker, count, durations }) => {
    durations.sort((a,b) => a-b)
    const percentile = p => durations.length ? durations[Math.ceil(durations.length*p)-1] : null
    return { worker, count, durationSamples: durations.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95) }
  })
  // Codex thread totals can span multiple turns; retain the native report without summing it as per-execution tokens.
  const usage = db.prepare(`SELECT u.*,e.executor_kind FROM execution_usage u JOIN executions e USING(execution_id) ORDER BY u.recorded_at DESC`).all()
    .map(row => ({ executionId: row.execution_id, worker: row.executor_kind, provider: row.provider, model: row.model, usage: parseJson(row.usage_json, {}) }))
  return { byState, byWorker, usage, quality, cost: { available: false, reason: 'Provider prices are not supplied; reported token usage is shown separately' } }
}
