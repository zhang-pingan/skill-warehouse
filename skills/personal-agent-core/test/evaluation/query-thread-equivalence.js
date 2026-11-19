/** Compare all read surfaces against the shared synchronous views over the same fixed data. */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { retrievalFixture, retrievalQueries } from './retrieval-performance-fixture.js'
import { digest, sourceManifest } from './fixture.js'
import { discoverExecutionTargets } from '../../lib/execution-discovery.js'

export async function verifyThreadReads() {
  const results = []
  for (const coldBodies of [false, true]) {
    const f = await retrievalFixture({ coldBodies })
    try {
      const { service } = f, db = service.database.db
      const compare = async (kind, args, expected) => {
        const actual = await service.readQuery(kind, args)
        // Structured cloning changes SQLite row prototypes, not the public JSON fields.
        assert.deepEqual(actual, structuredClone(expected), JSON.stringify({ kind, args }))
        results.push({ coldBodies, kind, args, sha256: digest(JSON.stringify(actual)) })
      }
      for (const args of retrievalQueries(f)) await compare('history', args, service.ledger.history.list(args))
      for (const query of ['orchid','恢复队列','CSV','nonexistentquasar','ABC_42','café']) for (const offset of [0,1,10000]) for (const includeCandidates of [false,true]) {
        const args = { query, offset, limit: 3, includeCandidates, asOf: '2026-11-18T00:00:00.000Z' }
        await compare('search', args, service.memory.search(query, args))
      }
      for (const type of ['all','session-task','memory','entity','experience','relation','task']) for (const query of ['','orchid']) {
        const args = { type, query, limit: 3, offset: 1 }
        await compare('list', args, service.memory.list(args))
      }
      for (const args of [{ objective:'orchid' }, { sessionTaskId:f.taskIds[0] }, { sessionId:f.sessionRefId }, { objective:'nonexistentquasar' }]) {
        await compare('discover', args, discoverExecutionTargets(service, args))
      }
      await compare('get', { historyMessageId:'pending-01' }, service.ledger.history.message('pending-01'))
      await compare('get', { sessionTaskId:f.taskIds[0] }, service.ledger.history.get(f.taskIds[0], {offset:0,limit:30}))
      await compare('get', { entityId:f.entityIds[0] }, service.memory.getEntity(f.entityIds[0]))
      const memoryId = db.prepare('SELECT memory_id FROM memory_records LIMIT 1').get().memory_id
      await compare('get', { memoryId }, service.memory.get(memoryId))
      const evidenceId = db.prepare("SELECT evidence_id FROM history_messages WHERE message_id='shared-01'").get().evidence_id
      await compare('get', { evidenceId }, service.memory.getExperience(evidenceId))
      await compare('get', { memoryId:'missing' }, null)
    } finally { await f.close() }
  }
  return { source:sourceManifest(), comparisons:results.length, results }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifyThreadReads()
  writeFileSync(process.argv[2], JSON.stringify(result,null,2)+'\n', { flag:'wx' })
  console.log(`${result.comparisons} complete responses equal`)
}
