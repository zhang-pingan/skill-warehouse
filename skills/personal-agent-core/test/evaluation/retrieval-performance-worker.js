/** Isolated production query measurements; synthetic databases only. */
import { performance } from 'node:perf_hooks'
import { observeQuery } from './query-heartbeat.js'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
const [source, root, output, lane, query = 'scaleitem000000'] = process.argv.slice(2)
const emit = value => process.stdout.write(JSON.stringify(value) + '\n')
const { resolveConfig } = await import(pathToFileURL(path.join(source, 'lib/config.js')))
const { PersonalAgentService } = await import(pathToFileURL(path.join(source, 'lib/service.js')))
const service = new PersonalAgentService(resolveConfig({ dataDir:path.join(root,'data'), codexHome:path.join(root,'codex'), wechatLockDir:path.join(root,'locks'),
  codexWorkerEnabled:false, manageCodexDaemon:false, wechatEnabled:false, historySyncEnabled:false, historyStartupSyncEnabled:false,
  historyPeriodicSyncEnabled:false, memoryExtractionEnabled:false, semanticRoutingEnabled:false, cleanupEnabled:false, backupEnabled:false, inboxRetryEnabled:false }, {}))
service.database.clock=()=>Date.parse('2026-11-18T00:00:00.000Z')
try {
  const init=performance.now(); await service.initialize(); service.ledger.clock=service.database.clock
  emit({event:'ready',initializeMs:performance.now()-init})
  const args={ action:lane==='history'?'search_history':'memory_search',query,limit:20,includeCandidates:true,asOf:'2026-11-18T00:00:00.000Z' }
  for(const pass of ['first','repeat']) {
    emit({event:'query-start',pass})
    const {value:response,elapsedMs,heartbeat}=await observeQuery(()=>service.operate(args))
    const serialized=JSON.stringify(response)
    writeFileSync(`${output}-${pass}.json`,serialized+'\n')
    global.gc?.()
    emit({event:'query',pass,elapsedMs,heartbeat,sha256:createHash('sha256').update(serialized).digest('hex'),memory:process.memoryUsage(),resources:process.resourceUsage()})
  }
} finally { await service.dispose(); emit({event:'disposed'}) }
