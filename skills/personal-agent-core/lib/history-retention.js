/** Execution-activity cache and transactional cleanup of imported history. */
import { open } from 'node:fs/promises'
import { nowIso, parseJson } from './ids.js'

const DAY_MS = 24 * 60 * 60 * 1000

/** Resolve one rolling window for an entire synchronization. */
export function historyWindow(config, clock = Date.now) {
  const now = clock()
  return { now, cutoff: now - config.historyRetentionDays * DAY_MS }
}

/** Parse a durable execution timestamp without substituting observation time. */
export function activityTime(value) {
  const ms = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? ms : null
}

/** Small scan metadata remains after the imported transcript expires. */
export class ActivityCache {
  constructor(ledger, system) { this.db = ledger.db; this.importerId = `history-activity/${system}` }

  get(uri) {
    return parseJson(this.db.prepare('SELECT cursor_json FROM import_cursors WHERE importer_id=? AND source_uri=?').get(this.importerId, uri)?.cursor_json, {})
  }

  save(uri, value) {
    const at = nowIso()
    this.db.prepare(`INSERT INTO import_cursors(importer_id,source_uri,source_instance_id,cursor_json,last_attempted_at,last_successful_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(importer_id,source_uri) DO UPDATE SET cursor_json=excluded.cursor_json,last_attempted_at=excluded.last_attempted_at,last_successful_at=excluded.last_successful_at`)
      .run(this.importerId, uri, uri, JSON.stringify(value), at, at)
  }
}

/** Read complete bounded JSONL records up to the observed file size; leave a torn tail retryable. */
export async function *historyLines(file, info, config, checkpoint, offset = 0) {
  const handle = await open(file, 'r')
  let pending = Buffer.alloc(0)
  let position = offset
  let committed = offset
  try {
    while (position < info.size) {
      await checkpoint()
      const buffer = Buffer.alloc(Math.min(config.historyReadBytes, info.size - position))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (!bytesRead) throw new Error('History file changed while reading; retry synchronization')
      position += bytesRead
      pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)])
      let start = 0
      for (let end = pending.indexOf(10); end >= 0; end = pending.indexOf(10, start)) {
        await checkpoint()
        const length = end - start
        if (length > config.maxHistoryRecordBytes) throw new Error('History record exceeds maxHistoryRecordBytes')
        committed += length + 1
        yield { line: pending.subarray(start, end).toString('utf8'), offset: committed }
        start = end + 1
      }
      pending = pending.subarray(start)
      if (pending.length > config.maxHistoryRecordBytes) throw new Error('History record exceeds maxHistoryRecordBytes')
    }
    if (pending.length) yield { line: pending.toString('utf8'), offset: position }
  } finally { await handle.close() }
}

/** Persist default-recall eligibility independently of protected audit sources. */
export function saveHistoryEligibility(ledger, system, keep, unknown) {
  const at = nowIso()
  const save = ledger.db.prepare(`INSERT INTO import_cursors(importer_id,source_uri,source_instance_id,cursor_json,last_attempted_at,last_successful_at)
    VALUES('recent-history-eligibility',?,?,?,?,?) ON CONFLICT(importer_id,source_uri) DO UPDATE SET cursor_json=excluded.cursor_json,last_attempted_at=excluded.last_attempted_at,last_successful_at=excluded.last_successful_at`)
  ledger.database.transaction(() => {
    for (const row of ledger.db.prepare('SELECT external_id FROM session_refs WHERE system=?').all(system)) {
      if (unknown.has(row.external_id)) continue
      const uri = `${system}:${row.external_id}`
      save.run(uri, uri, JSON.stringify({eligible: keep.has(row.external_id)}), at, at)
    }
  })
}

const quoted = name => `"${name.replaceAll('"', '""')}"`

function references(db, target) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '%_fts%'").all().flatMap(({ name }) =>
    db.prepare(`PRAGMA foreign_key_list(${quoted(name)})`).all().filter(fk => fk.table === target).map(fk => ({ table: name, column: fk.from })))
}

function hasReferences(db, refs, id) {
  return refs.some(({ table, column }) => db.prepare(`SELECT 1 FROM ${quoted(table)} WHERE ${quoted(column)}=? LIMIT 1`).get(id))
}

