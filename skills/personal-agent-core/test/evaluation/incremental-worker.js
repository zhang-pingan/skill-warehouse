/** Measure production incremental index writes on an independently reopened synthetic database. */
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { statSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import { incrementalProtocol, incrementalPayloads } from './incremental-protocol.js'

const [source, root, lane, rawCount] = process.argv.slice(2)
const count = Number(rawCount)
const emit = value => process.stdout.write(JSON.stringify(value) + '\n')
const hash = value => createHash('sha256').update(value).digest('hex')
let service
try {
  assert(incrementalProtocol.lanes.includes(lane))
  const [{ resolveConfig }, { PersonalAgentService }] = await Promise.all(['config', 'service'].map(name => import(pathToFileURL(path.join(source, 'lib', `${name}.js`)))))
  const config = resolveConfig({ dataDir: path.join(root, 'data'), codexHome: path.join(root, 'codex'), wechatLockDir: path.join(root, 'locks'),
    allowedWorkspaceRoots: [root], codexWorkerEnabled: false, dshWorkerEnabled: false, manageCodexDaemon: false, wechatEnabled: false,
    historySyncEnabled: false, historyStartupSyncEnabled: false, historyPeriodicSyncEnabled: false,
    inboxRetryEnabled: false, memoryExtractionEnabled: false, semanticRoutingEnabled: false, cleanupEnabled: false, backupEnabled: false }, {})
  service = new PersonalAgentService(config)
  service.database.clock = () => Date.parse(incrementalProtocol.seedProtocol.asOf)
  await service.initialize()
  service.ledger.clock = service.database.clock
  const db = service.database.db
  const payloads = incrementalPayloads(lane)
  const sourceText = evidenceId => db.prepare('SELECT source_text(b.content,b.compressed,b.content_hash) AS text,e.content_hash FROM evidence e JOIN source_blobs b USING(content_hash) WHERE e.evidence_id=?').get(evidenceId)
  const ftsIds = (table, field, token) => db.prepare(`SELECT ${field} AS id FROM ${table} WHERE ${table} MATCH ?`).all(`"${token}"`).map(row => row.id)
  const counts = () => Object.fromEntries(['evidence', 'source_blobs', 'source_records', 'evidence_fts', 'memory_records', 'memory_fts', 'history_messages'].map(table => [table, db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]))
  const storage = () => ({ databaseBytes: statSync(config.databasePath).size, indexBytes: Object.fromEntries(['evidence_fts', 'memory_fts'].map(prefix => [prefix, db.prepare('SELECT COALESCE(SUM(pgsize),0) AS bytes FROM dbstat WHERE name LIKE ?').get(`${prefix}%`).bytes])) })
  const before = { counts: counts(), storage: storage() }
  assert.equal(before.counts.history_messages, count)
  const old = lane === 'memory-correct' ? payloads.map(payload => {
    const row = db.prepare('SELECT memory_id FROM session_task_memories WHERE session_task_id=?').get(payload.targetTaskId)
    assert(row)
    const memory = service.memory.get(row.memory_id)
    const sources = db.prepare('SELECT evidence_id,quote FROM memory_sources WHERE memory_id=?').all(row.memory_id)
    const bodies = sources.map(item => ({ ...item, ...sourceText(item.evidence_id) }))
    assert(ftsIds('memory_fts', 'memory_id', `scaleitem${String(payload.index + 1).padStart(6, '0')}`).includes(memory.id))
    return { memory, bodies }
  }) : []
  for (const payload of payloads) {
    assert.equal(ftsIds('evidence_fts', 'evidence_id', payload.token).length, 0)
    assert.equal(ftsIds('memory_fts', 'memory_id', payload.token).length, 0)
  }
  const requests = payloads.map(payload => lane === 'source-append' ? {
    sourceSystem: 'synthetic', sourceKind: 'message', externalId: `incremental-${payload.index}`,
    sourceUri: 'synthetic://incremental-index', sourceLocator: `seq:${payload.index}`, sourceIdentity: incrementalProtocol.version,
    occurredAt: incrementalProtocol.seedProtocol.asOf, text: payload.text, authorRole: 'user', queueExtraction: false,
  } : { action: lane === 'memory-append' ? 'remember' : 'edit-record', kind: 'fact', content: payload.text,
    ...(lane === 'memory-correct' ? { memoryId: old[payload.index].memory.id } : {}) })
  emit({ event: 'batch-start', count, lane, batchSize: requests.length, before, payloads: payloads.map(({ text, ...metadata }) => ({ ...metadata, sha256: hash(text), utf8Bytes: Buffer.byteLength(text) })) })
  const observations = []
  const started = performance.now()
  for (const [index, request] of requests.entries()) {
    const operationAt = performance.now()
    const value = lane === 'source-append' ? service.ledger.ingestSource(request) : await service.manageMemory(request, { actor: 'operator' })
    observations.push({ index, elapsedMs: performance.now() - operationAt, value })
  }
  const batchMs = performance.now() - started
  emit({ event: 'batch-finished', count, lane, batchMs, operations: observations.map(row => ({ index: row.index, elapsedMs: row.elapsedMs })) })
  const checkpointAt = performance.now()
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const checkpointMs = performance.now() - checkpointAt
  const verified = []
  for (const { index, value } of observations) {
    const payload = payloads[index]
    if (lane === 'source-append') {
      assert.equal(value.inserted, true)
      const saved = sourceText(value.evidenceId)
      assert.equal(saved.text, payload.text)
      assert.equal(saved.content_hash, hash(payload.text))
      assert.deepEqual(ftsIds('evidence_fts', 'evidence_id', payload.token), [value.evidenceId])
      verified.push({ index, token: payload.token, evidenceId: value.evidenceId, text: saved.text, sha256: saved.content_hash, ftsMatch: true })
    } else {
      assert.equal(value.content, payload.text)
      assert.equal(value.state, 'user-stated')
      assert.deepEqual(ftsIds('memory_fts', 'memory_id', payload.token), [value.id])
      const sources = db.prepare('SELECT evidence_id,quote FROM memory_sources WHERE memory_id=?').all(value.id)
      assert(sources.some(item => sourceText(item.evidence_id).text === payload.text))
      const recall = service.memory.search(payload.token, { includeCandidates: true, includeHistory: false })
      assert(recall.memories.some(memory => memory.id === value.id))
      let prior = null
      if (lane === 'memory-correct') {
        const original = old[index]
        const previous = service.memory.get(original.memory.id)
        assert.equal(previous.content, original.memory.content)
        assert.equal(previous.state, 'superseded')
        assert.equal(db.prepare('SELECT supersedes_memory_id FROM memory_records WHERE memory_id=?').get(value.id).supersedes_memory_id, previous.id)
        for (const body of original.bodies) assert.deepEqual({ ...sourceText(body.evidence_id) }, { text: body.text, content_hash: body.content_hash })
        const currentRecall = service.memory.search(`scaleitem${String(index + 1).padStart(6, '0')}`, { includeCandidates: true, includeHistory: false })
        assert(!currentRecall.memories.some(memory => memory.id === previous.id))
        prior = { id: previous.id, content: previous.content, state: previous.state, preservedSources: original.bodies,
          ftsStoredState: db.prepare('SELECT memory_state FROM memory_fts WHERE memory_id=?').get(previous.id).memory_state }
      }
      verified.push({ index, token: payload.token, id: value.id, content: value.content, sources, prior, ftsMatch: true, productionRecall: true })
    }
  }
  const after = { counts: counts(), storage: storage() }
  assert.equal(after.counts.evidence - before.counts.evidence, 20)
  assert.equal(after.counts.evidence_fts - before.counts.evidence_fts, 20)
  assert.equal(after.counts.memory_records - before.counts.memory_records, lane === 'source-append' ? 0 : 20)
  assert.equal(after.counts.memory_fts - before.counts.memory_fts, lane === 'source-append' ? 0 : 20)
  assert.equal(after.counts.history_messages, count)
  assert.equal(service.database.integrityCheck().ok, true)
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  global.gc?.()
  emit({ event: 'verified', count, lane, batchMs, checkpointMs, before, after, verified,
    resourceUsage: process.resourceUsage(), postGcMemory: process.memoryUsage() })
} catch (error) { emit({ event: 'failure', count, lane, error: { name: error.name, message: error.message, stack: error.stack } }); process.exitCode = 1 }
finally { await service?.dispose(); emit({ event: 'disposed', count, lane }) }
