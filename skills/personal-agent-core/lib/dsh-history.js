import { analysisLabels } from './analysis-labels.js'
import { cleanText, nowIso, parseJson, sha256 } from './ids.js'
import { historyCheckpoint } from './history-work.js'
import { saveHistoryEligibility, ActivityCache, activityTime, historyWindow } from './history-retention.js'

const ANALYSIS_LABELS = new Set(Object.values(analysisLabels))
const IMPORTER_ID = 'dsh-session-persistence'
const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])

function textOf(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n')
  if (!value || typeof value !== 'object') return ''
  if (value.type === 'reasoning' || value.type === 'tool-call') return ''
  if (typeof value.text === 'string') return value.text
  if (typeof value.content === 'string') return value.content
  if (Array.isArray(value.content)) return textOf(value.content)
  if (value.message) return textOf(value.message)
  return ''
}

function headerOf(snapshot, handle = null) {
  return snapshot?.header ?? snapshot?.meta ?? handle?.header ?? {}
}

function sessionIdOf(snapshot) {
  return snapshot?.id ?? snapshot?.header?.id ?? snapshot?.meta?.id
}

function workspaceOf(header) {
  return header.cwd ?? header.workingDirectory ?? header.workspacePath ?? header.metadata?.workspacePath ?? null
}

function titleOf(header, id) {
  return cleanText(header.title ?? header.name ?? header.metadata?.title ?? `DSH session ${id}`, 1000)
}