/**
 * Remove only imported transcripts and their unused mirror rows. Operational FK references
 * retain the minimum audit evidence; native tasks, sessions, approvals and recovery records survive.
 * Each Session commits atomically, and cancellation leaves remaining Sessions for the next sync.
 */
export async function pruneInactiveHistory(ledger, { system, keep, unknown = new Set(), cutoff, checkpoint }) {
  const db = ledger.db
  const kinds = system === 'codex' ? ['session_index', 'rollout_item'] : ['message']
  const prefix = system === 'codex' ? 'codex-thread:' : 'dsh:'
  const evidenceRefs = references(db, 'evidence')
  const taskRefs = references(db, 'tasks')
  const sessionRefs = references(db, 'session_refs')
  const ftsRows = new Map(db.prepare('SELECT rowid,evidence_id FROM evidence_fts').all().map(row => [row.evidence_id, row.rowid]))
  db.exec('CREATE TEMP TABLE IF NOT EXISTS history_prune_evidence(id TEXT PRIMARY KEY); CREATE TEMP TABLE IF NOT EXISTS history_prune_sources(id TEXT PRIMARY KEY); CREATE TEMP TABLE IF NOT EXISTS history_prune_blobs(id TEXT PRIMARY KEY);')
  const summary = { sessions: 0, evidence: 0, tasks: 0, retainedAuditEvidence: 0 }
  const sessions = db.prepare('SELECT * FROM session_refs WHERE system=?').all(system)
  for (const session of sessions) {
    await checkpoint()
    if (keep.has(session.external_id) || unknown.has(session.external_id)) continue
    const task = ledger.getTaskBySource(`${prefix}${session.external_id}`)
    const uri = `dsh://session/${session.external_id}`
    const records = db.prepare(`SELECT source_record_id,source_uri,source_kind FROM source_records WHERE source_system=? AND source_kind IN (${kinds.map(() => '?').join(',')}) AND ${system === 'codex' ? 'external_id=?' : 'source_uri=?'}`)
      .all(system, ...kinds, system === 'codex' ? session.external_id : uri)
    if (!task && !records.length) continue
    ledger.database.transaction(() => {
      db.exec('DELETE FROM history_prune_evidence; DELETE FROM history_prune_sources; DELETE FROM history_prune_blobs;')
      for (const record of records) db.prepare('INSERT OR IGNORE INTO history_prune_sources VALUES(?)').run(record.source_record_id)
      db.exec('INSERT INTO history_prune_evidence SELECT evidence_id FROM evidence WHERE source_record_id IN (SELECT id FROM history_prune_sources)')
      const candidates = db.prepare('SELECT COUNT(*) AS n FROM history_prune_evidence').get().n
      db.exec(`DELETE FROM memory_extraction_jobs WHERE evidence_id IN (SELECT id FROM history_prune_evidence)
        AND evidence_id NOT IN (SELECT evidence_id FROM memory_sources UNION SELECT evidence_id FROM memory_entity_sources)`)
      db.exec("DELETE FROM history_prune_evidence WHERE id IN (SELECT j.value FROM acceptance_results a,json_each(a.evidence_ids_json) j)")
      for (const { table, column } of evidenceRefs) {
        if (table === 'evidence') continue
        db.exec(`DELETE FROM history_prune_evidence WHERE id IN (SELECT ${quoted(column)} FROM ${quoted(table)} WHERE ${quoted(column)} IS NOT NULL)`)
      }
      db.exec('DELETE FROM history_prune_evidence WHERE id IN (SELECT provenance_evidence_id FROM session_refs WHERE provenance_evidence_id IS NOT NULL)')
      let changed
      do {
        changed = db.prepare(`DELETE FROM history_prune_evidence WHERE id IN (
          SELECT supersedes_evidence_id FROM evidence WHERE evidence_id NOT IN (SELECT id FROM history_prune_evidence)
          UNION SELECT corrects_evidence_id FROM evidence WHERE evidence_id NOT IN (SELECT id FROM history_prune_evidence))`).run().changes
      } while (changed)
      const removable = db.prepare('SELECT id FROM history_prune_evidence').all()
      summary.retainedAuditEvidence += candidates - removable.length
      for (const { id } of removable) {
        const rowid = ftsRows.get(id)
        if (rowid !== undefined) db.prepare('DELETE FROM evidence_fts WHERE rowid=?').run(rowid)
      }
      db.exec('UPDATE task_sessions SET evidence_id=NULL WHERE evidence_id IN (SELECT id FROM history_prune_evidence)')
      db.exec('DELETE FROM evidence WHERE evidence_id IN (SELECT id FROM history_prune_evidence)')
      db.exec('INSERT INTO history_prune_blobs SELECT DISTINCT content_hash FROM source_records WHERE source_record_id IN (SELECT id FROM history_prune_sources)')
      db.exec('DELETE FROM source_records WHERE source_record_id IN (SELECT id FROM history_prune_sources) AND source_record_id NOT IN (SELECT source_record_id FROM evidence)')
      db.exec(`DELETE FROM source_blobs WHERE content_hash IN (SELECT id FROM history_prune_blobs)
        AND content_hash NOT IN (SELECT content_hash FROM source_records) AND content_hash NOT IN (SELECT content_hash FROM evidence)
        AND content_hash NOT IN (SELECT content_hash FROM artifacts WHERE content_hash IS NOT NULL)`)
      if (task) {
        db.prepare('DELETE FROM task_sessions WHERE task_id=?').run(task.taskId)
        if (!hasReferences(db, taskRefs, task.taskId)) {
          db.prepare("DELETE FROM events WHERE aggregate_type='task' AND aggregate_id=?").run(task.taskId)
          db.prepare('DELETE FROM tasks WHERE task_id=?').run(task.taskId)
          summary.tasks += 1
        }
      }
      if (session.source_kind !== 'personal_assistant' && !hasReferences(db, sessionRefs, session.session_ref_id)) {
        db.prepare('DELETE FROM session_refs WHERE session_ref_id=?').run(session.session_ref_id)
        summary.sessions += 1
      }
      if (system === 'dsh') db.prepare("DELETE FROM import_cursors WHERE importer_id='dsh-session-persistence' AND source_uri=?").run(uri)
      else {
        for (const record of records) if (record.source_kind === 'rollout_item') db.prepare("DELETE FROM import_cursors WHERE importer_id='codex-rollout' AND source_uri=?").run(record.source_uri)
      }
      summary.evidence += removable.length
    })
  }
  return summary
}

