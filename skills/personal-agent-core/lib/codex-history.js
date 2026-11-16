import { opendir, open, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { cleanText, json, nowIso, parseJson, sha256 } from './ids.js'
import { historyCheckpoint } from './history-work.js'
import { saveHistoryEligibility, ActivityCache, activityTime, historyLines, historyWindow } from './history-retention.js'

const ROLLOUT_IMPORTER = 'codex-rollout'

async function *walkJsonl(root) {
  let rootReal
  try { rootReal = await realpath(root) } catch (error) { if (error.code === 'ENOENT') return; throw error }
  const queue = [rootReal]
  while (queue.length) {
    const directory = queue.pop()
    const dir = await opendir(directory)
    for await (const entry of dir) {
      const target = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) queue.push(target)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield target
    }
  }
}

function itemText(item) {
  if (!item) return ''
  if (item.type === 'UserMessage' || item.type === 'AgentMessage') {
    return (item.content ?? []).map(part => part.text ?? '').filter(Boolean).join('\n')
  }
  if (item.type === 'CommandExecution') {
    const command = Array.isArray(item.command) ? item.command.join(' ') : String(item.command ?? '')
    return [`$ ${command}`, `status: ${item.status ?? 'unknown'}`, cleanText(item.aggregated_output, Infinity)].filter(Boolean).join('\n')
  }
  if (item.type === 'FileChange') {
    const changes = Array.isArray(item.changes) ? item.changes : Object.entries(item.changes ?? {}).map(([filePath, change]) => typeof change === 'object' && change ? { path: filePath, ...change } : { path: filePath, kind: change })
    return [`file change: ${item.status ?? 'unknown'}`, ...changes.map(change => `${change.kind ?? 'change'} ${change.path ?? ''}`)].join('\n')
  }
  return ''
}

function looksInjected(text) {
  const start = String(text ?? '').trimStart().slice(0, 800).toLowerCase()
  return start.startsWith('# agents.md instructions') || start.startsWith('<environment_context>') ||
    start.startsWith('<system-reminder>') || start.startsWith('<skill_content') || start.startsWith('<skill>') ||
    start.startsWith('current runtime context.') || start.includes('<developer_instructions>') || start.includes('<tool_schema>')
}

function normalizedItem(record) {
  if (record.type !== 'event_msg') return null
  const payload = record.payload ?? {}
  let item = null
  if (payload.type === 'item_completed') item = payload.item
  else if (payload.type === 'user_message') item = { type: 'UserMessage', id: payload.id, content: [{ text: payload.message }] }
  else if (payload.type === 'task_complete' && payload.last_agent_message) item = { type: 'AgentMessage', content: [{ text: payload.last_agent_message }], phase: 'final', completionEcho: true }
  else if (payload.type === 'agent_message') item = { type: 'AgentMessage', id: payload.id, content: [{ text: payload.message }], phase: payload.phase }

  if (!item) return null
  const text = cleanText(itemText(item), Infinity)
  if (!text || (item.type === 'UserMessage' && looksInjected(text))) return null
  if (item.type === 'AgentMessage' && item.phase && !['final','final_answer','commentary'].includes(item.phase)) return null
  const role = item.type === 'UserMessage' ? 'user' : item.type === 'AgentMessage' ? 'assistant' : 'tool'
  const itemId = item.id ?? `${record.ordinal ?? 'unknown'}-${sha256(text).slice(0, 12)}`
  return { text, role, itemId, itemType: item.type ?? 'unknown', turnId: payload.turn_id ?? null, phase: item.phase ?? null, completionEcho: item.completionEcho === true, status: item.status ?? null }
}

export class CodexHistoryImporter {
  constructor(ledger, config, { clock = Date.now } = {}) {
    this.ledger = ledger
    this.db = ledger.db
    this.config = config
    this.clock = clock
    this.activity = new ActivityCache(ledger, 'codex')
  }

