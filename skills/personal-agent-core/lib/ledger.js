import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { SessionHistory } from './session-history.js'
import { cleanText, encodeRpcId, json, newId, nowIso, parseJson, sha256, stableId } from './ids.js'
import { assertTransition } from './state-machines.js'
import { matchedSearchTerms, searchTerms, topicMatchThreshold, topicSearchTerms } from './fts.js'
import { memoryClass, memoryFragments } from './memory.js'
import { criteriaOf, requireCriteria } from './acceptance.js'

const rowTask = row => row && ({
  taskId: row.task_id,
  projectId: row.project_id,
  parentTaskId: row.parent_task_id,
  objective: row.objective,
  state: row.task_state,
  confidence: row.confidence,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at,
  acceptance: parseJson(row.acceptance_json, []),
})

const rowSession = row => row && ({
  sessionRefId: row.session_ref_id,
  system: row.system,
  externalId: row.external_id,
  rootExternalId: row.root_external_id,
  sourceKind: row.source_kind,
  cwd: row.cwd,
  workspaceRoots: parseJson(row.workspace_roots_json, []),
  durability: row.durability,
  nativeStatus: row.native_status,
  observedAt: row.observed_at,
  firstSeenAt: row.first_seen_at,
  lastSeenAt: row.last_seen_at,
})

function normalizeRemoteUrl(value) {
  let remote = String(value ?? '').trim()
  if (!remote) return null
  const scp = /^([^@/:]+)@([^:]+):(.+)$/.exec(remote)
  if (scp) remote = `ssh://${scp[1]}@${scp[2]}/${scp[3]}`
  try {
    const parsed = new URL(remote)
    const host = parsed.hostname.toLocaleLowerCase()
    const pathname = parsed.pathname.replace(/\/+$|\.git$/g, '').replace(/^\/+/, '')
    return host && pathname ? `${host}${parsed.port ? `:${parsed.port}` : ''}/${host === 'github.com' ? pathname.toLowerCase() : pathname}` : null
  } catch {
    return remote.replace(/\\/g, '/').replace(/\/+$|\.git$/g, '').toLocaleLowerCase()
  }
}

function originRemote(configPath) {
  if (!existsSync(configPath)) return null
  let inOrigin = false
  for (const line of readFileSync(configPath, 'utf8').split(/\r?\n/u)) {
    const section = /^\s*\[remote\s+"([^"]+)"\]\s*$/u.exec(line)
    if (/^\s*\[/u.test(line)) { inOrigin = section?.[1] === 'origin'; continue }
    if (!inOrigin) continue
    const match = /^\s*url\s*=\s*(.+?)\s*$/u.exec(line)
    if (match) return normalizeRemoteUrl(match[1])
  }
  return null
}

function projectIdentity(canonicalPath, configuredCommonDir) {
  if (configuredCommonDir) return { kind: 'git-common-dir', value: realpathSync(configuredCommonDir) }
  const dotGit = path.join(canonicalPath, '.git')
  if (!existsSync(dotGit)) return { kind: 'path', value: canonicalPath }
  if (statSync(dotGit).isDirectory()) {
    const remote = originRemote(path.join(dotGit, 'config'))
    return remote ? { kind: 'git-remote-origin', value: remote } : { kind: 'git-common-dir', value: realpathSync(dotGit) }
  }
  const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))
  if (!match) return { kind: 'path', value: canonicalPath }
  const worktreeGitDir = realpathSync(path.resolve(canonicalPath, match[1]))
  const commonDirFile = path.join(worktreeGitDir, 'commondir')
  const commonDir = existsSync(commonDirFile) ? path.resolve(worktreeGitDir, readFileSync(commonDirFile, 'utf8').trim()) : worktreeGitDir
  const remote = originRemote(path.join(commonDir, 'config')) ?? originRemote(path.join(worktreeGitDir, 'config'))
  return remote ? { kind: 'git-remote-origin', value: remote } : { kind: 'git-common-dir', value: realpathSync(commonDir) }
}

export class Ledger {
  constructor(database, { clock = Date.now, instanceId = newId('instance') } = {}) {
    this.database = database
    this.db = database.db
    this.history = new SessionHistory(this)
    this.clock = clock
    this.instanceId = instanceId
  }

  upsertProject({ name, canonicalPath, gitCommonDir = null, worktreeId = null }) {
    if (!path.isAbsolute(canonicalPath)) throw new Error('Project path must be absolute')
    try { canonicalPath = realpathSync(canonicalPath) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      canonicalPath = path.resolve(canonicalPath)
    }
    const at = nowIso(this.clock)
    const identity = projectIdentity(canonicalPath, gitCommonDir)
    const existingLocation = this.db.prepare('SELECT project_id FROM project_locations WHERE canonical_path=?').get(canonicalPath)
    const alias = this.db.prepare('SELECT project_id FROM project_aliases WHERE identity_kind=? AND identity_value=?').get(identity.kind, identity.value)
    if (existingLocation && alias && existingLocation.project_id !== alias.project_id) throw new Error('Project location and repository identity disagree; explicit reconciliation is required')
    const projectId = existingLocation?.project_id ?? alias?.project_id ?? stableId('project', identity.kind, identity.value)
    const locationId = stableId('location', canonicalPath)
    this.database.transaction(() => {
      this.db.prepare(`INSERT INTO projects(project_id,name,identity_kind,identity_value,created_at,updated_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at`)
        .run(projectId, cleanText(name || path.basename(canonicalPath), 240), identity.kind, identity.value, at, at)
      this.db.prepare(`INSERT INTO project_locations(location_id,project_id,canonical_path,git_common_dir,worktree_id,observed_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(canonical_path) DO UPDATE SET project_id=excluded.project_id,git_common_dir=excluded.git_common_dir,worktree_id=excluded.worktree_id,observed_at=excluded.observed_at`)
        .run(locationId, projectId, canonicalPath, gitCommonDir, worktreeId, at)
    })
    this.db.prepare('INSERT OR IGNORE INTO project_aliases(identity_kind,identity_value,project_id) VALUES(?,?,?)').run(identity.kind, identity.value, projectId)
    return { projectId, locationId }
  }

