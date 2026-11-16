import test from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {LedgerDatabase} from '../lib/database.js'
import {fixture} from './helpers.js'
test('unsupported databases fail before modification and require explicit initialization',()=>{
 const f=fixture();try{
  f.ledger.createTask({objective:'Retain until explicit reset',sourceKey:'reset:explicit'})
  f.database.db.exec('PRAGMA user_version=0')
  f.database.close()
  const next=new LedgerDatabase(f.config)
  assert.throws(()=>next.open(),/explicit initialization/)
  assert.equal(next.db,null)
  const inspect=new DatabaseSync(f.config.databasePath,{readOnly:true})
  try{assert.equal(inspect.prepare('SELECT objective FROM tasks').get().objective,'Retain until explicit reset')}finally{inspect.close()}
 }finally{f.close()}
})
