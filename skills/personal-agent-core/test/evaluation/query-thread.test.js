import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { openQueryDatabase, querySnapshot } from '../../lib/query-connection.js'
import { retrievalFixture } from './retrieval-performance-fixture.js'
import { verifyThreadReads } from './query-thread-equivalence.js'

test('thread reads preserve complete history, memory, graph, source and discovery responses', async () => {
  assert.ok((await verifyThreadReads()).comparisons >= 600)
})

test('reader is read-only and observes a consistent snapshot while the writer commits', async () => {
  const f = await retrievalFixture()
  let reader
  try {
    const {service} = f, db = service.database.db
    let maxBytes = service.config.maxHistoryRecordBytes
    reader = openQueryDatabase(service.config.databasePath,1000,()=>maxBytes)
    assert.throws(()=>reader.exec("UPDATE session_tasks SET title='forbidden'"), /readonly|read-only/i)
    const title = () => reader.prepare('SELECT title FROM session_tasks WHERE session_task_id=?').get(f.taskIds[0]).title
    const before = title()
    querySnapshot(reader, () => {
      assert.equal(title(), before)
      db.prepare('UPDATE session_tasks SET title=? WHERE session_task_id=?').run('Committed replacement',f.taskIds[0])
      assert.equal(title(), before)
    })
    assert.equal(title(),'Committed replacement')
    const archived = () => reader.prepare("SELECT source_text(content,compressed,content_hash) AS body FROM source_blobs WHERE content_hash=(SELECT content_hash FROM history_messages WHERE message_id='pending-01')").get()
    maxBytes = 1
    assert.throws(archived, /larger|size|length|buffer/i)
    maxBytes = service.config.maxHistoryRecordBytes
    assert.match(archived().body, /Unassigned orchid/)
    assert.ok(await service.readQuery('get',{ historyMessageId:'pending-01' }))
    const beforeCount=(await service.readQuery('history',{query:'orchid',rawSearch:true,taskId:f.taskIds[0]})).records[0].matchCount
    const evidence=db.prepare("SELECT evidence_id FROM history_messages WHERE message_id='shared-00'").get().evidence_id
    db.prepare('DELETE FROM evidence_fts WHERE evidence_id=?').run(evidence)
    assert.equal((await service.readQuery('history',{query:'orchid',rawSearch:true,taskId:f.taskIds[0]})).records[0].matchCount,beforeCount-1)
    db.prepare('DELETE FROM session_tasks WHERE session_task_id=?').run(f.taskIds[0])
    assert.deepEqual((await service.readQuery('history',{taskId:f.taskIds[0]})).records,[])
    const row=db.prepare("SELECT content_hash FROM history_messages WHERE message_id='pending-01'").get()
    db.prepare('UPDATE source_blobs SET compressed=? WHERE content_hash=?').run(Buffer.from('bad gzip'),row.content_hash)
    await assert.rejects(service.readQuery('get',{historyMessageId:'pending-01'}), /header|gzip|data|compression/i)
  } finally { reader?.close(); await f.close() }
})

test('real cancelled queries terminate before close and do not cancel unrelated work', async () => {
  const f = await retrievalFixture()
  try {
    const abort = new AbortController()
    const result = assert.rejects(f.service.operate({action:'search_history',query:'orchid'}, {signal:abort.signal}), /cancel/)
    const worker = f.service.queryReader.worker
    const exited = once(worker, 'exit')
    const next = f.service.manageMemory({action:'search',query:'orchid'})
    abort.abort(new Error('cancel'))
    await result; await exited
    assert.ok((await next).sessionTasks.length)
    const activeWorker = f.service.queryReader.worker, closed = once(activeWorker, 'exit')
    await f.service.dispose(); await closed
    assert.equal(activeWorker.threadId,-1)
  } finally { await f.close() }
})
