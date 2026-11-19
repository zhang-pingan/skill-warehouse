import test from 'node:test'
import assert from 'node:assert/strict'
import { retrievalFixture } from './retrieval-performance-fixture.js'

test('history scans FTS once, preserves shared-message counts and ordered bounded snippets',async()=>{
  const f=await retrievalFixture();try {
    const h=f.service.ledger.history, db=h.db, statements=[]
    h.db={prepare(sql){ const statement=db.prepare(sql);statements.push(sql);return statement }}
    const page=h.list({query:'orchid',rawSearch:true})
    const rows=page.records.filter(r=>f.taskIds.includes(r.id))
    assert.equal(rows.length,2)
    for(const row of rows){assert.equal(row.matchCount,16);assert.equal(row.matches.length,5)}
    assert.deepEqual(rows[0].matches,rows[1].matches)
    const expected=db.prepare("SELECT evidence_id FROM history_messages WHERE message_id LIKE 'shared-%' ORDER BY message_id LIMIT 5").all().map(r=>r.evidence_id)
    assert.deepEqual(rows[0].matches.map(r=>r.evidenceId),expected)
    assert.equal(statements.filter(sql=>sql.includes('evidence_fts')).length,1)
    assert.equal(statements.filter(sql=>!sql.startsWith('SELECT source_text(')).length,8)
    assert.equal(page.supplementaryTotal,18)
    const pending=h.list({query:'orchid',rawSearch:true,offset:5,limit:4})
    assert.deepEqual(pending.supplementary.map(r=>r.id),['pending-05','pending-06','pending-07','pending-08'])
    assert.equal(pending.supplementaryHasMore,true)
  }finally{await f.close()}
})

test('supplementary bodies are read once and archived corruption remains an error',async()=>{
  const f=await retrievalFixture();try {
    const h=f.service.ledger.history,body=h.body.bind(h),counts=new Map()
    h.body=m=>{counts.set(m.message_id,(counts.get(m.message_id)??0)+1);return body(m)}
    h.list({query:'orchid',rawSearch:true,limit:2})
    assert.ok([...counts.values()].every(n=>n===1))
    const row=h.db.prepare("SELECT content_hash FROM history_messages WHERE message_id='pending-01'").get()
    h.db.prepare('UPDATE source_blobs SET compressed=? WHERE content_hash=?').run(Buffer.from('bad gzip'),row.content_hash)
    assert.throws(()=>h.list({query:'orchid',rawSearch:true}),/header|gzip|data|compression/i)
  }finally{await f.close()}
})

test('fresh requests reflect source and task deletions without cached hits',async()=>{
  const f=await retrievalFixture();try {
    const h=f.service.ledger.history
    assert.equal(h.list({query:'orchid',rawSearch:true,taskId:f.taskIds[0]}).records[0].matchCount,16)
    const evidence=h.db.prepare("SELECT evidence_id FROM history_messages WHERE message_id='shared-00'").get().evidence_id
    h.db.prepare('DELETE FROM evidence_fts WHERE evidence_id=?').run(evidence)
    assert.equal(h.list({query:'orchid',rawSearch:true,taskId:f.taskIds[0]}).records[0].matchCount,15)
    h.db.prepare('DELETE FROM session_tasks WHERE session_task_id=?').run(f.taskIds[0])
    assert.deepEqual(h.list({query:'orchid',rawSearch:true,taskId:f.taskIds[0]}).records,[])
  }finally{await f.close()}
})
