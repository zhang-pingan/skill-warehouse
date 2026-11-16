import test from 'node:test'
import assert from 'node:assert/strict'
import {fixture} from './helpers.js'
import {activityTime,historyWindow} from '../lib/history-retention.js'
import {DshHistoryImporter} from '../lib/dsh-history.js'
test('query window is independent of import retention and timestamp validation',async()=>{
 const f=fixture({historyRetentionDays:1});try{
  const now=Date.now();assert.equal(historyWindow(f.config,()=>now).cutoff,now-86400000)
  for(const value of [null,undefined,{},'invalid',Infinity])assert.equal(activityTime(value),null)
  const importer=new DshHistoryImporter(f.ledger)
  const events=[{seq:0,time:'2020-01-01T00:00:00Z',type:'user/message',surfaceOp:'append',data:{content:[{text:'Preserve old original history'}]}}]
  const source={async list(){return[{id:'old',revision:1,eventCount:1}]},async open(){return{async read(offset){return{events:offset?[]:events}},async close(){}}}}
  assert.equal((await importer.importFromPersistence(source)).imported,1)
  assert.equal((await importer.importFromPersistence(source)).retention.deleted,0)
  assert.equal(f.database.db.prepare('SELECT COUNT(*) AS n FROM history_messages').get().n,1)
 }finally{f.close()}
})
