/** Targeted and index-only lookup diagnostics on a prepared synthetic database. */
import {performance} from 'node:perf_hooks'
import {pathToFileURL} from 'node:url'
import path from 'node:path'
const [source,root]=process.argv.slice(2)
const {resolveConfig}=await import(pathToFileURL(path.join(source,'lib/config.js')))
const {LedgerDatabase}=await import(pathToFileURL(path.join(source,'lib/database.js')))
const {Ledger}=await import(pathToFileURL(path.join(source,'lib/ledger.js')))
const database=new LedgerDatabase(resolveConfig({dataDir:path.join(root,'data'),codexHome:path.join(root,'codex')})).open()
try {
 const h=new Ledger(database,{instanceId:'performance'}).history
 const cases=[{query:'',rawSearch:false},{query:'scaleitem000000',rawSearch:false},{query:'scaleitem000000',rawSearch:true,taskId:'scale-task-0'},
  {query:'reconnect',rawSearch:true,sourceSystem:'codex',from:'2026-10-25T00:00:00.000Z',to:'2026-10-26T00:00:00.000Z',rawWithinRange:true}]
 for(const query of cases)for(let repeat=0;repeat<3;repeat++){
  const start=performance.now(),result=h.list(query)
  console.log(JSON.stringify({query,repeat,elapsedMs:performance.now()-start,total:result.total}))
 }
}finally{database.close()}
