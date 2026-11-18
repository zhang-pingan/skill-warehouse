/** Plain-Node child measuring persistent production-service readiness and query operations. */
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import { statSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import assert from 'node:assert/strict'
import { scaleProtocol, scaleMessage, scaleQueries, taskToken, taskId } from './scale-corpus.js'

const [mode, root, source, rawCount] = process.argv.slice(2)
const count = Number(rawCount)
const emit = value => process.stdout.write(JSON.stringify(value) + '\n')
const hash = value => createHash('sha256').update(value).digest('hex')
let service
const boot = performance.now()
global.gc?.()
const baselineMemory = process.memoryUsage()
try {
  assert(['build', 'sample', 'history', 'memory'].includes(mode) && count >= 20 && count % 20 === 0)
  const importsAt = performance.now()
  const [{ resolveConfig }, { PersonalAgentService }] = await Promise.all(['config', 'service'].map(name => import(pathToFileURL(path.join(source, 'lib', `${name}.js`)))))
  const importMs = performance.now() - importsAt
  const config = resolveConfig({
    dataDir: path.join(root, 'data'), codexHome: path.join(root, 'codex'), wechatLockDir: path.join(root, 'locks'),
    allowedWorkspaceRoots: [root], codexWorkerEnabled: false, dshWorkerEnabled: true,
    inboxRetryEnabled: false, historySyncEnabled: false, historyStartupSyncEnabled: false, historyPeriodicSyncEnabled: false,
    memoryExtractionEnabled: false, semanticRoutingEnabled: false, cleanupEnabled: false, backupEnabled: false,
    manageCodexDaemon: false, wechatEnabled: false,
  }, {})
  service = new PersonalAgentService(config)
  service.database.clock = () => Date.parse(scaleProtocol.asOf)
  const initializeAt = performance.now()
  const initialized = await service.initialize()
  const initializeMs = performance.now() - initializeAt
  service.ledger.clock = () => Date.parse(scaleProtocol.asOf)
  const healthAt = performance.now()
  const health = await service.operate({ action: 'health' })
  const healthMs = performance.now() - healthAt
  const capabilitiesAt = performance.now()
  const capabilities = service.workerCapabilities()
  const capabilitiesMs = performance.now() - capabilitiesAt
  assert.equal(initialized.ok, true)
  assert.equal(health.ok, true)
  assert.equal(capabilities.dsh.available, false)
  assert.equal(capabilities.codex.available, false)
  const ready = { event: 'ready', mode, count, importMs, initializeMs, healthMs, capabilitiesMs,
    workerScriptToReadyMs: performance.now() - boot, baselineMemory, readyMemory: process.memoryUsage(),
    configuredBackgroundJobs: { historySync: config.historySyncEnabled, extraction: config.memoryExtractionEnabled, inboxRetry: config.inboxRetryEnabled, backup: config.backupEnabled, cleanup: config.cleanupEnabled },
    workerAvailability: { dsh: capabilities.dsh.available, codex: capabilities.codex.available } }
  emit(ready)
  const db = service.database.db
  if (mode === 'build') {
    const buildAt = performance.now()
    const logical = createHash('sha256')
    const distribution = { characters: 0, utf8Bytes: 0, archived: 0, hot: 0, lengths: {}, archivedLengths: {}, roles: {}, systems: {} }
    const insertSession = db.prepare('INSERT INTO history_sessions(session_ref_id,title,revision,published_revision,scan_complete,updated_at) VALUES(?,?,1,1,1,?)')
    const insertTask = db.prepare('INSERT INTO session_tasks(session_task_id,session_ref_id,title,goal,summary,state,first_activity_at,last_activity_at,context_version,extracted_version) VALUES(?,?,?,?,?,?,?,?,?,?)')
    const insertMessage = db.prepare('INSERT INTO history_messages(message_id,session_ref_id,source_json,staged_text,content_hash,occurred_at,source_order,ownership,evidence_id) VALUES(?,?,?,NULL,?,?,?,?,?)')
    const linkMessage = db.prepare('INSERT INTO session_task_messages(session_task_id,message_id) VALUES(?,?)')
    const linkMemory = db.prepare('INSERT INTO session_task_memories(session_task_id,memory_id) VALUES(?,?)')
    const archive = db.prepare('UPDATE source_blobs SET compressed=?,content=NULL WHERE content_hash=?')
    service.database.transaction(() => {
      let session, project
      for (let index = 0; index < count; index++) {
        const message = scaleMessage(index)
        logical.update(JSON.stringify(message) + '\n')
        distribution.characters += message.text.length
        distribution.utf8Bytes += Buffer.byteLength(message.text)
        distribution[message.archived ? 'archived' : 'hot']++
        if (message.archived) distribution.archivedLengths[message.text.length] = (distribution.archivedLengths[message.text.length] ?? 0) + 1
        for (const [name, key] of [['lengths', message.text.length], ['roles', message.role], ['systems', message.system]]) distribution[name][key] = (distribution[name][key] ?? 0) + 1
        if (index % 20 === 0) {
          const cwd = path.join(root, `project-${message.session % 8}`)
          project = service.ledger.upsertProject({ name: `Synthetic ${message.session % 8}`, canonicalPath: cwd })
          session = service.ledger.upsertSession({ system: message.system, externalId: `scale-session-${message.session}`, cwd,
            sourceKind: message.system === 'codex' ? 'app_server_thread' : 'session', durability: 'durable', nativeStatus: 'idle' })
          insertSession.run(session.sessionRefId, `Synthetic session ${message.session}`, scaleProtocol.asOf)
        }
        if (index % 10 === 0) {
          const title = `${taskToken(message.task)} ${message.topic} ${message.topicLabel}`
          const version = hash(title)
          insertTask.run(taskId(message.task), session.sessionRefId, title, `${title} validation`, `${title} durable summary`,
            message.task % 2 === 0 ? 'open' : 'completed', message.occurredAt, scaleMessage(index + 9).occurredAt, version, version)
        }
        const record = { sessionRefId: session.sessionRefId, sourceSystem: message.system, sourceKind: 'message',
          externalId: `scale-session-${message.session}`, sourceUri: `synthetic://scale-session-${message.session}`,
          sourceLocator: `seq:${index % 20 + 1}`, sourceIdentity: scaleProtocol.version,
          authorRole: message.role, occurredAt: message.occurredAt, text: message.text, queueExtraction: false }
        const evidence = service.ledger.ingestSource(record)
        insertMessage.run(`scale-message-${index}`, session.sessionRefId, JSON.stringify({ ...record, text: undefined }),
          evidence.contentHash, message.occurredAt, index % 20 + 1, 'assigned', evidence.evidenceId)
        linkMessage.run(taskId(message.task), `scale-message-${index}`)
        if (index % 10 === 0) {
          const candidate = message.task % 5 === 0
          const memory = service.memory.createRecord({ kind: 'fact', content: `${taskToken(message.task)} ${message.topic} ${message.topicLabel} checked result.`,
            state: candidate ? 'candidate' : 'confirmed', createdBy: candidate ? 'model' : 'host',
            evidence: [{ id: evidence.evidenceId, quote: message.quote }], scope: { project: project.projectId } })
          linkMemory.run(taskId(message.task), memory.id)
        }
        if (message.archived) archive.run(gzipSync(message.text), evidence.contentHash)
      }
    })
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const buildMs = performance.now() - buildAt
    assert.equal(service.database.integrityCheck().ok, true)
    const tables = ['history_sessions', 'session_tasks', 'history_messages', 'memory_records', 'evidence_fts', 'memory_fts', 'source_blobs']
    const counts = Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]))
    assert.equal(counts.history_messages, count)
    assert.equal(counts.session_tasks, count / 10)
    assert.equal(counts.memory_records, count / 10)
    const indexBytes = Object.fromEntries(['evidence_fts', 'memory_fts'].map(prefix => [prefix, db.prepare('SELECT COALESCE(SUM(pgsize),0) AS bytes FROM dbstat WHERE name LIKE ?').get(`${prefix}%`).bytes]))
    emit({ event: 'build', count, buildMs, distribution, counts, indexBytes, databaseBytes: statSync(config.databasePath).size,
      logicalCorpusSha256: logical.digest('hex'), databaseSha256: hash(readFileSync(config.databasePath)), resourceUsage: process.resourceUsage() })
  } else {
    let retainedResponse
    const responseHashes = new Map()
    const single = ['history', 'memory'].includes(mode)
    for (const pass of single ? ['first'] : scaleProtocol.passes) for (const query of single ? [scaleQueries(count)[0]] : scaleQueries(count)) for (const lane of single ? [mode] : ['history', 'memory']) {
      if (single) emit({ event: 'query-start', count, pass, lane, query })
      const started = performance.now()
      let error = null, observed = null
      try {
        retainedResponse = await service.operate({ action: lane === 'history' ? 'search_history' : 'memory_search',
          query: query.query, limit: scaleProtocol.limit, includeCandidates: true, asOf: scaleProtocol.asOf })
      } catch (failure) { error = { name: failure.name, message: failure.message, code: failure.code ?? null } }
      const elapsedMs = performance.now() - started
      if (!error) {
        const records = lane === 'history' ? retainedResponse.results : retainedResponse.sessionTasks
        observed = { taskIds: records.map(record => record.sessionTaskId ?? record.id),
          memoryCount: retainedResponse.memories?.length ?? 0,
          supplementaryCount: (retainedResponse.supplementary ?? retainedResponse.experiences ?? []).length }
        try {
          if (query.kind === 'exact') {
            assert(observed.taskIds.includes(query.taskId), `Expected ${query.taskId}`)
            if (lane === 'memory') assert(observed.memoryCount > 0, 'Exact memory must be retrieved')
          } else if (query.kind === 'broad') assert(observed.taskIds.length > 0, 'Broad query must retrieve tasks')
          else assert(observed.taskIds.length === 0 && observed.memoryCount === 0 && observed.supplementaryCount === 0, 'Absent query must return no results')
          const key = `${query.id}/${lane}`, responseHash = hash(JSON.stringify(retainedResponse))
          if (pass === 'first') responseHashes.set(key, responseHash)
          else assert.equal(responseHash, responseHashes.get(key), 'Repeated query response changed')
        } catch (failure) { error = { name: failure.name, message: failure.message } }
      }
      emit({ event: 'query', count, pass, lane, query, elapsedMs, observed, error })
    }
    global.gc?.()
    emit({ event: 'resources', count, postGcMemory: process.memoryUsage(), lastResponseReachable: !!retainedResponse,
      resourceUsage: process.resourceUsage(), counts: { messages: db.prepare('SELECT COUNT(*) AS n FROM history_messages').get().n } })
  }
} catch (error) {
  emit({ event: 'failure', mode, count, error: { name: error.name, message: error.message, stack: error.stack } })
  process.exitCode = 1
} finally {
  if (service) {
    const disposeAt = performance.now()
    await service.dispose()
    emit({ event: 'disposed', mode, count, disposeMs: performance.now() - disposeAt })
  }
}
