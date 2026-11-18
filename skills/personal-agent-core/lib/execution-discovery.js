/** Bounded, backend-independent discovery of execution tasks and historical conversation work. */
import { parseJson } from './ids.js'

const tokens = text => new Set(String(text ?? '').toLocaleLowerCase().match(/[\p{Script=Han}]|[\p{L}\p{N}_]+/gu) ?? [])
export function objectiveScore(left, right) {
  if (String(left).trim().toLocaleLowerCase() === String(right).trim().toLocaleLowerCase()) return 1
  const a = tokens(left), b = tokens(right)
  return a.size && b.size ? 2 * [...a].filter(item => b.has(item)).length / (a.size + b.size) : 0
}

/** Return source identities, relevant messages and coverage without acquiring any native session. */
export function discoverExecutionTargets(service, args = {}) {
  const db = service.database.db
  const limit = Math.min(service.config.routeCandidateLimit, Math.max(1, args.limit ?? service.config.routeCandidateLimit))
  const offset = Math.max(0, args.offset ?? 0)
  const taskId = args.explicitTaskId ?? args.taskId ?? null
  const project = args.projectId ?? null
  const historyId = args.sessionTaskId ?? null
  const sessionId = args.sessionId ?? null
  const system = args.sourceSystem ?? null
  const rows = db.prepare(`WITH targets AS (
    SELECT t.*,COALESCE(
      (SELECT x.session_ref_id FROM executions e JOIN execution_sessions x USING(execution_id)
        JOIN session_refs r USING(session_ref_id) WHERE e.task_id=t.task_id AND x.role='executor'
        AND r.source_kind IS NOT 'app_server_turn' ORDER BY e.attempt_no DESC LIMIT 1),
      (SELECT session_ref_id FROM task_sessions WHERE task_id=t.task_id AND relation='executor'
        ORDER BY attached_at DESC,rowid DESC LIMIT 1)) AS executor_ref FROM tasks t)
    SELECT t.* FROM targets t LEFT JOIN session_refs s ON s.session_ref_id=t.executor_ref
    WHERE (t.task_state NOT IN ('cancelled','merged') OR t.task_id=?)
    AND (t.source_key IS NULL OR (t.source_key NOT LIKE 'dsh:%' AND t.source_key NOT LIKE 'codex-thread:%'))
    AND (? IS NULL) AND (? IS NULL OR t.task_id=?) AND (? IS NULL OR t.project_id=?)
    AND (? IS NULL OR s.external_id=?) AND (? IS NULL OR s.system=?)
    ORDER BY CASE WHEN t.objective=? THEN 0 ELSE 1 END,t.updated_at DESC,t.task_id LIMIT ? OFFSET ?`)
    .all(taskId,historyId,taskId,taskId,project,project,sessionId,sessionId,system,system,args.objective ?? '',limit + 1,offset)
  const candidates = new Map()
  const sourceFor = id => db.prepare(`SELECT s.*,e.worker_policy_json,e.step_id,e.execution_id,e.execution_state
    FROM execution_sessions es JOIN executions e USING(execution_id) JOIN session_refs s USING(session_ref_id)
    WHERE e.task_id=? AND es.role='executor' AND s.source_kind IS NOT 'app_server_turn'
    ORDER BY e.attempt_no DESC LIMIT 1`).get(id)
    ?? db.prepare(`SELECT s.* FROM task_sessions ts JOIN session_refs s USING(session_ref_id)
      WHERE ts.task_id=? AND ts.relation='executor' ORDER BY ts.attached_at DESC,ts.rowid DESC LIMIT 1`).get(id)
  const attach = (candidate, source) => {
    if (!source) return candidate
    const executionCwd = db.prepare(`SELECT l.canonical_path FROM execution_sessions x
      JOIN executions e USING(execution_id) JOIN project_locations l ON l.location_id=e.workspace_location_id
      WHERE x.session_ref_id=? AND x.role='executor' ORDER BY e.rowid DESC LIMIT 1`).get(source.session_ref_id)?.canonical_path
    const cwd = executionCwd ?? source.cwd ?? (candidate.projectId ? db.prepare('SELECT canonical_path FROM project_locations WHERE project_id=? ORDER BY observed_at DESC LIMIT 1').get(candidate.projectId)?.canonical_path : null) ?? null
    return { ...candidate, sessionRefId: source.session_ref_id, sessionId: source.external_id, sourceSystem: source.system,
      ...(source.system === 'codex' ? { threadId: source.external_id } : {}), cwd, sourceKind: source.source_kind ?? null,
      nativeStatus: source.native_status ?? null, workerPolicy: parseJson(source.worker_policy_json, {}), executionId: source.execution_id ?? null,
      executionState: source.execution_state ?? null }
  }
  for (const row of rows.slice(0,limit)) {
    const score = taskId === row.task_id ? 1 : objectiveScore(args.objective,row.objective)
    const candidate = attach({ candidateId: row.task_id, taskId: row.task_id, projectId: row.project_id, objective: row.objective,
      state: row.task_state, score, objectiveCompatible: !!taskId || score >= service.config.routeResumeThreshold }, sourceFor(row.task_id))
    candidates.set(candidate.candidateId,candidate)
  }
  const historical = db.prepare(`SELECT h.*,s.system,s.external_id,s.cwd,s.source_kind,s.native_status,l.task_id,p.project_id
    FROM session_tasks h JOIN session_refs s USING(session_ref_id)
    LEFT JOIN task_sources l ON l.source_key='history:'||h.session_task_id
    LEFT JOIN project_locations p ON p.canonical_path=s.cwd
    WHERE (? IS NULL OR h.session_task_id=?) AND (? IS NULL OR s.external_id=?) AND (? IS NULL OR s.system=?)
      AND (? IS NULL OR p.project_id=?) AND (? IS NULL OR l.task_id=?)
    ORDER BY CASE WHEN h.goal=? OR h.title=? THEN 0 ELSE 1 END,h.last_activity_at DESC,h.session_task_id LIMIT ? OFFSET ?`)
    .all(historyId,historyId,sessionId,sessionId,system,system,project,project,taskId,taskId,args.objective ?? '',args.objective ?? '',limit+1,offset)
  for (const row of historical.slice(0,limit)) {
    const linked = row.task_id ? service.ledger.getTask(row.task_id) : null
    const key = linked?.taskId ?? row.session_task_id
    const messages = db.prepare(`SELECT m.message_id,m.evidence_id,m.source_order FROM session_task_messages l
      JOIN history_messages m USING(message_id) WHERE l.session_task_id=? ORDER BY m.source_order DESC LIMIT 8`).all(row.session_task_id)
    const score = historyId || sessionId ? 1 : Math.max(objectiveScore(args.objective,row.goal),objectiveScore(args.objective,row.title))
    const existing = candidates.get(key)
    const candidate = attach({ ...existing, candidateId:key, taskId:linked?.taskId ?? null, sessionTaskId:row.session_task_id,
      sourceKey:`history:${row.session_task_id}`, projectId:linked?.projectId ?? row.project_id ?? null,
      objective:linked?.objective ?? row.goal, summary:row.summary, state:linked?.state ?? 'open', historicalState:row.state,
      contextVersion:row.context_version, messages, score:Math.max(existing?.score ?? 0,score),
      objectiveCompatible:!!historyId || !!sessionId || score>=service.config.routeResumeThreshold }, linked && !historyId && !sessionId && !system ? sourceFor(linked.taskId) ?? row : row)
    candidates.set(key,candidate)
  }
  if (sessionId && !taskId && !historyId && !candidates.size) {
    const sources = db.prepare('SELECT * FROM session_refs WHERE external_id=? AND (? IS NULL OR system=?)').all(sessionId,system,system)
    for (const source of sources) {
      const linked = db.prepare('SELECT task_id FROM task_sources WHERE source_key=?').get(`session:${source.session_ref_id}`)
        ?? db.prepare("SELECT task_id FROM task_sessions WHERE session_ref_id=? AND relation='executor' ORDER BY attached_at DESC,rowid DESC LIMIT 1").get(source.session_ref_id)
      const task = linked ? service.ledger.getTask(linked.task_id) : null
      if (project && task?.projectId !== project) continue
      candidates.set(source.session_ref_id,attach({candidateId:source.session_ref_id,taskId:task?.taskId ?? null,
        sourceKey:`session:${source.session_ref_id}`,objective:task?.objective ?? args.objective,state:task?.state ?? 'open',score:1,objectiveCompatible:true},source))
    }
  }
  let supplementary = []
  if (!taskId && !historyId && args.objective && service.flags.enabled('history.read')) {
    const found = service.ledger.history.list({ query: args.query ?? args.objective, rawSearch:true, limit, offset,
      sessionId,sourceSystem:system,projectId:project })
    supplementary = found.supplementary ?? []
  }
  const coverage = { ...service.ledger.history.coverage(), candidateLimit:limit,offset,
    truncated:rows.length>limit || historical.length>limit, supplementary, nextOffset:rows.length>limit || historical.length>limit ? offset+limit : null }
  return { candidates:[...candidates.values()].sort((a,b)=>b.score-a.score || a.candidateId.localeCompare(b.candidateId)),coverage }
}
