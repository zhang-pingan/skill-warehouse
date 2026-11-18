/** Synthetic published-history fixtures; no extraction model or personal storage is accessed. */
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'

export const defaultSource = path.resolve(import.meta.dirname, '../..')
export const digest = value => createHash('sha256').update(value).digest('hex')
export const loadJson = name => JSON.parse(readFileSync(path.join(import.meta.dirname, name), 'utf8'))

/** Hash production inputs independently of evaluation artifacts and installed dependencies. */
export function sourceManifest(source = defaultSource) {
  const files = ['index.js', 'client.js', 'schema.sql', 'package.json']
  const walk = relative => {
    for (const entry of readdirSync(path.join(source, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name)
      if (entry.isDirectory()) walk(name)
      else if (/\.(js|sql|json)$/u.test(name)) files.push(name)
    }
  }
  walk('lib')
  const hashes = Object.fromEntries(files.sort().map(file => [file, digest(readFileSync(path.join(source, file)))]))
  return { sha256: digest(JSON.stringify(hashes)), files: hashes }
}

/** Build an isolated database from corpus records, never from answer labels. */
export async function createFixture(corpus, { source = defaultSource, asOf = '2026-11-18T00:00:00.000Z', coldBodies = false, analysisInputChars } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'personal-agent-evaluation-'))
  const load = name => import(pathToFileURL(path.join(source, 'lib', `${name}.js`)))
  const [{ resolveConfig }, { PersonalAgentService }] = await Promise.all([load('config'), load('service')])
  const config = resolveConfig({ dataDir: path.join(root, 'data'), codexHome: path.join(root, 'codex'), allowedWorkspaceRoots: [root],
    codexWorkerEnabled: false, inboxRetryEnabled: false, historySyncOnStart: false, memoryExtractionEnabled: false,
    ...(analysisInputChars === undefined ? {} : { analysisInputChars }) })
  const service = new PersonalAgentService(config)
  const clock = () => Date.parse(asOf)
  service.database.clock = clock
  const maps = { messages: new Map(), evidence: new Map(), memories: new Map(), sessions: new Map(), projects: new Map(), tasks: new Map() }
  try {
    await service.initialize()
    service.ledger.clock = clock
    const { ledger, database, memory } = service
    const db = database.db
    database.transaction(() => {
      for (const family of corpus.families) {
        for (const session of family.sessions) {
          const projectKey = session.projectId ?? family.projectId ?? family.id
          const project = ledger.upsertProject({ name: projectKey, canonicalPath: path.join(root, projectKey) })
          maps.projects.set(projectKey, project.projectId)
          const sourceSystem = session.sourceSystem ?? (session.worker === 'codex' ? 'codex' : 'dsh')
          const native = ledger.upsertSession({ system: sourceSystem, externalId: session.id, cwd: path.join(root, projectKey),
            sourceKind: sourceSystem === 'codex' ? 'app_server_thread' : 'session', durability: 'durable', nativeStatus: 'idle' })
          maps.sessions.set(session.id, native.sessionRefId)
          db.prepare('INSERT INTO history_sessions(session_ref_id,title,revision,published_revision,scan_complete,updated_at) VALUES(?,?,1,1,1,?)').run(native.sessionRefId, session.title, asOf)
          for (const [index, message] of session.messages.entries()) {
            if (Date.parse(message.createdAt) > Date.parse(asOf)) continue
            const sourceRecord = { sessionRefId: native.sessionRefId, sourceSystem, sourceKind: 'message', externalId: session.id,
              sourceUri: `synthetic://${session.id}`, sourceLocator: `seq:${index + 1}`, sourceIdentity: corpus.datasetId,
              authorRole: message.role, occurredAt: message.createdAt, text: message.text, queueExtraction: false }
            const evidence = ledger.ingestSource(sourceRecord)
            maps.messages.set(message.id, evidence.evidenceId)
            maps.evidence.set(evidence.evidenceId, message.id)
            db.prepare('INSERT INTO history_messages(message_id,session_ref_id,source_json,staged_text,content_hash,occurred_at,source_order,ownership,evidence_id) VALUES(?,?,?,NULL,?,?,?,?,?)')
              .run(message.id, native.sessionRefId, JSON.stringify({ ...sourceRecord, text: undefined }), evidence.contentHash, message.createdAt, index + 1, message.ownership ?? 'assigned', evidence.evidenceId)
          }
        }
        for (const task of family.sessionTasks) {
          const sessionId = task.sessionId ?? task.sessionIds[0]
          const messages = family.sessions.flatMap(session => session.messages).filter(message => task.sourceMessageIds.includes(message.id) && maps.messages.has(message.id))
          if (!messages.length) continue
          const dates = messages.map(message => message.createdAt).sort()
          const version = digest(JSON.stringify([task, messages]))
          db.prepare('INSERT INTO session_tasks(session_task_id,session_ref_id,title,goal,summary,state,first_activity_at,last_activity_at,context_version,extracted_version) VALUES(?,?,?,?,?,?,?,?,?,?)')
            .run(task.id, maps.sessions.get(sessionId), task.title, task.objective, task.summary, task.status, dates[0], dates.at(-1), version, version)
          maps.tasks.set(task.id, task.id)
          for (const message of messages) db.prepare('INSERT INTO session_task_messages(session_task_id,message_id) VALUES(?,?)').run(task.id, message.id)
        }
        for (const record of family.memories) {
          const evidence = record.evidence.filter(item => maps.messages.has(item.messageId)).map(item => ({ id: maps.messages.get(item.messageId), quote: item.quote }))
          if (!evidence.length) continue
          const state = ['candidate', 'confirmed', 'user-stated'].includes(record.status) ? record.status : 'candidate'
          const saved = memory.createRecord({ kind: record.kind ?? 'fact', content: record.text, state, createdBy: state === 'candidate' ? 'model' : state === 'user-stated' ? 'user' : 'host',
            evidence, validFrom: record.validFrom ?? null, validTo: record.validTo ?? record.validUntil ?? null, scope: { project: family.projectId ?? family.id } })
          if (['superseded', 'retracted'].includes(record.status)) db.prepare('UPDATE memory_records SET memory_state=? WHERE memory_id=?').run(record.status, saved.id)
          maps.memories.set(record.id, saved.id)
          if (maps.tasks.has(record.sessionTaskId)) db.prepare('INSERT OR IGNORE INTO session_task_memories(session_task_id,memory_id) VALUES(?,?)').run(record.sessionTaskId, saved.id)
        }
      }
      if (coldBodies) for (const row of db.prepare('SELECT content_hash,content FROM source_blobs').all()) {
        db.prepare('UPDATE source_blobs SET compressed=?,content=NULL WHERE content_hash=?').run(gzipSync(row.content), row.content_hash)
      }
    })
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const counts = Object.fromEntries(['history_sessions', 'session_tasks', 'history_messages', 'memory_records', 'evidence_fts', 'memory_fts', 'source_blobs'].map(table => [table, db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]))
    const bytes = statSync(config.databasePath).size
    const indexBytes = Object.fromEntries(['evidence_fts', 'memory_fts'].map(prefix => [prefix, db.prepare('SELECT COALESCE(SUM(pgsize),0) AS bytes FROM dbstat WHERE name LIKE ?').get(`${prefix}%`).bytes]))
    return { service, root, maps, counts, bytes, indexBytes, async close() { await service.dispose(); rmSync(root, { recursive: true, force: true }) } }
  } catch (error) {
    await service.dispose()
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}
