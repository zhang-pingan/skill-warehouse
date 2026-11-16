/** Manual synthetic index benchmark; setup and model/network time are excluded. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { setImmediate as yieldLoop } from 'node:timers/promises'

const source = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(import.meta.dirname, '..')
const load = name => import(pathToFileURL(path.join(source, 'lib', `${name}.js`)))
const { resolveConfig } = await load('config')
const { LedgerDatabase } = await load('database')
const { Ledger } = await load('ledger')
const { CodexHistoryImporter } = await load('codex-history')
const backgroundRows = 12_000
const indexRows = 400
const samples = []
for (let sample = 0; sample < 3; sample += 1) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'personal-history-perf-'))
  const config = resolveConfig({ dataDir: path.join(root, 'data'), codexHome: path.join(root, 'codex') })
  const database = new LedgerDatabase(config).open()
  try {
    const ledger = new Ledger(database)
    database.transaction(() => {
      for (let i = 0; i < backgroundRows; i += 1) ledger.ingestSource({
        sourceSystem: 'synthetic', sourceKind: 'message', externalId: `message-${i}`,
        sourceUri: 'synthetic://history', sourceLocator: `line:${i}`, sourceIdentity: '1',
        text: `Generated history record ${i}. ` + 'A build completed after updating a module and checking its behavior. '.repeat(32 + i % 8),
      })
    })
    mkdirSync(config.codexHome, { recursive: true })
    writeFileSync(path.join(config.codexHome, 'session_index.jsonl'), Array.from({ length: indexRows }, (_, i) => JSON.stringify({ id: `thread-${i}`, thread_name: `Generated task ${i}`, updated_at: '2026-01-01T00:00:00Z' })).join('\n') + '\n')
    const importer = new CodexHistoryImporter(ledger, config)
    const measure = async () => {
      let running = true
      let maxEventLoopGapMs = 0
      let previous = performance.now()
      const heartbeat = (async () => {
        while (running) {
          await yieldLoop()
          const now = performance.now()
          maxEventLoopGapMs = Math.max(maxEventLoopGapMs, now - previous)
          previous = now
        }
      })()
      const start = performance.now()
      let result
      let elapsedMs
      try {
        result = await importer.importIndex()
        elapsedMs = performance.now() - start
        assert.equal(result.warnings.length, 0)
      } finally { running = false; await heartbeat }
      return { elapsedMs, maxEventLoopGapMs, imported: result.imported }
    }
    const first = await measure()
    const repeated = await measure()
    assert.equal(first.imported, indexRows)
    assert.equal(repeated.imported, 0)
    assert.equal(database.db.prepare('SELECT COUNT(*) AS n FROM evidence_fts').get().n, backgroundRows)
    samples.push({ first, repeated })
  } finally {
    database.close()
    rmSync(root, { recursive: true, force: true })
  }
}
console.log(JSON.stringify({ runtime: process.version, backgroundRows, indexRows, samples }, null, 2))