  linkProjectLocation(projectId, canonicalPath) {
    if (!this.db.prepare('SELECT 1 FROM projects WHERE project_id=?').get(projectId)) throw new Error('Project does not exist')
    const observed = this.upsertProject({ canonicalPath })
    if (observed.projectId === projectId) return observed
    const occupied = this.db.prepare('SELECT 1 FROM tasks WHERE project_id=? LIMIT 1').get(observed.projectId)
    if (occupied) throw new Error('Location already belongs to a project with records; explicit reconciliation is required')
    return this.database.transaction(() => {
      this.db.prepare('UPDATE project_locations SET project_id=? WHERE location_id=?').run(projectId, observed.locationId)
      this.db.prepare('UPDATE project_aliases SET project_id=? WHERE project_id=?').run(projectId, observed.projectId)
      this.db.prepare('DELETE FROM projects WHERE project_id=?').run(observed.projectId)
      return { projectId, locationId: observed.locationId }
    })
  }

  createTask({ objective, projectId = null, parentTaskId = null, state = 'open', confidence = 1, sourceKey = null, acceptance = [] }) {
    const text = cleanText(objective, 8_000)
    if (!text) throw new Error('Task objective is required')
    const at = nowIso(this.clock)
    const taskId = sourceKey ? stableId('task', sourceKey) : newId('task')
    const acceptanceJson = JSON.stringify(Array.isArray(acceptance) ? acceptance.slice(0, 32) : [])
    this.db.prepare(`INSERT INTO tasks(task_id,project_id,parent_task_id,source_key,objective,task_state,confidence,created_at,updated_at,acceptance_json)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_key) DO UPDATE SET objective=CASE WHEN tasks.objective='' THEN excluded.objective ELSE tasks.objective END,updated_at=MAX(tasks.updated_at,excluded.updated_at),acceptance_json=CASE WHEN tasks.acceptance_json='[]' THEN excluded.acceptance_json ELSE tasks.acceptance_json END`)
      .run(taskId, projectId, parentTaskId, sourceKey, text, state, confidence, at, at, acceptanceJson)
    return this.getTask(taskId) ?? (sourceKey ? this.getTaskBySource(sourceKey) : null)
  }

  getTaskBySource(sourceKey) {
    return rowTask(this.db.prepare('SELECT * FROM tasks WHERE source_key=?').get(sourceKey))
  }

  getTask(taskId) {
    const task = rowTask(this.db.prepare('SELECT * FROM tasks WHERE task_id=?').get(taskId))
    if (!task) return null
    task.sessions = this.db.prepare(`SELECT s.*,ts.relation,ts.confidence AS relation_confidence FROM task_sessions ts JOIN session_refs s USING(session_ref_id) WHERE ts.task_id=? ORDER BY s.last_seen_at DESC`)
      .all(taskId).map(row => ({ ...rowSession(row), relation: row.relation, confidence: row.relation_confidence }))
    task.executions = this.db.prepare('SELECT execution_id,attempt_no,executor_kind,execution_state,started_at,finished_at,result_class,failure_code FROM executions WHERE task_id=? ORDER BY attempt_no DESC').all(taskId)
    return task
  }

  listTasks({ state, projectId, limit = 50, cursor } = {}) {
    const clauses = []
    const params = []
    if (state) { clauses.push('task_state=?'); params.push(state) }
    if (projectId) { clauses.push('project_id=?'); params.push(projectId) }
    if (cursor) { clauses.push('updated_at<?'); params.push(cursor) }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db.prepare(`SELECT * FROM tasks ${where} ORDER BY updated_at DESC,task_id LIMIT ?`).all(...params, Math.min(200, Math.max(1, limit)))
    return { data: rows.map(rowTask), nextCursor: rows.length === limit ? rows.at(-1).updated_at : null }
  }

  transitionTask(taskId, nextState, expectedState) {
    if (typeof expectedState !== 'string') throw new TypeError('expectedState is required')
    return this.database.transaction(() => {
      const current = this.db.prepare('SELECT task_state,acceptance_json FROM tasks WHERE task_id=?').get(taskId)
      if (!current || current.task_state !== expectedState) throw new Error('Task state changed or task does not exist')
      if (nextState === 'completed') {
        this.assertAccepted(taskId, null, parseJson(current.acceptance_json, []))
        if (this.db.prepare("SELECT 1 FROM task_steps WHERE task_id=? AND step_state<>'completed'").get(taskId)) throw new Error('All task steps must be completed')
      }
      assertTransition('task', current.task_state, nextState)
      const at = nowIso(this.clock)
      const completedAt = nextState === 'completed' ? at : null
      const result = this.db.prepare('UPDATE tasks SET task_state=?,updated_at=?,completed_at=? WHERE task_id=? AND task_state=?')
        .run(nextState, at, completedAt, taskId, expectedState)
      if (!result.changes) throw new Error('Task state changed or task does not exist')
      this.appendEvent('task', taskId, `task.${nextState}`, { expectedState })
      return this.getTask(taskId)
    })
  }

  upsertSession({ system, externalId, rootExternalId = null, sourceKind = null, cwd = null, workspaceRoots = [], durability = 'unknown', nativeStatus = null, observedAt = null, firstSeenAt = null, lastSeenAt = null }) {
    if (cwd && path.isAbsolute(cwd)) {
      try { cwd = realpathSync(cwd) } catch (error) {
        if (error.code !== 'ENOENT') throw error
        cwd = path.resolve(cwd)
      }
    }
    const at = observedAt ?? nowIso(this.clock)
    const sessionRefId = stableId('session', system, externalId)
    this.db.prepare(`INSERT INTO session_refs(session_ref_id,system,external_id,root_external_id,source_kind,cwd,workspace_roots_json,durability,native_status,observed_at,first_seen_at,last_seen_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(system,external_id) DO UPDATE SET
      root_external_id=COALESCE(excluded.root_external_id,session_refs.root_external_id),source_kind=CASE WHEN session_refs.source_kind='app_server_thread' THEN session_refs.source_kind WHEN excluded.source_kind='app_server_thread' THEN excluded.source_kind ELSE COALESCE(session_refs.source_kind,excluded.source_kind) END,
      cwd=COALESCE(excluded.cwd,session_refs.cwd),workspace_roots_json=CASE WHEN excluded.workspace_roots_json='[]' THEN session_refs.workspace_roots_json ELSE excluded.workspace_roots_json END,
      durability=CASE WHEN excluded.durability='unknown' THEN session_refs.durability ELSE excluded.durability END,native_status=COALESCE(excluded.native_status,session_refs.native_status),
      observed_at=COALESCE(excluded.observed_at,session_refs.observed_at),first_seen_at=MIN(session_refs.first_seen_at,excluded.first_seen_at),last_seen_at=MAX(session_refs.last_seen_at,excluded.last_seen_at)`)
      .run(sessionRefId, system, externalId, rootExternalId, sourceKind, cwd, json(workspaceRoots), durability, nativeStatus, at, firstSeenAt ?? at, lastSeenAt ?? at)
    return rowSession(this.db.prepare('SELECT * FROM session_refs WHERE session_ref_id=?').get(sessionRefId))
  }

