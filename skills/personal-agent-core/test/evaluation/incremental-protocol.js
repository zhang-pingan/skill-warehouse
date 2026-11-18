/** Fixed local index-write workloads; imported source text is immutable, memory text is revised. */
import { scaleProtocol, scaleMessage } from './scale-corpus.js'

export const incrementalProtocol = Object.freeze({
  version: 'b0-incremental-index-v1', expectedSourceSha256: '8f3c05d582491dab55e2f08da7866956888cf6992437781db217558a9271a3ad',
  scales: [1000, 10000, 50000], repetitions: 3, batchSize: 20,
  lanes: ['source-append', 'memory-append', 'memory-correct'], seedProtocol: scaleProtocol,
  sourceLengths: { 256: 14, 2048: 5, 8192: 1 }, memoryLengths: { 256: 14, 1024: 5, 2048: 1 },
  entries: { 'source-append': 'Ledger.ingestSource, same production writer used by history publication; queueExtraction=false.',
    'memory-append': 'PersonalAgentService.manageMemory remember, actor=operator.',
    'memory-correct': 'PersonalAgentService.manageMemory edit-record on 20 original seeded memories; production supersedes old records and retains evidence.' },
  included: 'Sequential await of 20 production operations, validation inside production calls, source hashing/blob writes, source/evidence and memory FTS writes, relationship/source links, transaction commits and normal WAL auto-checkpoint behavior. No outer transaction is added by the benchmark.',
  excluded: 'Seed construction, database copy/reopen, generated input construction, before/after correctness checks, explicit WAL checkpoint, teardown, native history discovery/staging, AI segmentation/extraction, model/network, GUI, full query latency, crash recovery and throughput under concurrent writers.',
  checkpoint: 'Explicit PRAGMA wal_checkpoint(TRUNCATE) is measured separately after timed writes and before post-write validation/storage accounting. Timed commits already use production WAL and synchronous settings.',
  correctness: 'Check exact source and memory content, content hashes, FTS MATCH membership, source-chain preservation and superseded state, plus recall of new content and exclusion of superseded content through production memory search. Check integrity and foreign keys after writes.',
  immutableSources: 'No original-history overwrite API is invented: source-append measures new immutable source ingestion; memory-correct measures editable memory text, retaining prior original source and memory record.',
  processes: 'Each scale/lane/repetition gets an independent process and private copy of the same seeded database. OS caches are not flushed; three model network lanes may run concurrently with occasional local file operations. No other CPU benchmark is scheduled.',
  limits: { batchMs: 10000, childMs: 120000 },
  reporting: 'Keep raw operation times, batch p50/p95 across three independent processes, checkpoint time, peak RSS and storage/index delta. Quantiles are descriptive with three samples. Any 10 s interrupted batch is right-censored, never assigned a numeric p95.',
})

/** Deterministic varied payloads, with per-record query tokens absent from the seed. */
export function incrementalPayloads(lane) {
  return Array.from({ length: incrementalProtocol.batchSize }, (_, index) => {
    const length = lane === 'source-append' ? (index < 14 ? 256 : index < 19 ? 2048 : 8192)
      : index < 14 ? 256 : index < 19 ? 1024 : 2048
    const token = `inc${lane.replaceAll('-', '')}record${String(index).padStart(2, '0')}`
    const body = scaleMessage(100000 + index).text
    const text = `${token} ${body.repeat(Math.ceil(length / body.length))}`.slice(0, length - 1) + '.'
    return { index, token, text, characters: text.length, targetTaskId: `scale-task-${index + 1}` }
  })
}