function eventAt(event, header) {
  const raw = event.time ?? event.at ?? event.timestamp ?? event.createdAt ?? event.data?.at ?? header.createdAt
  if (typeof raw === 'number') return new Date(raw < 1e12 ? raw * 1000 : raw).toISOString()
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function normalizeEvent(event) {
  if (!SURFACE_TYPES.has(event?.type) || event.surfaceOp !== 'append') return null
  const message = event.type === 'user/message' ? event.data : event.data?.message
  if (event.type === 'user/message' && message?.source?.kind && message.source.kind !== 'user') return null
  const text = cleanText(textOf(message), Infinity)
  if (!text) return null
  const role = event.type === 'user/message' ? 'user' : event.type === 'assistant/message' ? 'assistant' : event.type === 'tool/result' ? 'tool' : event.type.split('/')[0]
  return { text, role, sourceKind: message?.source?.kind ?? null, sourceForm: message?.source?.form ?? null }
}

export class DshHistoryImporter {
  constructor(ledger, { clock = Date.now } = {}) {
    this.ledger = ledger
    this.clock = clock
    this.activity = new ActivityCache(ledger, 'dsh')
  }

  /** Read execution timestamps once per durable revision, independently of transcript cursors. */
  async executionActivity(persistence, snapshot, checkpoint, window) {
    const sessionId = sessionIdOf(snapshot)
    if (!sessionId) throw new Error('DSH persistence snapshot has no session id')
    if (this.ledger.db.prepare('SELECT 1 FROM analysis_runs WHERE session_id=? OR parent_session_id=? LIMIT 1').get(sessionId, sessionId)) return null
    if (snapshot.formatStatus === 'migration-required') throw new Error('Session requires migration before history can be synchronized')
    const uri = `dsh://session/${sessionId}`
    const cached = this.activity.get(uri)
    const headerHash = sha256(JSON.stringify(headerOf(snapshot)))
    if (snapshot.revision != null && !cached.hasFutureActivity && cached.revision === snapshot.revision && cached.headerHash === headerHash
      && cached.eventCount === (snapshot.eventCount ?? null)) return cached.analysisSession ? null : cached.lastExecutionAt
    const append = !cached.hasFutureActivity && cached.headerHash === headerHash && cached.sizeBytes != null && snapshot.sizeBytes > cached.sizeBytes
    let lastExecutionAt = append ? cached.lastExecutionAt : null
    let hasFutureActivity = false
    let analysisSession = cached.analysisSession ?? false
    let offset = append ? cached.offset : 0
    const batchSize = this.ledger.database.config.historyBatchSize
    const handle = await persistence.open(sessionId, 'read')
    const nativeChild = headerOf(snapshot, handle).origin === 'subagent'
    try {
      while (true) {
        await checkpoint()
        const batch = await handle.read(offset, batchSize)
        const events = Array.isArray(batch?.events) ? batch.events : []
        for (const event of events) {
          await checkpoint()
          const message = event.type === 'user/message' ? event.data : event.data?.message
          if (message?.source?.kind === 'personal-agent-analysis' || nativeChild && event.type === 'subagent/descriptor' && ANALYSIS_LABELS.has(event.data?.label)) analysisSession = true
          const execution = ['turn/start', 'step/start', 'turn/end', 'assistant/message', 'tool/result'].includes(event.type)
            || (event.type === 'user/message' && (!message?.source || message.source.kind === 'user'))
          const at = execution ? activityTime(event.time ?? event.at ?? event.timestamp ?? event.createdAt ?? event.data?.at) : null
          if (at !== null && at > window.now) hasFutureActivity = true
          if (at !== null && at <= window.now) lastExecutionAt = Math.max(lastExecutionAt ?? -Infinity, at)
        }
        offset += events.length
        if (events.length < batchSize) break
      }
    } finally { await handle.close() }
    this.activity.save(uri, { sessionId, revision: snapshot.revision ?? null, headerHash, eventCount: snapshot.eventCount ?? null, sizeBytes: snapshot.sizeBytes ?? null, offset, lastExecutionAt, hasFutureActivity, analysisSession })
    return analysisSession ? null : lastExecutionAt
  }

  async importSession({ sessionId, title, workspacePath = null, createdAt = null, messages = [] }, { checkpoint = historyCheckpoint(this.ledger.database.config) } = {}) {
    if (!sessionId) throw new Error('DSH session id is required')
    const session = this.ledger.upsertSession({ system: 'dsh', externalId: sessionId, sourceKind: 'dsh_persistence', cwd: workspacePath, firstSeenAt: createdAt, lastSeenAt: messages.at(-1)?.at ?? createdAt })
    const record = { sessionId, sessionRefId: session.sessionRefId }
    const imported = await this.importMessages(record, messages, checkpoint)
    if (messages.length) this.ledger.history.complete(session.sessionRefId, title)
    return { sessionRefId: session.sessionRefId, imported }
  }

  async importMessages({ sessionId, sessionRefId }, messages, checkpoint) {
    let imported = 0
    for (let index = 0; index < messages.length; index += 1) {
      await checkpoint()
      const message = messages[index]
      if (!['user', 'assistant', 'tool'].includes(message.role)) continue
      if (message.role === 'user' && message.sourceKind && message.sourceKind !== 'user') continue
      const text = cleanText(message.text, Infinity)
      if (!text) continue
      const revision = message.revision ?? `event:${message.seq ?? index}:${sha256(text).slice(0, 16)}`
      const result = this.ledger.stageHistorySource({ sourceSystem: 'dsh', sourceKind: 'message', externalId: message.id ?? `${sessionId}:${message.seq ?? index}`, sourceUri: `dsh://session/${sessionId}`, sourceLocator: `seq:${message.seq ?? index}`, sourceIdentity: revision, occurredAt: message.at ?? null, text, normalizedPayload: { role: message.role, type: message.type ?? null, seq: message.seq ?? index, sourceKind: message.sourceKind ?? null, sourceForm: message.sourceForm ?? null }, trustLevel: 'local', sessionRefId, sourceType: 'message', authorRole: message.role })
      if (result.inserted) imported += 1
    }
    return imported
  }

  cursor(sourceUri) {
    const row = this.ledger.db.prepare('SELECT cursor_json FROM import_cursors WHERE importer_id=? AND source_uri=?').get(IMPORTER_ID, sourceUri)
    return parseJson(row?.cursor_json, { offset: 0, revision: null })
  }

  saveCursor(sourceUri, sourceInstanceId, cursor, warning = []) {
    const at = nowIso()
    this.ledger.db.prepare(`INSERT INTO import_cursors(importer_id,source_uri,source_instance_id,cursor_json,last_attempted_at,last_successful_at,warning_json)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(importer_id,source_uri) DO UPDATE SET source_instance_id=excluded.source_instance_id,cursor_json=excluded.cursor_json,last_attempted_at=excluded.last_attempted_at,last_successful_at=excluded.last_successful_at,warning_json=excluded.warning_json`)
      .run(IMPORTER_ID, sourceUri, sourceInstanceId, JSON.stringify(cursor), at, at, JSON.stringify(warning))
  }

  async importStoredSession(persistence, snapshot, { batchSize = this.ledger.database.config.historyBatchSize, checkpoint = historyCheckpoint(this.ledger.database.config) } = {}) {
    const sessionId = sessionIdOf(snapshot)
    if (!sessionId) throw new Error('DSH persistence snapshot has no session id')
    if (this.ledger.db.prepare('SELECT 1 FROM analysis_runs WHERE session_id=? OR parent_session_id=? LIMIT 1').get(sessionId, sessionId)) return null
    if (snapshot.formatStatus === 'migration-required') return { sessionId, imported: 0, skipped: true, warning: 'migration-required' }
    const sourceUri = `dsh://session/${sessionId}`
    const cursor = this.cursor(sourceUri)
    const eventCount = Number.isSafeInteger(snapshot.eventCount) ? snapshot.eventCount : null
    const headerHash = sha256(JSON.stringify(headerOf(snapshot)))
    if (cursor.complete && snapshot.revision != null && cursor.revision === snapshot.revision && cursor.headerHash === headerHash
      && (eventCount === null || cursor.offset === eventCount)) return { sessionId, imported: 0, skipped: true }
    let offset = cursor.offset ?? 0
    const openStartedTurns = new Set(Array.isArray(cursor.openStartedTurns) ? cursor.openStartedTurns.map(String) : [])
    const openSteppedTurns = new Set(Array.isArray(cursor.openSteppedTurns) ? cursor.openSteppedTurns.map(String) : [])
    if (eventCount !== null && (offset > eventCount || (offset === eventCount && cursor.revision != null && cursor.revision !== snapshot.revision))) {
      offset = 0
      openStartedTurns.clear()
      openSteppedTurns.clear()
    }
    let handle
    let result
    let lastMessageAt = null
    let header = headerOf(snapshot)
    try {
      await checkpoint()
      handle = await persistence.open(sessionId, 'read')
      header = headerOf(snapshot, handle)
      result = await this.importSession({ sessionId, title: titleOf(header, sessionId), workspacePath: workspaceOf(header), createdAt: eventAt({}, header) }, { checkpoint })
      while (eventCount === null || offset < eventCount) {
        await checkpoint()
        const batch = await handle.read(offset, batchSize)
        const events = Array.isArray(batch?.events) ? batch.events : []
        if (!events.length) break
        const messages = []
        for (const event of events) {
          await checkpoint()
          const turn = event?.data?.turn === undefined || event?.data?.turn === null ? null : String(event.data.turn)
          if (event?.type === 'turn/start' && turn !== null) openStartedTurns.add(turn)
          if (event?.type === 'step/start' && turn !== null && openStartedTurns.has(turn)) openSteppedTurns.add(turn)
          if (event?.type === 'turn/end' && turn !== null) {
            openStartedTurns.delete(turn)
            openSteppedTurns.delete(turn)
          }
          const normalized = normalizeEvent(event)
          if (!normalized) continue
          messages.push({ id: `${sessionId}:${event.seq}`, seq: event.seq, type: event.type, ...normalized, at: eventAt(event, header) })
        }
        result.imported += await this.importMessages({ sessionId, ...result }, messages, checkpoint)
        if (messages.length) lastMessageAt = messages.at(-1).at
        offset += events.length
        if (events.length < batchSize) break
      }
    } finally { await handle?.close() }
    await checkpoint()
    if (lastMessageAt) this.ledger.db.prepare('UPDATE session_refs SET last_seen_at=MAX(last_seen_at,?) WHERE session_ref_id=?').run(lastMessageAt, result.sessionRefId)
    if (eventCount !== null && offset < eventCount) throw new Error('Session snapshot was not fully read; retry history import')
    this.ledger.history.complete(result.sessionRefId, titleOf(header, sessionId))
    this.saveCursor(sourceUri, String(persistence.identity?.description ?? snapshot.revision ?? 'dsh'), {
      offset,
      revision: snapshot.revision ?? null,
      headerHash,
      complete: true,
      openStartedTurns: [...openStartedTurns].sort(),
      openSteppedTurns: [...openSteppedTurns].sort(),
    })
    return { sessionId, ...result, offset, assistantTaskCompleted: false }
  }

  async importFromPersistence(persistence, options = {}) {
    if (!persistence || typeof persistence.list !== 'function' || typeof persistence.open !== 'function') return { supported: false, sessions: 0, imported: 0, warnings: ['DSH session persistence list/open API unavailable'] }
    const snapshots = await persistence.list()
    const summary = { supported: true, sessions: 0, imported: 0, skipped: 0, warnings: [] }
    const checkpoint = options.checkpoint ?? historyCheckpoint(this.ledger.database.config)
    const window = options.window ?? historyWindow(this.ledger.database.config, this.clock)
    const keep = new Set()
    const unknown = new Set()
    for (const snapshot of snapshots ?? []) {
      await checkpoint()
      try {
        const id = sessionIdOf(snapshot)
        const at = await this.executionActivity(persistence, snapshot, checkpoint, window)
        if (at === null || at > window.now) { summary.skipped += 1; continue }
        keep.add(id)
        const result = await this.importStoredSession(persistence, snapshot, { ...options, checkpoint })
        summary.sessions += 1
        summary.imported += result.imported ?? 0
        if (result.skipped) summary.skipped += 1
      } catch (error) {
        if (error?.name === 'AbortError') throw error
        unknown.add(sessionIdOf(snapshot))
        summary.warnings.push(`${sessionIdOf(snapshot) ?? 'unknown'}: ${String(error?.message ?? error)}`)
      }
    }
    saveHistoryEligibility(this.ledger, 'dsh', keep, unknown)
    summary.retention = { deleted: 0, permanentDeletionEnabled: false }
    summary.retention.eligible = keep.size
    return summary
  }
}