/** Clear Codex history mirrors while preserving evidence and Sessions used by operations.
 * @param ledger - local history ledger.
 * @param options - cooperative cancellation checkpoint.
 * @returns counts of removed mirror rows and retained audit evidence.
 */
export async function clearCodexHistory(ledger, { checkpoint = async () => {} } = {}) {
  const sessions = ledger.db.prepare("SELECT external_id FROM session_refs WHERE system='codex'").all()
  ledger.database.clearManagedBackups()
  ledger.database.transaction(() => {
    ledger.db.exec("DELETE FROM session_tasks WHERE session_ref_id IN (SELECT session_ref_id FROM session_refs WHERE system='codex'); DELETE FROM history_messages WHERE session_ref_id IN (SELECT session_ref_id FROM session_refs WHERE system='codex'); DELETE FROM history_sessions WHERE session_ref_id IN (SELECT session_ref_id FROM session_refs WHERE system='codex');")
  })
  saveHistoryEligibility(ledger, 'codex', new Set(), new Set())
  const summary = await pruneInactiveHistory(ledger, {
    system: 'codex',
    keep: new Set(),
    unknown: new Set(),
    cutoff: Date.parse('9999-12-31T23:59:59.999Z'),
    checkpoint,
  })
  ledger.database.transaction(() => {
    ledger.db.prepare("DELETE FROM import_cursors WHERE importer_id IN ('codex-session-index','codex-rollout')").run()
    const removeEligibility = ledger.db.prepare("DELETE FROM import_cursors WHERE importer_id='recent-history-eligibility' AND source_uri=? AND NOT EXISTS (SELECT 1 FROM session_refs WHERE system='codex' AND external_id=?)")
    for (const { external_id: externalId } of sessions) removeEligibility.run(`codex:${externalId}`, externalId)
  })
  return summary
}