  attachTaskSession(taskId, sessionRefId, { relation = 'inferred', confidence = 0.5, evidenceId = null } = {}) {
    this.db.prepare(`INSERT INTO task_sessions(task_id,session_ref_id,relation,confidence,attached_at,evidence_id) VALUES(?,?,?,?,?,?)
      ON CONFLICT(task_id,session_ref_id) DO UPDATE SET relation=excluded.relation,confidence=MAX(task_sessions.confidence,excluded.confidence),evidence_id=COALESCE(excluded.evidence_id,task_sessions.evidence_id)`)
      .run(taskId, sessionRefId, relation, confidence, nowIso(this.clock), evidenceId)
  }

  ingestSource({ sourceSystem, sourceKind, externalId = null, sourceUri, sourceLocator, sourceIdentity, occurredAt = null, text, normalizedPayload = {}, trustLevel = 'untrusted', authorRole = null, sessionRefId = null, taskId = null, executionId = null, sourceType = sourceKind, queueExtraction = true, memory = memoryClass(text) }) {
    if (executionId) {
      const execution = this.db.prepare('SELECT task_id FROM executions WHERE execution_id=?').get(executionId)
      if (!execution) throw new Error('Evidence execution does not exist')
      if (taskId && taskId !== execution.task_id) throw new Error('Evidence task does not match execution task')
      taskId ??= execution.task_id
    }
    const content = Buffer.from(String(text ?? ''), 'utf8')
    const contentHash = sha256(content)
    const sourceRecordId = stableId('source', sourceSystem, sourceKind, sourceUri, sourceLocator, sourceIdentity)
    const evidenceId = stableId('evidence', sourceRecordId, sourceType)
    const at = nowIso(this.clock)
    let inserted = false
    this.database.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO source_blobs(content_hash,byte_size,mime_type,content,created_at) VALUES(?,?,?,?,?)')
        .run(contentHash, content.length, 'text/plain; charset=utf-8', content, at)
      const source = this.db.prepare(`INSERT OR IGNORE INTO source_records(source_record_id,source_system,source_kind,external_id,source_uri,source_locator,source_identity,occurred_at,observed_at,content_hash,normalized_payload_json,trust_level)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(sourceRecordId, sourceSystem, sourceKind, externalId, sourceUri, sourceLocator, sourceIdentity, occurredAt, at, contentHash, json(normalizedPayload), trustLevel)
      inserted = !!source.changes
      this.db.prepare(`INSERT OR IGNORE INTO evidence(evidence_id,source_record_id,session_ref_id,task_id,execution_id,source_type,source_system,source_external_id,source_uri,source_offset_json,occurred_at,ingested_at,content_hash,mime_type,author_role,trust_level,memory_class)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(evidenceId, sourceRecordId, sessionRefId, taskId, executionId, sourceType, sourceSystem, externalId, sourceUri, json({ locator: sourceLocator, identity: sourceIdentity }), occurredAt, at, contentHash, 'text/plain; charset=utf-8', authorRole, trustLevel, memory)
      if (inserted && content.length) this.db.prepare('INSERT INTO evidence_fts(evidence_id,task_id,source_system,source_external_id,text) VALUES(?,?,?,?,?)')
        .run(evidenceId, taskId, sourceSystem, externalId, content.toString('utf8'))
      if (queueExtraction && inserted && memory !== 'temporary' && !String(sourceKind).startsWith('memory_')) this.db.prepare('INSERT OR IGNORE INTO memory_extraction_jobs(evidence_id,updated_at) VALUES(?,?)').run(evidenceId, at)
    })
    return { sourceRecordId, evidenceId, contentHash, inserted }
  }

  /** Stage imported conversation text until AI assigns every message. */
  stageHistorySource(source) { return this.history.stage(source) }

  search(query, { projectId = null, taskId = null, entityId = null, sourceSystem = null, from = null, to = null, limit = 20, includeTemporary = false } = {}) {
    const q = cleanText(query, 500)
    if (!q) throw new Error('Search query is required')
    const terms = searchTerms(q)
    if (!terms.length) throw new Error('Search query has no searchable terms')
    const count = Math.min(100, Math.max(1, Number.isSafeInteger(limit) ? limit : 20))
    const strict = this.searchWithTerms(terms, { projectId, taskId, entityId, sourceSystem, from, to, includeTemporary }, {
      count, mode: 'all-terms', minimumMatches: terms.length,
    })
    if (strict.length) return strict
    const topics = topicSearchTerms(q)
    const minimumMatches = topicMatchThreshold(topics)
    return minimumMatches
      ? this.searchWithTerms(topics, { projectId, taskId, entityId, sourceSystem, from, to, includeTemporary }, {
          count, mode: 'topic-fallback', minimumMatches,
        })
      : []
  }

  searchWithTerms(terms, { projectId, taskId, entityId, sourceSystem, from, to, includeTemporary }, { count, mode, minimumMatches }) {
    const allTerms = minimumMatches === terms.length
    const clauses = terms.some(term => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(term))
      ? [`(${terms.map(() => `evidence_fts.text LIKE ? ESCAPE '\\'`).join(allTerms ? ' AND ' : ' OR ')})`]
      : ['evidence_fts MATCH ?']
    const params = clauses[0].startsWith('(')
      ? terms.map(term => `%${term.replace(/[\\%_]/gu, '\\$&')}%`)
      : [terms.map(term => `"${term.replaceAll('"', '""')}"`).join(allTerms ? ' AND ' : ' OR ')]
    clauses.push("e.redaction_state='none'", "e.source_type NOT LIKE 'memory\\_%' ESCAPE '\\'")
    if (taskId) { clauses.push('e.task_id=?'); params.push(taskId) }
    if (projectId) { clauses.push('t.project_id=?'); params.push(projectId) }
    if (entityId) {
      clauses.push(`(EXISTS(SELECT 1 FROM memory_entity_sources mes WHERE mes.evidence_id=e.evidence_id AND mes.entity_id=?)
        OR EXISTS(SELECT 1 FROM memory_sources ms JOIN memory_records mr USING(memory_id) WHERE ms.evidence_id=e.evidence_id AND (mr.entity_id=? OR json_extract(mr.object_json,'$.entityId')=?))
        OR EXISTS(SELECT 1 FROM memory_edges link WHERE link.from_kind='experience' AND link.from_id=e.evidence_id AND link.to_kind='entity' AND link.to_id=?))`)
      params.push(entityId, entityId, entityId, entityId)
    }
    if (sourceSystem) { clauses.push('e.source_system=?'); params.push(sourceSystem) }
    if (from) { clauses.push('COALESCE(e.occurred_at,e.ingested_at)>=?'); params.push(from) }
    if (to) { clauses.push('COALESCE(e.occurred_at,e.ingested_at)<=?'); params.push(to) }
    if (!includeTemporary) {
      clauses.push("e.memory_class<>'temporary'")
      clauses.push("NOT EXISTS (SELECT 1 FROM session_refs recent JOIN import_cursors c ON c.importer_id='recent-history-eligibility' AND c.source_uri=recent.system || ':' || recent.external_id WHERE recent.session_ref_id=e.session_ref_id AND json_extract(c.cursor_json,'$.eligible')=0)")
    }
    const rowLimit = mode === 'topic-fallback' ? Math.max(count * 25, 250) : null
    const rows = this.db.prepare(`SELECT e.evidence_id,e.task_id,e.source_system,e.source_external_id,e.source_uri,e.source_offset_json,e.occurred_at,e.author_role,
      source_text(b.content,b.compressed,b.content_hash) AS content,bm25(evidence_fts) AS rank,t.objective,s.external_id AS session_id,s.cwd
      FROM evidence_fts JOIN evidence e ON e.evidence_id=evidence_fts.evidence_id JOIN source_blobs b USING(content_hash) LEFT JOIN tasks t ON t.task_id=e.task_id LEFT JOIN session_refs s ON s.session_ref_id=e.session_ref_id
      WHERE ${clauses.join(' AND ')} ORDER BY rank,e.evidence_id${rowLimit ? ' LIMIT ?' : ''}`).iterate(...(rowLimit ? [...params, rowLimit] : params))
    const results = []
    for (const row of rows) {
      const fragments = memoryFragments(row.content)
        .filter(fragment => includeTemporary || fragment.memory !== 'temporary')
        .map(fragment => ({ ...fragment, matchedTerms: matchedSearchTerms(fragment.text, terms) }))
        .filter(fragment => fragment.matchedTerms.length >= minimumMatches)
        .sort((a, b) => b.matchedTerms.length - a.matchedTerms.length)
      if (!fragments.length) continue
      const offset = parseJson(row.source_offset_json, {})
      const excerpt = fragments.map(fragment => fragment.text).join(' ... ')
      const firstMatch = Math.min(...fragments[0].matchedTerms.map(term => excerpt.normalize('NFKC').toLocaleLowerCase().indexOf(term.toLocaleLowerCase())).filter(index => index >= 0))
      const start = excerpt.length > 360 ? Math.max(0, Math.min(Number.isFinite(firstMatch) ? firstMatch - 80 : 0, excerpt.length - 354)) : 0
      results.push({
        evidenceId: row.evidence_id,
        taskId: row.task_id,
        taskObjective: row.objective,
        session: row.session_id ? { system: row.source_system, externalId: row.session_id, cwd: row.cwd } : null,
        snippet: `${start ? '...' : ''}${excerpt.slice(start, start + 354)}${start + 354 < excerpt.length ? '...' : ''}`,
        truncated: start > 0 || start + 354 < excerpt.length,
        occurredAt: row.occurred_at,
        authorRole: row.author_role,
        ...(mode === 'topic-fallback' ? { matchMode: mode, matchedTerms: fragments[0].matchedTerms, minimumTermMatches: minimumMatches } : {}),
        rank: Number(row.rank),
        citation: {
          system: row.source_system,
          externalId: row.source_external_id,
          uri: row.source_uri,
          locator: offset.locator,
          label: `${row.source_system}:${row.source_external_id ?? 'unknown'}@${offset.locator ?? 'record'}`,
        },
      })
      if (mode !== 'topic-fallback' && results.length >= count) break
    }
    if (mode === 'topic-fallback') results.sort((a, b) => b.matchedTerms.length - a.matchedTerms.length || a.rank - b.rank || a.evidenceId.localeCompare(b.evidenceId))
    return results.slice(0, count).map(({ rank: _rank, ...result }) => result)
  }

  timeline(taskId, { limit = 100 } = {}) {
    return this.db.prepare(`SELECT 'evidence' AS kind,e.evidence_id AS id,e.occurred_at AS at,e.source_type AS type,e.source_uri AS source,e.source_offset_json AS detail
      FROM evidence e WHERE e.task_id=? UNION ALL
      SELECT 'event',event_id,occurred_at,event_type,NULL,payload_json FROM events WHERE aggregate_type='task' AND aggregate_id=?
      ORDER BY at DESC LIMIT ?`).all(taskId, taskId, Math.min(500, limit)).map(row => ({ ...row, detail: parseJson(row.detail, {}) }))
  }

  /** Read current criterion identifiers, bound result evidence and verification for the latest substantive attempt. */
  acceptanceStatus(taskId, stepId = null) {
    const latest = this.db.prepare(`SELECT e.execution_id,e.execution_state FROM executions e
      WHERE e.task_id=? AND e.step_id IS ? AND (e.executor_kind<>'codex' OR EXISTS
      (SELECT 1 FROM outbox o WHERE o.execution_id=e.execution_id AND o.method='turn/start'))
      ORDER BY e.attempt_no DESC LIMIT 1`).get(taskId, stepId)
    const rows = latest ? this.db.prepare(`SELECT * FROM acceptance_results WHERE execution_id=? ORDER BY sequence`).all(latest.execution_id) : []
    const effective = new Map()
    for (const row of rows) effective.set(row.criterion_id, { ...row, evidenceIds: parseJson(row.evidence_ids_json, []) })
    const scope = stepId === null
      ? this.db.prepare('SELECT acceptance_json FROM tasks WHERE task_id=?').get(taskId)
      : this.db.prepare('SELECT acceptance_json FROM task_steps WHERE task_id=? AND step_id=?').get(taskId, stepId)
    const evidenceIds = latest ? this.db.prepare(`SELECT evidence_id FROM evidence WHERE task_id=? AND execution_id=? AND redaction_state='none'
      AND source_type IN ('worker_terminal','subagent_result','internal_result') ORDER BY ingested_at DESC,evidence_id LIMIT 32`)
      .all(taskId, latest.execution_id).map(row => row.evidence_id) : []
    return { executionId: latest?.execution_id ?? null, executionState: latest?.execution_state ?? null,
      criteria: criteriaOf(parseJson(scope?.acceptance_json, [])), evidenceIds, results: [...effective.values()] }
  }

  assertAccepted(taskId, stepId, definitions) {
    if (this.db.prepare("SELECT 1 FROM leases l JOIN executions e USING(execution_id) WHERE e.task_id=? AND l.lease_state IN ('active','recovery_hold','expired')").get(taskId)) throw new Error('Task completion requires reconciliation of its workspace writers')
    const criteria = criteriaOf(definitions)
    const status = this.acceptanceStatus(taskId, stepId)
    if (!criteria.length || status.executionState !== 'succeeded' || criteria.some(criterion => {
      const result = status.results.find(item => item.criterion_id === criterion.id)
      return !result || result.state !== 'passed' || !result.evidenceIds.length || result.evidenceIds.some(id => !this.db.prepare('SELECT 1 FROM evidence WHERE evidence_id=? AND task_id=? AND execution_id=?').get(id, taskId, status.executionId))
    })) throw Object.assign(new Error('Task completion requires acceptance evidence for every current criterion'), { code: 'TASK_ACCEPTANCE_REQUIRED' })
  }

  /** Append an auditable result; requirements are stored separately and never truncated. */
  recordAcceptance(executionId, { state, summary = '', evidenceIds = [], criterionId = null } = {}) {
    if (!['passed', 'failed', 'pending'].includes(state)) throw new TypeError('Acceptance state must be passed, failed, or pending')
    const execution = this.db.prepare('SELECT task_id,step_id,execution_state FROM executions WHERE execution_id=?').get(executionId)
    if (!execution) throw new Error('Execution does not exist')
    if (!['succeeded', 'failed', 'cancelled', 'interrupted'].includes(execution.execution_state)) throw new Error('Acceptance requires a terminal execution')
    if (state === 'passed' && this.db.prepare("SELECT 1 FROM leases WHERE execution_id=? AND lease_state IN ('active','recovery_hold','expired')").get(executionId)) throw new Error('Acceptance requires a reconciled workspace writer')
    if (state === 'passed' && execution.execution_state !== 'succeeded') throw new Error('Passed acceptance requires a succeeded execution')
    const ids = [...new Set(Array.isArray(evidenceIds) ? evidenceIds : [])]
    if (ids.length > 32) throw new Error('Too many acceptance evidence references')
    if (state === 'passed' && !ids.length) throw Object.assign(new Error('Passed acceptance requires evidence'), { code: 'ACCEPTANCE_EVIDENCE_REQUIRED' })
    for (const id of ids) {
      const evidence = this.db.prepare('SELECT task_id,execution_id FROM evidence WHERE evidence_id=?').get(id)
      if (!evidence) throw new Error(`Acceptance evidence does not exist: ${id}`)
      if (evidence.task_id !== execution.task_id) throw new Error(`Acceptance evidence belongs to another task: ${id}`)
      if (evidence.execution_id !== executionId) throw new Error(`Acceptance evidence belongs to another execution: ${id}`)
    }
    const scope = execution.step_id
      ? this.db.prepare('SELECT acceptance_json FROM task_steps WHERE step_id=?').get(execution.step_id)
      : this.db.prepare('SELECT acceptance_json FROM tasks WHERE task_id=?').get(execution.task_id)
    const criteria = criteriaOf(parseJson(scope.acceptance_json, []))
    if (state !== 'pending' && !criteria.length) throw new Error('Acceptance criteria must be defined')
    if (criterionId === null && criteria.length > 1 && state !== 'pending') throw new TypeError('Acceptance criterionId is required when a task has multiple criteria')
    const selected = criterionId === null ? (criteria.length === 1 ? criteria[0].id : null) : String(criterionId)
    if (selected !== null && !criteria.some(item => item.id === selected)) throw new Error(`Acceptance criterion does not exist: ${selected}`)
    const item = { kind: 'result', executionId, criterionId: selected, state, summary: String(summary).slice(0, 2000), evidenceIds: ids, recordedAt: nowIso(this.clock) }
    return this.database.transaction(() => {
      for (const criterion of criteria.filter(c => selected === null || c.id === selected)) this.db.prepare(`INSERT INTO acceptance_results(task_id,step_id,execution_id,criterion_id,state,summary,evidence_ids_json,recorded_at) VALUES(?,?,?,?,?,?,?,?)`)
        .run(execution.task_id, execution.step_id, executionId, criterion.id, state, item.summary, JSON.stringify(ids), item.recordedAt)
      this.db.prepare('UPDATE tasks SET updated_at=? WHERE task_id=?').run(item.recordedAt, execution.task_id)
      this.appendEvent('execution', executionId, 'execution.acceptance_recorded', item)
      return item
    })
  }

  listTaskSteps(taskId) {
    return this.db.prepare('SELECT * FROM task_steps WHERE task_id=? ORDER BY ordinal').all(taskId).map(row => ({ stepId: row.step_id, taskId: row.task_id, objective: row.objective, state: row.step_state, dependencies: parseJson(row.dependencies_json, []), acceptance: parseJson(row.acceptance_json, []), verification: this.acceptanceStatus(taskId, row.step_id) }))
  }

  assertStepReady(taskId, stepId) {
    const step = this.listTaskSteps(taskId).find(item => item.stepId === stepId)
    if (!step || ['completed','cancelled'].includes(step.state)) throw new Error('Task step is unavailable')
    for (const dependency of step.dependencies) if (!this.db.prepare("SELECT 1 FROM task_steps WHERE step_id=? AND task_id=? AND step_state='completed'").get(dependency, taskId)) throw new Error('Task step dependencies are not completed')
    return step
  }

  transitionTaskStep(taskId, stepId, state) {
    const step = this.listTaskSteps(taskId).find(item => item.stepId === stepId)
    if (!step) throw new Error('Task step does not exist')
    if (state === 'active') this.assertStepReady(taskId, stepId)
    if (state === 'completed') this.assertAccepted(taskId, stepId, step.acceptance)
    assertTransition('task', step.state, state)
    this.db.prepare('UPDATE task_steps SET step_state=?,updated_at=? WHERE step_id=?').run(state, nowIso(this.clock), stepId)
    return this.listTaskSteps(taskId).find(item => item.stepId === stepId)
  }

  /** Add a dependency-bearing step only when the caller needs explicit planning. */
  createTaskStep(taskId, { objective, dependencies = [], acceptance = ['Verify this step against its objective'] } = {}) {
    if (!this.db.prepare('SELECT 1 FROM tasks WHERE task_id=?').get(taskId)) throw new Error('Task does not exist')
    const text = cleanText(objective, 4_000)
    if (!text) throw new Error('Task step objective is required')
    requireCriteria(acceptance)
    const dependencyIds = [...new Set(Array.isArray(dependencies) ? dependencies : [])]
    for (const stepId of dependencyIds) if (!this.db.prepare('SELECT 1 FROM task_steps WHERE step_id=? AND task_id=?').get(stepId, taskId)) throw new Error(`Task step dependency does not exist: ${stepId}`)
    const ordinal = Number(this.db.prepare('SELECT COALESCE(MAX(ordinal),-1)+1 AS value FROM task_steps WHERE task_id=?').get(taskId).value)
    const stepId = newId('step')
    const at = nowIso(this.clock)
    this.db.prepare(`INSERT INTO task_steps(step_id,task_id,objective,step_state,dependencies_json,acceptance_json,ordinal,created_at,updated_at)
      VALUES(?,?,?,'open',?,?,?,?,?)`).run(stepId, taskId, text, JSON.stringify(dependencyIds), JSON.stringify(Array.isArray(acceptance) ? acceptance : []), ordinal, at, at)
    return { stepId, taskId, objective: text, state: 'open', dependencies: dependencyIds, acceptance: Array.isArray(acceptance) ? acceptance : [], ordinal }
  }

  /** Retain route correction feedback beside the immutable decision. */
  recordRouteFeedback(routeDecisionId, { outcome, correction = {} } = {}) {
    if (!['accepted', 'corrected', 'rejected'].includes(outcome)) throw new TypeError('Route feedback outcome is invalid')
    if (!this.db.prepare('SELECT 1 FROM route_decisions WHERE route_decision_id=?').get(routeDecisionId)) throw new Error('Route decision does not exist')
    const feedbackId = newId('route-feedback')
    const at = nowIso(this.clock)
    this.db.prepare('INSERT INTO route_feedback(feedback_id,route_decision_id,outcome,correction_json,recorded_at) VALUES(?,?,?,?,?)')
      .run(feedbackId, routeDecisionId, outcome, JSON.stringify(correction), at)
    return { feedbackId, routeDecisionId, outcome, correction, recordedAt: at }
  }

  recordTrigger({ kind = 'direct_request', sourceSessionRefId = null, sourceMessageId = null, content = '', rawEvidenceId = null, dedupeKey = newId('trigger') } = {}) {
    const triggerId = stableId('trigger', dedupeKey)
    const contentHash = content ? sha256(String(content)) : null
    const existing = this.db.prepare('SELECT trigger_id,content_hash FROM triggers WHERE dedupe_key=?').get(dedupeKey)
    if (existing && existing.content_hash !== contentHash) throw new Error('Request id is already bound to a different payload or authority scope')
    this.db.prepare(`INSERT OR IGNORE INTO triggers(trigger_id,kind,source_session_ref_id,source_message_id,received_at,content_hash,raw_evidence_id,dedupe_key)
      VALUES(?,?,?,?,?,?,?,?)`).run(triggerId, kind, sourceSessionRefId, sourceMessageId, nowIso(this.clock), contentHash, rawEvidenceId, dedupeKey)
    return this.db.prepare('SELECT trigger_id AS triggerId FROM triggers WHERE dedupe_key=?').get(dedupeKey).triggerId
  }

  saveRouteDecision(decision, { triggerId = null, taskId = null, targetSessionRefId = null, decider = 'deterministic-router' } = {}) {
    const id = newId('route')
    this.db.prepare(`INSERT INTO route_decisions(route_decision_id,trigger_id,task_id,semantic_action,delivery_action,candidate_snapshot_json,authorized_target_session_ref_id,reason_codes_json,input_snapshot_hash,decided_at,decider,explanation)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(trigger_id) WHERE trigger_id IS NOT NULL DO UPDATE SET task_id=excluded.task_id,semantic_action=excluded.semantic_action,delivery_action=excluded.delivery_action,candidate_snapshot_json=excluded.candidate_snapshot_json,authorized_target_session_ref_id=excluded.authorized_target_session_ref_id,reason_codes_json=excluded.reason_codes_json,input_snapshot_hash=excluded.input_snapshot_hash,decided_at=excluded.decided_at,explanation=excluded.explanation WHERE NOT EXISTS(SELECT 1 FROM executions WHERE route_decision_id=route_decisions.route_decision_id)`).run(id, triggerId, taskId, decision.semanticAction, decision.deliveryAction, json(decision.snapshot), targetSessionRefId, json(decision.reasonCodes), decision.inputSnapshotHash, nowIso(this.clock), decider, decision.explanation)
    return triggerId ? this.db.prepare('SELECT route_decision_id FROM route_decisions WHERE trigger_id=?').get(triggerId).route_decision_id : id
  }

  saveBaseline(locationId, baseline) {
    const baselineId = newId('baseline')
    this.db.prepare(`INSERT INTO workspace_baselines(baseline_id,workspace_location_id,captured_at,git_head,git_index_tree,status_porcelain,dirty_paths_json,path_hashes_json,capture_complete,evidence_id)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(baselineId, locationId, baseline.capturedAt, baseline.gitHead, baseline.gitIndexTree, baseline.statusPorcelain, json(baseline.dirtyPaths), json(baseline.pathHashes), baseline.captureComplete ? 1 : 0, baseline.evidenceId ?? null)
    return baselineId
  }

  acquireLease({ resourceKey, locationId, mode = 'write', ttlMs = 120_000, ownerInstanceId = this.instanceId }) {
    const atMs = this.clock()
    const at = new Date(atMs).toISOString()
    const expiresAt = new Date(atMs + ttlMs).toISOString()
    const outcome = this.database.transaction(() => {
      if (mode === 'write') {
        this.db.prepare(`UPDATE leases SET lease_state='recovery_hold',heartbeat_at=?,release_reason='expired_owner_requires_reconciliation'
          WHERE mode='write' AND lease_state='active' AND expires_at<=?`).run(at, at)
        const requestedPath = resourceKey.startsWith('workspace:') ? resourceKey.slice(10) : null
        const blocking = this.db.prepare(`SELECT lease_id,lease_state,execution_id,resource_key FROM leases WHERE mode='write' AND lease_state IN ('requested','active','recovery_hold','expired')`).all().find(lease => {
          if (lease.resource_key === resourceKey) return true
          if (!requestedPath || !lease.resource_key.startsWith('workspace:')) return false
          const held = lease.resource_key.slice(10)
          const nested = (a, b) => { const rel = path.relative(a, b); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)) }
          return nested(held, requestedPath) || nested(requestedPath, held)
        })
        if (blocking) return { blocking }
      }
      const token = Number(this.db.prepare('SELECT COALESCE(MAX(fencing_token),0)+1 AS token FROM leases WHERE resource_key=?').get(resourceKey).token)
      const leaseId = newId('lease')
      this.db.prepare(`INSERT INTO leases(lease_id,resource_key,workspace_location_id,owner_instance_id,mode,lease_state,fencing_token,acquired_at,heartbeat_at,expires_at)
        VALUES(?,?,?,?,?,'active',?,?,?,?)`).run(leaseId, resourceKey, locationId, ownerInstanceId, mode, token, at, at, expiresAt)
      return { leaseId, fencingToken: token, state: 'active', expiresAt }
    })
    if (outcome.blocking) throw Object.assign(new Error(`Workspace write lease is blocked by ${outcome.blocking.lease_state}`), { code: 'LEASE_CONFLICT', blocking: outcome.blocking })
    return outcome
  }

  holdLease(leaseId, reason = 'external_execution_unknown') {
    const result = this.db.prepare(`UPDATE leases SET lease_state='recovery_hold',release_reason=?,heartbeat_at=? WHERE lease_id=? AND mode='write' AND lease_state IN ('active','expired')`)
      .run(reason, nowIso(this.clock), leaseId)
    if (!result.changes) throw new Error('Lease cannot enter recovery hold')
  }

  releaseLease(leaseId, proof) {
    const allowed = new Set(['terminal', 'quiescent', 'process_dead', 'isolated_worktree'])
    if (!allowed.has(proof)) throw new Error('Write lease release requires terminal/quiescent/process_dead/isolated_worktree proof')
    const result = this.db.prepare(`UPDATE leases SET lease_state='released',released_at=?,release_reason=? WHERE lease_id=? AND lease_state IN ('active','recovery_hold')`)
      .run(nowIso(this.clock), proof, leaseId)
    if (!result.changes) throw new Error('Lease is not releasable')
  }

  planExecution({ taskId, stepId = null, executorKind, routeDecisionId = null, locationId = null, baselineId = null, leaseId = null, requestedCapabilities = [], workerPolicy = {}, method, params, mutatesWorkspace = false, dispatch = true, idempotencyKey = newId('intent') }) {
    return this.database.transaction(() => {
      if (stepId) this.assertStepReady(taskId, stepId)
      const task = this.getTask(taskId)
      if (!task || ['completed','cancelled','merged'].includes(task.state)) throw new Error('Task is not executable')
      if (mutatesWorkspace) {
        if (!locationId || !baselineId || !leaseId) throw new Error('Mutating execution requires location, baseline, and lease')
        const lease = this.db.prepare(`SELECT * FROM leases WHERE lease_id=? AND workspace_location_id=? AND mode='write' AND lease_state='active' AND expires_at>?`).get(leaseId, locationId, nowIso(this.clock))
        if (!lease) throw new Error('Active write lease is required')
        const baseline = this.db.prepare('SELECT baseline_id FROM workspace_baselines WHERE baseline_id=? AND workspace_location_id=?').get(baselineId, locationId)
        if (!baseline) throw new Error('Persisted workspace baseline is required')
      }
      const attempt = Number(this.db.prepare('SELECT COALESCE(MAX(attempt_no),0)+1 AS attempt FROM executions WHERE task_id=?').get(taskId).attempt)
      const executionId = newId('execution')
      const outboxId = newId('outbox')
      const at = nowIso(this.clock)
      this.db.prepare(`INSERT INTO executions(execution_id,task_id,attempt_no,executor_kind,execution_state,idempotency_key,route_decision_id,workspace_location_id,workspace_baseline_id,requested_capabilities_json,worker_policy_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(executionId, taskId, attempt, executorKind, dispatch ? 'dispatch_pending' : 'planned', idempotencyKey, routeDecisionId, locationId, baselineId, json(requestedCapabilities), json(workerPolicy))
      this.db.prepare('UPDATE executions SET step_id=? WHERE execution_id=?').run(stepId, executionId)
      if (stepId) this.db.prepare("UPDATE task_steps SET step_state='active',updated_at=? WHERE step_id=?").run(at, stepId)
      if (leaseId) this.db.prepare('UPDATE leases SET execution_id=? WHERE lease_id=?').run(executionId, leaseId)
      if (dispatch) this.db.prepare(`INSERT INTO outbox(outbox_id,execution_id,method,params_json,params_hash,intent_key,outbox_state,available_at) VALUES(?,?,?,?,?,?,'pending',?)`)
        .run(outboxId, executionId, method, json(params), sha256(json(params)), idempotencyKey, at)
      this.appendEvent('task', taskId, 'execution.planned', { executionId, outboxId: dispatch ? outboxId : null, mutatesWorkspace, executorKind, workerPolicy }, idempotencyKey)
      return { executionId, outboxId: dispatch ? outboxId : null, attemptNo: attempt, idempotencyKey }
    })
  }

  attachExecutionSession(executionId, sessionRefId, { role = 'executor', confidence = 1, evidenceId = null } = {}) {
    this.db.prepare(`INSERT INTO execution_sessions(execution_id,session_ref_id,role,attached_at,confidence,evidence_id) VALUES(?,?,?,?,?,?)
      ON CONFLICT(execution_id,session_ref_id,role) DO UPDATE SET detached_at=NULL,confidence=MAX(execution_sessions.confidence,excluded.confidence),evidence_id=COALESCE(excluded.evidence_id,execution_sessions.evidence_id)`)
      .run(executionId, sessionRefId, role, nowIso(this.clock), confidence, evidenceId)
  }

  heartbeatExecution(executionId, ttlMs = 120_000) {
    const atMs = this.clock()
    const at = new Date(atMs).toISOString()
    const expiresAt = new Date(atMs + ttlMs).toISOString()
    return this.database.transaction(() => {
      const execution = this.db.prepare(`UPDATE executions SET heartbeat_at=? WHERE execution_id=? AND execution_state IN ('dispatch_pending','dispatch_unknown','running','waiting_approval','waiting_user','reconciling')`).run(at, executionId)
      this.db.prepare(`UPDATE leases SET heartbeat_at=?,expires_at=? WHERE execution_id=? AND lease_state='active'`).run(at, expiresAt, executionId)
      return !!execution.changes
    })
  }

  transitionExecution(executionId, nextState, { expectedState = null, resultClass = null, failureCode = null, failureDetail = null, startedAt = undefined, finishedAt = undefined } = {}) {
    return this.database.transaction(() => {
      const current = this.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(executionId)
      if (!current) throw new Error('Execution does not exist')
      if (expectedState !== null && current.execution_state !== expectedState) throw new Error('Execution state changed')
      assertTransition('execution', current.execution_state, nextState)
      const at = nowIso(this.clock)
      const terminal = ['succeeded','failed','cancelled','interrupted'].includes(nextState)
      const result = this.db.prepare(`UPDATE executions SET execution_state=?,started_at=COALESCE(started_at,?),finished_at=?,result_class=COALESCE(?,result_class),failure_code=COALESCE(?,failure_code),failure_detail=COALESCE(?,failure_detail) WHERE execution_id=? AND execution_state=?`)
        .run(nextState, startedAt === undefined && nextState === 'running' ? at : startedAt ?? null, finishedAt === undefined && terminal ? at : finishedAt ?? null, resultClass, failureCode, failureDetail, executionId, current.execution_state)
      if (!result.changes) throw new Error('Execution changed concurrently')
      this.appendEvent('execution', executionId, `execution.${nextState}`, { resultClass, failureCode })
      return this.db.prepare('SELECT * FROM executions WHERE execution_id=?').get(executionId)
    })
  }

  claimOutbox(limit = 10) {
    const at = nowIso(this.clock)
    return this.database.transaction(() => {
      const rows = this.db.prepare(`SELECT * FROM outbox WHERE outbox_state='pending' AND available_at<=? ORDER BY available_at LIMIT ?`).all(at, limit)
      const update = this.db.prepare(`UPDATE outbox SET outbox_state='sending',attempt_count=attempt_count+1,sent_at=? WHERE outbox_id=? AND outbox_state='pending'`)
      return rows.filter(row => update.run(at, row.outbox_id).changes).map(row => ({ ...row, params: parseJson(row.params_json, {}) }))
    })
  }

  claimOutboxById(outboxId) {
    const at = nowIso(this.clock)
    return this.database.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM outbox WHERE outbox_id=? AND outbox_state='pending' AND available_at<=?`).get(outboxId, at)
      if (!row) return []
      const changed = this.db.prepare(`UPDATE outbox SET outbox_state='sending',attempt_count=attempt_count+1,sent_at=? WHERE outbox_id=? AND outbox_state='pending'`).run(at, outboxId)
      return changed.changes ? [{ ...row, params: parseJson(row.params_json, {}) }] : []
    })
  }

  resolveOutbox(outboxId, state, { result = null, error = null } = {}) {
    if (!['acknowledged','uncertain','failed','cancelled'].includes(state)) throw new Error('Invalid outbox result state')
    const at = state === 'acknowledged' ? nowIso(this.clock) : null
    const changed = this.db.prepare(`UPDATE outbox SET outbox_state=?,acknowledged_at=?,external_result_json=?,last_error=? WHERE outbox_id=? AND outbox_state='sending'`)
      .run(state, at, result === null ? null : json(result), error, outboxId)
    if (!changed.changes) throw new Error('Outbox item is not sending')
    const execution = this.db.prepare('SELECT e.execution_id,e.execution_state FROM executions e JOIN outbox o ON o.execution_id=e.execution_id WHERE o.outbox_id=?').get(outboxId)
    if (state === 'uncertain' && execution?.execution_state === 'dispatch_pending') this.transitionExecution(execution.execution_id, 'dispatch_unknown')
    if (state === 'acknowledged' && execution?.execution_state === 'dispatch_pending') this.transitionExecution(execution.execution_id, 'running')
    if (state === 'failed' && execution?.execution_state === 'dispatch_pending') this.transitionExecution(execution.execution_id, 'failed', { failureCode: 'dispatch_failed', failureDetail: error })
  }

  recordInbox({ adapterInstanceId, connectionEpoch, externalEventId = null, method, payload, dedupeKey }) {
    const inboxId = newId('inbox')
    const result = this.db.prepare(`INSERT OR IGNORE INTO inbox(inbox_id,adapter_instance_id,connection_epoch,external_event_id,dedupe_key,method,payload_json,received_at) VALUES(?,?,?,?,?,?,?,?)`)
      .run(inboxId, adapterInstanceId, connectionEpoch, externalEventId === null ? null : encodeRpcId(externalEventId), dedupeKey, method, json(payload), nowIso(this.clock))
    const row = result.changes
      ? { inbox_id: inboxId, processed_at: null, process_error: null }
      : this.db.prepare('SELECT inbox_id,processed_at,process_error FROM inbox WHERE dedupe_key=?').get(dedupeKey)
    return { inboxId: row.inbox_id, inserted: !!result.changes, pending: row.processed_at === null, processError: row.process_error }
  }

  completeInbox(inboxId, processError = null) {
    const result = this.db.prepare('UPDATE inbox SET processed_at=?,process_error=? WHERE inbox_id=? AND processed_at IS NULL').run(nowIso(this.clock), processError, inboxId)
    return !!result.changes
  }

  failInbox(inboxId, error) {
    const result = this.db.prepare('UPDATE inbox SET process_error=? WHERE inbox_id=? AND processed_at IS NULL').run(cleanText(error, 2_000), inboxId)
    return !!result.changes
  }

  pendingInbox({ methods = [], limit = 100, maxAttempts = null, adapterInstanceId = null, connectionEpoch = null } = {}) {
    const filters = ['processed_at IS NULL']
    const values = []
    if (methods.length) { filters.push(`method IN (${methods.map(() => '?').join(',')})`); values.push(...methods) }
    if (maxAttempts !== null) { filters.push('retry_attempts<?'); values.push(maxAttempts) }
    if (adapterInstanceId !== null) { filters.push('adapter_instance_id=? AND connection_epoch=?'); values.push(adapterInstanceId, connectionEpoch) }
    return this.db.prepare(`SELECT * FROM inbox WHERE ${filters.join(' AND ')} ORDER BY retry_attempts,received_at,inbox_id LIMIT ?`).all(...values, limit)
  }

  appendEvent(aggregateType, aggregateId, eventType, payload = {}, correlationId = null, causationId = null) {
    const eventId = newId('event')
    this.db.prepare('INSERT INTO events(event_id,aggregate_type,aggregate_id,event_type,payload_json,occurred_at,correlation_id,causation_id) VALUES(?,?,?,?,?,?,?,?)')
      .run(eventId, aggregateType, aggregateId, eventType, json(payload), nowIso(this.clock), correlationId, causationId)
    return eventId
  }
}