  /** Classify by dated execution events; title/index timestamps never qualify a Session. */
  async recentSessions({ checkpoint, window }) {
    const keep = new Set()
    const unknown = new Set()
    const observedFiles = []
    const warnings = []
    let availableRoots = 0
    for (const root of [path.join(this.config.codexHome, 'sessions'), path.join(this.config.codexHome, 'archived_sessions')]) {
      try { await realpath(root); availableRoots += 1 } catch (error) { if (error.code === 'ENOENT') continue; throw error }
      for await (const file of walkJsonl(root)) {
        await checkpoint()
        const info = await stat(file)
        let cached = this.activity.get(file)
        let id = cached.sessionId ?? [...path.basename(file).matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)].at(-1)?.[0]
        try {
          const sameFile = cached.dev === info.dev && cached.ino === info.ino
          const unchanged = sameFile && !cached.hasFutureActivity && cached.size === info.size && cached.mtimeMs === info.mtimeMs && cached.ctimeMs === info.ctimeMs
          if (!unchanged) {
            const append = !cached.hasFutureActivity && sameFile && cached.size < info.size && cached.offset === cached.size
            let lastExecutionAt = append ? cached.lastExecutionAt : null
            let hasFutureActivity = false
            let offset = append ? cached.offset : 0
            for await (const entry of historyLines(file, info, this.config, checkpoint, offset)) {
              offset = entry.offset
              if (!entry.line.trim()) continue
              const record = JSON.parse(entry.line)
              if (record.type === 'session_meta') id = record.payload?.id ?? record.payload?.session_id ?? id
              const kind = record.payload?.type
              const execution = record.type === 'event_msg' && (['task_started', 'task_complete', 'turn_aborted', 'user_message', 'agent_message'].includes(kind)
                || (kind === 'item_completed' && ['UserMessage', 'AgentMessage', 'CommandExecution', 'FileChange', 'Reasoning'].includes(record.payload?.item?.type)))
              const at = execution ? activityTime(record.timestamp) : null
              if (at !== null && at > window.now) hasFutureActivity = true
              if (at !== null && at <= window.now) lastExecutionAt = Math.max(lastExecutionAt ?? -Infinity, at)
            }
            if (!id) throw new Error('Rollout has no Session id')
            cached = { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, offset, sessionId: id, lastExecutionAt, hasFutureActivity }
            this.activity.save(file, cached)
          }
          observedFiles.push({ file, info, id })
          if (cached.lastExecutionAt !== null && cached.lastExecutionAt <= window.now) {
            keep.add(id)
          }
        } catch (error) {
          if (error?.name === 'AbortError') throw error
          if (id) unknown.add(id)
          else throw error
          warnings.push({ file, error: error.message })
        }
      }
    }
    const files = []
    for (const observed of observedFiles) {
      await checkpoint()
      if (keep.has(observed.id)) files.push(observed)
      else if (!unknown.has(observed.id)) this.db.prepare('DELETE FROM import_cursors WHERE importer_id=? AND source_uri=?').run(ROLLOUT_IMPORTER, observed.file)
    }
    return { keep, unknown, files, warnings, available: availableRoots > 0 }
  }

  /** Import changed index rows; successful row fingerprints survive restarts and file rewrites. */
  async importIndex({ checkpoint = historyCheckpoint(this.config), eligibleSessions = null } = {}) {
    const file = path.join(this.config.codexHome, 'session_index.jsonl')
    let handle
    try { handle = await open(file, 'r') } catch (error) { if (error.code === 'ENOENT') return { seen: 0, imported: 0, warnings: [] }; throw error }
    const importerId = 'codex-session-index'
    const fingerprints = []
    const warnings = []
    let seen = 0
    let imported = 0
    let lineNumber = 0
    let lines
    try {
      const previous = parseJson(this.db.prepare('SELECT cursor_json FROM import_cursors WHERE importer_id=? AND source_uri=?').get(importerId, file)?.cursor_json, {})
      lines = handle.readLines({ autoClose: false, highWaterMark: this.config.historyReadBytes })
      for await (const line of lines) {
        await checkpoint()
        const index = lineNumber++
        fingerprints[index] = null
        if (!line.trim()) continue
        seen += 1
        const fingerprint = sha256(line)
        try {
          const record = JSON.parse(line)
          if (!record.id) continue
          if (eligibleSessions && !eligibleSessions.has(record.id)) continue
          if (previous.rows?.[index] === fingerprint) { fingerprints[index] = fingerprint; continue }
          const occurredAt = record.updated_at ?? null
          this.ledger.database.transaction(() => {
            const session = this.ledger.upsertSession({ system: 'codex', externalId: record.id, sourceKind: 'session_index', durability: 'durable', observedAt: occurredAt, lastSeenAt: occurredAt })
            this.db.prepare('INSERT INTO history_sessions(session_ref_id,title,updated_at) VALUES(?,?,?) ON CONFLICT(session_ref_id) DO UPDATE SET title=excluded.title').run(session.sessionRefId,record.thread_name ?? record.id,nowIso(this.clock))
          })
          imported += 1
          fingerprints[index] = fingerprint
        } catch (error) { warnings.push({ line: index + 1, error: error.message }) }
      }
    } finally {
      lines?.close()
      await handle.close()
    }
    await checkpoint()
    const at = nowIso(this.clock)
    this.db.prepare(`INSERT INTO import_cursors(importer_id,source_uri,source_instance_id,cursor_json,last_attempted_at,last_successful_at,warning_json)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(importer_id,source_uri) DO UPDATE SET cursor_json=excluded.cursor_json,last_attempted_at=excluded.last_attempted_at,last_successful_at=excluded.last_successful_at,warning_json=excluded.warning_json`)
      .run(importerId, file, file, json({ rows: fingerprints }), at, at, json(warnings.slice(0, 100)))
    return { seen, imported, warnings: warnings.slice(0, 100) }
  }

  cursor(sourceUri, info) {
    const row = this.db.prepare(`SELECT cursor_json FROM import_cursors WHERE importer_id=? AND source_uri=?`).get(ROLLOUT_IMPORTER, sourceUri)
    const cursor = parseJson(row?.cursor_json, {})
    if (cursor.dev !== info.dev || cursor.ino !== info.ino || cursor.offset > info.size) return { offset: 0, line: 0 }
    return { offset: cursor.offset ?? 0, line: cursor.line ?? 0 }
  }

  saveCursor(sourceUri, info, cursor, warnings = []) {
    const at = nowIso(this.clock)
    this.db.prepare(`INSERT INTO import_cursors(importer_id,source_uri,source_instance_id,cursor_json,last_attempted_at,last_successful_at,warning_json)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(importer_id,source_uri) DO UPDATE SET source_instance_id=excluded.source_instance_id,cursor_json=excluded.cursor_json,last_attempted_at=excluded.last_attempted_at,last_successful_at=excluded.last_successful_at,warning_json=excluded.warning_json`)
      .run(ROLLOUT_IMPORTER, sourceUri, `${info.dev}:${info.ino}`, json({ ...cursor, dev: info.dev, ino: info.ino }), at, at, json(warnings.slice(0, 20)))
  }

  async importRollouts({ totalByteBudget = this.config.maxImportFileBytes, fileByteBudget = this.config.historyReadBytes, checkpoint = historyCheckpoint(this.config), selectedFiles = null } = {}) {
    const files = []
    for (const root of selectedFiles ? [] : [path.join(this.config.codexHome, 'sessions'), path.join(this.config.codexHome, 'archived_sessions')]) {
      for await (const file of walkJsonl(root)) { await checkpoint(); files.push(file) }
    }
    const withStats = selectedFiles ? [...selectedFiles] : []
    for (const file of files) { await checkpoint(); withStats.push({ file, info: await stat(file) }) }
    withStats.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs)
    let remaining = totalByteBudget
    const summary = { filesSeen: withStats.length, filesRead: 0, bytesRead: 0, evidenceImported: 0, warnings: [], complete: true }
    for (const { file, info } of withStats) {
      await checkpoint()
      if (remaining <= 0) { summary.complete = false; break }
      const cursor = this.cursor(file, info)
      if (cursor.offset >= info.size) continue
      let readBytes = Math.min(info.size - cursor.offset, fileByteBudget, remaining)
      let chunk
      let bytesRead
      const handle = await open(file, 'r')
      try {
        while (true) {
          const buffer = Buffer.alloc(readBytes)
          ;({ bytesRead } = await handle.read(buffer, 0, readBytes, cursor.offset))
          chunk = buffer.subarray(0, bytesRead)
          if (chunk.includes(10) || cursor.offset + bytesRead >= info.size) break
          if (readBytes >= this.config.maxHistoryRecordBytes) break
          readBytes = Math.min(info.size - cursor.offset, this.config.maxHistoryRecordBytes, readBytes * 2)
        }
      } finally { await handle.close() }
      if (!bytesRead) continue
      const lastNewline = chunk.lastIndexOf(10)
      if (lastNewline < 0 && cursor.offset + bytesRead < info.size) {
        summary.warnings.push({ file, offset: cursor.offset, error: `record exceeds maximum ${this.config.maxHistoryRecordBytes} byte limit` })
        summary.complete = false
        continue
      }
      const consumed = lastNewline >= 0 ? lastNewline + 1 : bytesRead
      const completeChunk = chunk.subarray(0, consumed).toString('utf8')
      const lines = completeChunk.split('\n')
      const recordCount = lastNewline >= 0 ? lines.length - 1 : lines.length
      let session = this.sessionForFile(file)
      let failed = false
      for (let local = 0; local < recordCount; local += 1) {
        await checkpoint()
        const line = lines[local]
        const lineNo = cursor.line + local + 1
        if (!line) continue
        try {
          const record = JSON.parse(line)
          if (record.type === 'session_meta') {
            const meta = record.payload ?? {}
            const externalId = meta.id ?? meta.session_id
            if (!externalId) continue
            session = this.ledger.upsertSession({ system: 'codex', externalId, rootExternalId: meta.root_session_id ?? null, sourceKind: meta.source ?? 'rollout', cwd: meta.cwd ?? null, workspaceRoots: meta.runtime_workspace_roots ?? [], durability: 'durable', observedAt: record.timestamp, firstSeenAt: meta.timestamp ?? record.timestamp, lastSeenAt: record.timestamp })
            continue
          }
          const item = normalizedItem(record)
          if (!item || !session) continue
          if (item.completionEcho) {
            const previous = this.db.prepare('SELECT content_hash,source_json FROM history_messages WHERE session_ref_id=? ORDER BY source_order DESC,message_id DESC LIMIT 1').get(session.sessionRefId)
            if (previous?.content_hash === sha256(item.text) && JSON.parse(previous.source_json).authorRole === 'assistant') continue
          }
          if (record.timestamp) this.db.prepare('UPDATE session_refs SET last_seen_at=MAX(last_seen_at,?) WHERE session_ref_id=?').run(record.timestamp, session.sessionRefId)
          const source = this.ledger.stageHistorySource({
            sourceSystem: 'codex', sourceKind: 'rollout_item', externalId: session.externalId,
            sourceUri: file, sourceLocator: `line:${lineNo};ordinal:${record.ordinal ?? ''};item:${item.itemId}`,
            sourceIdentity: `${info.dev}:${info.ino}:${record.ordinal ?? lineNo}:${sha256(line)}`, occurredAt: record.timestamp,
            text: item.text, normalizedPayload: { itemId: item.itemId, itemType: item.itemType, turnId: item.turnId, phase: item.phase, status: item.status }, trustLevel: 'local_untrusted', authorRole: item.role,
            sessionRefId: session.sessionRefId, sourceType: item.itemType,
          })
          summary.evidenceImported += source.inserted ? 1 : 0
        } catch (error) {
          if (error?.name === 'AbortError') throw error
          summary.warnings.push({ file, line: lineNo, error: error.message })
          failed = true
          break
        }
      }
      // Repeat the bounded chunk after a failed write; staged message identities make successful earlier rows idempotent.
      const next = failed ? cursor : { offset: cursor.offset + consumed, line: cursor.line + recordCount }
      this.saveCursor(file, info, next, summary.warnings.filter(warning => warning.file === file))
      summary.filesRead += 1
      summary.bytesRead += consumed
      remaining -= consumed
      if (failed || next.offset < info.size) summary.complete = false
    }
    return summary
  }

  sessionForFile(file) {
    const basename = path.basename(file)
    const matches = [...basename.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)]
    const id = this.activity.get(file).sessionId ?? matches.at(-1)?.[0]
    if (!id) return null
    const row = this.db.prepare(`SELECT * FROM session_refs WHERE system='codex' AND external_id=?`).get(id)
    return row ? { ...row, sessionRefId: row.session_ref_id, externalId: row.external_id } : null
  }

  async run(options = {}) {
    const checkpoint = options.checkpoint ?? historyCheckpoint(this.config)
    const window = options.window ?? historyWindow(this.config, this.clock)
    const recent = await this.recentSessions({ checkpoint, window })
    if (!recent.available) return {
      index: { seen: 0, imported: 0, warnings: [] },
      rollouts: { filesSeen: 0, filesRead: 0, bytesRead: 0, evidenceImported: 0, warnings: [], complete: true },
      retention: { skipped: true, warnings: [{ error: 'Codex history directories are unavailable; existing mirror preserved. Check codexHome and retry.' }] },
    }
    const index = await this.importIndex({ ...options, checkpoint, eligibleSessions: recent.keep })
    const rollouts = await this.importRollouts({ ...options, checkpoint, selectedFiles: recent.files })
    saveHistoryEligibility(this.ledger, 'codex', recent.keep, recent.unknown)
    for (const id of recent.keep) {
      const files = recent.files.filter(item => item.id === id)
      const complete = !recent.unknown.has(id) && files.every(({file,info}) => this.cursor(file,info).offset >= info.size) && !rollouts.warnings.some(warning => files.some(item=>item.file===warning.file))
      const session = this.db.prepare("SELECT session_ref_id FROM session_refs WHERE system='codex' AND external_id=?").get(id)
      if (complete && session) this.ledger.history.complete(session.session_ref_id)
    }
    const retention = { deleted: 0, permanentDeletionEnabled: false }
    return { index, rollouts, retention: { ...retention, eligible: recent.keep.size, warnings: recent.warnings } }
  }
}

export { itemText, normalizedItem, walkJsonl }
