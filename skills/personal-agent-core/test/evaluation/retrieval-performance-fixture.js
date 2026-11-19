/** Small adversarial history extending the fixed evaluation corpus without personal content. */
import { gzipSync } from 'node:zlib'
import { createFixture, loadJson } from './fixture.js'

export async function retrievalFixture(options = {}) {
  const f = await createFixture(loadJson('corpus.json'), options)
  try {
    const { ledger, database } = f.service, db = database.db
    const taskIds = db.prepare('SELECT session_task_id FROM session_tasks ORDER BY session_task_id LIMIT 2').all().map(r=>r.session_task_id)
    const sessionRefId = db.prepare('SELECT session_ref_id FROM session_tasks WHERE session_task_id=?').get(taskIds[0]).session_ref_id
    database.transaction(()=>{
      for (let i=15;i>=0;i--) {
        const text = i%2 ? 'Shared orchid ＡＢＣ_42 café 恢复队列 evidence.' : 'Shared orchid ABC_42 cafe\u0301 恢复队列 evidence.'
        const record={sessionRefId,sourceSystem:'dsh',sourceKind:'message',sourceUri:'synthetic://shared',sourceLocator:`seq:${i}`,sourceIdentity:'perf-v1',text,
          authorRole:i%2?'user':'tool',occurredAt:i===4?null:`2026-01-01T00:00:${String(i%3).padStart(2,'0')}.000Z`,queueExtraction:false}
        const evidence=ledger.ingestSource(record)
        const id=`shared-${String(i).padStart(2,'0')}`
        db.prepare('INSERT INTO history_messages VALUES(?,?,?,?,?,?,?,?,?)').run(id,sessionRefId,JSON.stringify({...record,text:undefined}),null,evidence.contentHash,record.occurredAt,i,'assigned',evidence.evidenceId)
        for(const task of taskIds)db.prepare('INSERT INTO session_task_messages VALUES(?,?)').run(task,id)
        if(i%2)db.prepare('UPDATE source_blobs SET compressed=?,content=NULL WHERE content_hash=?').run(gzipSync(text),evidence.contentHash)
      }
      for(let i=0;i<18;i++) {
        const record={sessionRefId,sourceSystem:'dsh',sourceKind:'message',sourceUri:'synthetic://unassigned',sourceLocator:`seq:${i}`,sourceIdentity:'perf-v1',
          text:`Unassigned orchid 恢复队列 ${i}.`,authorRole:'user',occurredAt:'2026-01-01T00:00:00.000Z',queueExtraction:false}
        const evidence=ledger.ingestSource(record)
        db.prepare('INSERT INTO history_messages VALUES(?,?,?,?,?,?,?,?,?)').run(`pending-${String(i).padStart(2,'0')}`,sessionRefId,JSON.stringify({...record,text:undefined}),i%2?null:record.text,evidence.contentHash,record.occurredAt,i,['unprocessed','unresolved','no-task'][i%3],evidence.evidenceId)
        if(i%2)db.prepare('UPDATE source_blobs SET compressed=?,content=NULL WHERE content_hash=?').run(gzipSync(record.text),evidence.contentHash)
      }
      db.prepare('UPDATE history_sessions SET revision=revision+1,last_error=? WHERE session_ref_id=?').run('Synthetic pending ownership',sessionRefId)
    })
    const evidenceId=db.prepare("SELECT evidence_id FROM history_messages WHERE message_id='shared-01'").get().evidence_id
    const entityIds=[]
    for(let i=0;i<12;i++) {
      const entity=f.service.memory.ensureEntity({name:`orchid ${i}`,type:'project',state:'user-stated',evidenceId,quote:'orchid'})
      const tool=f.service.memory.ensureEntity({name:`Shared ${i}`,type:'tool',state:'user-stated',evidenceId,quote:'Shared'})
      entityIds.push(entity.id)
      f.service.memory.createRecord({kind:'fact',content:`orchid ${i} uses Shared ${i}`,entityId:entity.id,predicate:'uses',object:{entityId:tool.id,entityName:tool.name},state:i%2?'candidate':'user-stated',createdBy:i%2?'model':'user',evidence:[{id:evidenceId,quote:'Shared orchid'}]})
    }
    return {...f,taskIds,sessionRefId,entityIds}
  } catch(error) {await f.close();throw error}
}

export function retrievalQueries(f) {
  const projectId=f.service.database.db.prepare('SELECT project_id FROM project_locations ORDER BY project_id LIMIT 1').get().project_id
  const queries=[]
  for(const query of ['','!!!','orchid','恢复队列','ABC_42','ＡＢＣ_42','café','cafe\u0301','nonexistentquasar','CSV'])
    for(const rawSearch of [false,true]) for(const sort of ['relevance','recent'])
      for(const offset of [0,1,1.5,10000]) queries.push({query,rawSearch,sort,offset,limit:1})
  for(const filter of [{from:'2026-01-01T00:00:01.000Z'}, {to:'2026-01-01T00:00:01.000Z'}, {from:'2026-01-01',to:'2026-01-02'},
    {from:'',to:''},{sourceSystem:'codex'},{sessionId:f.sessionRefId},{projectId},{entityId:f.entityIds[0]},{taskId:f.taskIds[0]},
    ...['assigned','unresolved','no-task','unprocessed','completed','uncertain'].map(state=>({state}))])
    for(const query of ['orchid','恢复队列','CSV'])for(const rawWithinRange of [false,true]) queries.push({query,rawSearch:true,rawWithinRange,...filter})
  return queries
}
