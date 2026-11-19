/** Compare complete production responses against a separately frozen source tree. */
import assert from 'node:assert/strict'
import {pathToFileURL} from 'node:url'
import path from 'node:path'
import {writeFileSync} from 'node:fs'
import {retrievalFixture,retrievalQueries} from './retrieval-performance-fixture.js'
import {sourceManifest,digest} from './fixture.js'
const [before,output]=process.argv.slice(2)
const {SessionHistory}=await import(pathToFileURL(path.join(before,'lib/session-history.js')))
const {MemorySystem}=await import(pathToFileURL(path.join(before,'lib/memory-system.js')))
const results=[]
for(const coldBodies of [false,true]) {
 const f=await retrievalFixture({coldBodies});try {
  const h=f.service.ledger.history,old=new SessionHistory(f.service.ledger)
  old.service=f.service
  for(const query of retrievalQueries(f)) {
   const expected=old.list(query),actual=await f.service.readQuery('history',query)
   assert.deepEqual(actual,structuredClone(expected),JSON.stringify(query))
   results.push({coldBodies,query,sha256:digest(JSON.stringify(actual))})
  }
  for(const query of ['orchid','恢复队列','CSV','nonexistentquasar','ABC_42','café'])for(const offset of [0,1,10000])for(const includeCandidates of [false,true]){
   const opts={offset,limit:3,includeCandidates,asOf:'2026-11-18T00:00:00.000Z'}
   const actual=await f.service.readQuery('search',{query,...opts})
   f.service.ledger.history=old
   const expected=new MemorySystem(f.service).search(query,opts)
   f.service.ledger.history=h
   assert.deepEqual(actual,structuredClone(expected))
   results.push({coldBodies,memory:query,offset,sha256:digest(JSON.stringify(actual))})
  }
 } finally {await f.close()}
}
writeFileSync(output,JSON.stringify({before:sourceManifest(before),after:sourceManifest(),comparisons:results.length,results},null,2)+'\n')
console.log(`${results.length} complete responses equal`)
