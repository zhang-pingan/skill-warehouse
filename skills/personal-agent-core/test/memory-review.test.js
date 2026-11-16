import assert from 'node:assert/strict'
import test from 'node:test'
import { MemorySystem } from '../lib/memory-system.js'
import { PersonalAgentService } from '../lib/service.js'
import { fixture } from './helpers.js'

function setup(config = {}) {
  const f = fixture(config)
  f.ledger.clock = () => Date.parse('2026-11-13T12:00:00Z')
  let sequence = 0
  const service = { ...f, historyLifetime: new AbortController(), backgroundModelSelection: () => null,
    recordMemoryOperation: PersonalAgentService.prototype.recordMemoryOperation }
  const memory = service.memory = new MemorySystem(service)
  function source(text) {
    return f.ledger.ingestSource({ sourceSystem: 'dsh', sourceKind: 'message', sourceUri: 'dsh://memory-review',
      sourceLocator: `seq:${++sequence}`, sourceIdentity: String(sequence), text, authorRole: 'user', occurredAt: '2026-11-12T12:00:00Z' })
  }
  function record(content, options = {}) {
    const evidence = source(content)
    return memory.createRecord({ kind: 'fact', content, state: 'user-stated', createdBy: 'user', confidence: 1,
      evidence: [{ id: evidence.evidenceId, quote: content }], ...options })
  }
  return { ...f, service, memory, source, record }
}

test('memory recall requires all complete query terms and keeps retired records excluded even with candidates enabled', () => {
  const f = setup()
  try {
    f.record('Atlas uses Redis.')
    f.record('A different application uses SQLite.')
    const correct = f.record('Atlas uses SQLite.')
    assert.deepEqual(f.memory.search('Atlas SQLite').memories.map(row => row.id), [correct.id])
    assert.deepEqual(f.memory.search('Atla').memories, [])
    f.memory.retract(correct.id)
    assert.deepEqual(f.memory.search('Atlas SQLite', { includeCandidates: true }).memories, [])
  } finally { f.close() }
})

test('recall finds late Chinese fragments and applies the result limit after excluding temporary and split matches', () => {
  const f = setup()
  try {
    f.source('SQLite。Aurora。')
    const long = f.source(`${'其他文字'.repeat(200)}记忆检索使用关系图。`)
    assert.equal(f.ledger.search('记忆检索', { limit: 1 })[0].evidenceId, long.evidenceId)
    assert.match(f.ledger.search('记忆检索', { limit: 1 })[0].snippet, /记忆检索/u)
    const exact = f.source('SQLite Aurora 是同一个项目。')
    assert.deepEqual(f.ledger.search('SQLite Aurora', { limit: 1 }).map(row => row.evidenceId), [exact.evidenceId])
    const operation = f.service.recordMemoryOperation('memory_edit', 'SQLite Aurora operator metadata')
    assert.ok(f.ledger.search('SQLite Aurora', { includeTemporary: true }).every(row => row.evidenceId !== operation.evidenceId))
  } finally { f.close() }
})

test('user statements promote matching candidates, preserve retractions and keep FTS state authoritative', () => {
  const f = setup()
  try {
    const text = 'Atlas prefers SQLite.'
    const source = f.source(text)
    const candidate = f.memory.createRecord({ kind: 'fact', content: text, evidence: [{ id: source.evidenceId, quote: text }] })
    const stated = f.record(text)
    assert.equal(stated.id, candidate.id)
    assert.equal(stated.state, 'user-stated')
    f.memory.retract(stated.id)
    f.memory.createRecord({ kind: 'fact', content: text, evidence: [{ id: source.evidenceId, quote: text }] })
    assert.equal(f.database.db.prepare('SELECT memory_state FROM memory_fts WHERE memory_id=?').get(stated.id).memory_state, 'retracted')
    assert.deepEqual(f.memory.search('Atlas', { includeCandidates: true }).memories, [])
  } finally { f.close() }
})

test('corrections keep prior evidence on the superseded record and never create a self reference', async () => {
  const f = setup()
  try {
    const prior = f.record('Atlas uses Redis.')
    const next = await PersonalAgentService.prototype.manageMemory.call(f.service, { action: 'edit-record', memoryId: prior.id, content: 'Atlas uses SQLite.' })
    assert.equal(next.supersedesId, prior.id)
    assert.equal(f.memory.get(prior.id).state, 'superseded')
    assert.ok(next.sources.every(source => source.quote !== prior.content))
    const sameContent = f.memory.createRecord({ kind: 'fact', content: next.content, state: 'user-stated', createdBy: 'user', supersedesId: next.id,
      evidence: [{ id: next.sources[0].evidenceId, quote: next.content }] })
    assert.notEqual(sameContent.id, sameContent.supersedesId)
    assert.equal(f.database.db.prepare('PRAGMA foreign_key_check').all().length, 0)
  } finally { f.close() }
})

test('validity is normalized and checked, and relationship recall uses an eligible assertion at the requested time', () => {
  const f = setup()
  try {
    const source = f.source('Atlas uses SQLite.')
    const from = f.memory.ensureEntity({ name: 'Atlas', type: 'project', state: 'user-stated', evidenceId: source.evidenceId, quote: 'Atlas' })
    const to = f.memory.ensureEntity({ name: 'SQLite', type: 'tool', state: 'user-stated', evidenceId: source.evidenceId, quote: 'SQLite' })
    const spec = { kind: 'fact', content: 'Atlas uses SQLite.', entityId: from.id, predicate: 'uses', object: { entityId: to.id },
      state: 'user-stated', createdBy: 'user', evidence: [{ id: source.evidenceId, quote: 'Atlas uses SQLite.' }] }
    assert.throws(() => f.memory.createRecord({ ...spec, validFrom: 'garbage' }), /ISO timestamp/)
    assert.throws(() => f.memory.createRecord({ ...spec, validFrom: '2026-11-13T00:00:00Z', validTo: '2026-11-12T00:00:00Z' }), /end after/)
    const expired = f.memory.createRecord({ ...spec, validFrom: '2026-11-01T08:00:00+08:00', validTo: '2026-11-10T00:00:00Z' })
    assert.equal(expired.validFrom, '2026-11-01T00:00:00.000Z')
    assert.equal(f.memory.search('Atlas').relations.some(row => row.relation === 'uses'), false)
    const historical = f.memory.search('Atlas', { asOf: '2026-11-05T00:00:00Z' })
    assert.ok(historical.memories.some(row => row.id === expired.id))
    const relation = historical.relations.find(row => row.relation === 'uses')
    assert.equal(relation.memoryId, expired.id)
    assert.equal(relation.validTo, expired.validTo)
    assert.equal(relation.from.object, undefined)
    const current = f.memory.createRecord({ ...spec, validFrom: '2026-11-11T00:00:00Z' })
    assert.notEqual(current.id, expired.id)
    assert.ok(f.memory.search('Atlas').relations.some(row => row.relation === 'uses'))
    f.memory.createRecord({ ...spec, state: 'candidate', createdBy: 'model', content: 'Atlas possibly uses SQLite.' })
    f.memory.retract(current.id)
    assert.equal(f.memory.search('Atlas').relations.some(row => row.relation === 'uses'), false)
  } finally { f.close() }
})

test('redacted support is excluded from all recall lanes while source details remain inspectable', () => {
  const f = setup()
  try {
    const source = f.source('Atlas is a local assistant.')
    const entity = f.memory.ensureEntity({ name: 'Atlas', type: 'project', state: 'user-stated', evidenceId: source.evidenceId, quote: 'Atlas' })
    f.memory.createRecord({ kind: 'fact', content: 'Atlas is a local assistant.', entityId: entity.id, state: 'user-stated', createdBy: 'user', evidence: [{ id: source.evidenceId, quote: 'Atlas' }] })
    f.database.db.prepare("UPDATE evidence SET redaction_state='redacted' WHERE evidence_id=?").run(source.evidenceId)
    const result = f.memory.search('Atlas', { includeCandidates: true })
    for (const lane of ['experiences', 'memories', 'entities', 'relations']) assert.deepEqual(result[lane], [], lane)
  } finally { f.close() }
})

test('deleting an alias source removes aliases and preserves entities supported elsewhere', () => {
  const f = setup()
  try {
    const a = f.source('Atlas is also called 星图.')
    const b = f.source('Atlas is maintained locally.')
    const entity = f.memory.ensureEntity({ name: 'Atlas', type: 'project', evidenceId: a.evidenceId, quote: 'Atlas', aliases: ['星图'] })
    f.memory.ensureEntity({ name: 'Atlas', type: 'project', evidenceId: b.evidenceId, quote: 'Atlas' })
    assert.equal(f.memory.getEntity(entity.id).entityType, 'project')
    f.memory.removeExperience(a.evidenceId)
    assert.deepEqual(f.memory.getEntity(entity.id).aliases, [])
    assert.equal(f.memory.resolveCanonical('星图'), null)
    assert.equal(f.database.db.prepare('PRAGMA foreign_key_check').all().length, 0)
  } finally { f.close() }
})

test('AI extraction packs serialized input and leaves unselected jobs untouched', async () => {
  const f = setup({ analysisInputChars: 1000, memoryExtractionBatchSize: 12 })
  try {
    const a = f.source('A durable project fact. '.repeat(20))
    const b = f.source('Another useful project fact. '.repeat(20))
    let calls = 0
    f.service.analysisRuns = { async run(options, commit) {
      calls += 1
      assert.ok(JSON.stringify(options.input).length <= 1000)
      assert.equal(options.budgetMs, 600_000)
      return commit({ entities: [], memories: [], relations: [] })
    } }
    const result = await f.memory.run()
    assert.equal(calls, 1)
    assert.equal(result.processed, 1)
    const jobs = f.database.db.prepare('SELECT state,attempts FROM memory_extraction_jobs WHERE evidence_id IN (?,?) ORDER BY state').all(a.evidenceId, b.evidenceId)
    assert.deepEqual(jobs.map(row => [row.state, row.attempts]), [['done', 1], ['pending', 0]])
  } finally { f.close() }
})

test('oversized experiences are fully covered by exact excerpts and stay retryable after a later chunk fails', async () => {
  const f = setup({ analysisInputChars: 1000 })
  try {
    const text = '项目决定使用 SQLite。\\"😀'.repeat(150)
    const source = f.source(text)
    let seen = [], rejectSecond = true
    f.service.analysisRuns = { async run(options, commit) {
      assert.ok(JSON.stringify(options.input).length <= 1000)
      const input = options.input.evidence[0]
      assert.equal(text.slice(input.offset, input.offset + input.text.length), input.text)
      seen.push(input)
      if (rejectSecond && seen.length === 2) throw Error('Provider failed')
      return commit({ entities: [], memories: [], relations: [] })
    } }
    assert.equal((await f.memory.run()).processed, 0)
    assert.equal(f.database.db.prepare('SELECT state FROM memory_extraction_jobs WHERE evidence_id=?').get(source.evidenceId).state, 'pending')
    rejectSecond = false; seen = []
    assert.equal((await f.memory.run()).processed, 1)
    assert.equal(seen.map(row => row.text).join(''), text)
    assert.equal(f.database.db.prepare('SELECT state FROM memory_extraction_jobs WHERE evidence_id=?').get(source.evidenceId).state, 'done')
  } finally { f.close() }
})

test('invalid extraction cannot publish entities, memories or queue completion', async () => {
  const f = setup()
  try {
    const source = f.source('Atlas is local.')
    f.service.analysisRuns = { async run(options, commit) {
      return commit({ entities: [{ name: 'Atlas', type: 'project', attributes: {}, evidenceId: source.evidenceId, quote: 'Atlas' }],
        memories: [{ kind: 'fact', content: 'Atlas is local.', confidence: .5, entityName: 'Atlas', object: { entityId: 'invented-entity' }, evidence: [{ id: source.evidenceId, quote: 'Atlas' }] }], relations: [] })
    } }
    const result = await f.memory.run()
    assert.equal(result.processed, 0)
    assert.equal(f.memory.indexStatus().entities, 0)
    assert.equal(f.memory.indexStatus().memories, 0)
    assert.match(result.errors[0].last_error, /object.*entityId/)
  } finally { f.close() }
})

test('extraction binds declared canonical names without unrelated global alias collisions', async () => {
  const f = setup()
  try {
    const older = f.source('DeepSeek Harness (DSH) is a tool.')
    f.memory.ensureEntity({ name: 'DeepSeek Harness', type: 'tool', aliases: ['DSH'], evidenceId: older.evidenceId, quote: 'DeepSeek Harness (DSH)' })
    f.database.db.prepare("UPDATE memory_extraction_jobs SET state='done' WHERE evidence_id=?").run(older.evidenceId)
    const text = 'dsh installs dsh-startup-screen.'
    const source = f.source(text)
    f.service.analysisRuns = { async run(_options, commit) {
      return commit({ entities: [
        { name: 'dsh', type: 'tool', attributes: {}, evidenceId: source.evidenceId, quote: 'dsh' },
        { name: 'dsh-startup-screen', type: 'repository', attributes: {}, evidenceId: source.evidenceId, quote: 'dsh-startup-screen' },
      ], memories: [{ kind: 'fact', content: text, entityName: 'dsh', confidence: .8, evidence: [{ id: source.evidenceId, quote: text }] }],
      relations: [{ fromEntity: 'dsh', toEntity: 'dsh-startup-screen', relation: 'installs', evidenceId: source.evidenceId, quote: text }] })
    } }
    assert.equal((await f.memory.run()).processed, 1)
    assert.equal(f.memory.resolveCanonical('dsh'), null)
    const declared = f.database.db.prepare("SELECT entity_id FROM memory_entities WHERE entity_key='tool:dsh'").get()
    const records = f.database.db.prepare('SELECT entity_id,memory_state FROM memory_records').all()
    assert.equal(records.length, 2)
    assert.ok(records.every(row => row.entity_id === declared.entity_id && row.memory_state === 'candidate'))
    assert.equal(f.database.db.prepare('PRAGMA foreign_key_check').all().length, 0)
  } finally { f.close() }
})

test('extraction rejects undeclared references even when an identically named entity exists globally', async () => {
  const f = setup()
  try {
    const old = f.source('Atlas is a project.')
    f.memory.ensureEntity({ name: 'Atlas', type: 'project', attributes: {}, evidenceId: old.evidenceId, quote: 'Atlas' })
    f.service.analysisRuns = { async run(options, commit) {
      return commit({ entities: [], memories: [{ kind: 'fact', content: 'Atlas is a project.', entityName: 'Atlas', confidence: .8,
        evidence: [{ id: options.input.evidence[0].id, quote: 'Atlas' }] }], relations: [] })
    } }
    const result = await f.memory.run()
    assert.equal(result.processed, 0)
    assert.match(result.errors[0].last_error, /declared in this response/)
    assert.equal(f.memory.indexStatus().memories, 0)
  } finally { f.close() }
})

test('source rejection stays atomic and the next bounded attempt receives precise feedback', async () => {
  const f = setup()
  try {
    const text = 'Web 半侧由 `dsh.client` 声明，宿主按 package.json 的 dsh.client 自动组装 bundle。'
    const source = f.source(text)
    let calls = 0
    f.service.analysisRuns = { async run(options, commit) {
      calls++
      if (calls > 1) assert.ok(options.instructions.includes('memories[0].evidence[0]'))
      return commit({ entities: [], memories: [{ kind: 'fact', content: 'Web plugin is declared by dsh.client.', entityName: null, confidence: .8,
        evidence: [{ id: source.evidenceId, quote: calls === 1 ? text.replaceAll('`', '') : text }] }], relations: [] })
    } }
    const rejected = await f.memory.run()
    assert.equal(rejected.processed, 0)
    assert.equal(f.memory.indexStatus().memories, 0)
    assert.match(rejected.errors[0].last_error, /exact source support/)
    assert.equal((await f.memory.run()).processed, 1)
    assert.equal(f.memory.indexStatus().memories, 1)
    assert.equal(calls, 2)
  } finally { f.close() }
})

test('confirming a statement does not confirm unrelated candidate entity attributes', () => {
  const f = setup()
  try {
    const source = f.source('Atlas uses SQLite.')
    const entity = f.memory.ensureEntity({ name: 'Atlas', type: 'project', attributes: { purpose: 'local assistant' }, evidenceId: source.evidenceId, quote: 'Atlas' })
    const candidate = f.memory.createRecord({ kind: 'fact', content: 'Atlas uses SQLite.', entityId: entity.id, evidence: [{ id: source.evidenceId, quote: 'Atlas uses SQLite.' }] })
    const confirmation = f.service.recordMemoryOperation('memory_confirmation', `User confirmed memory ${candidate.id}`)
    f.memory.confirm(candidate.id, confirmation.evidenceId)
    assert.equal(f.memory.get(candidate.id).state, 'confirmed')
    assert.equal(f.memory.getEntity(entity.id).state, 'candidate')
    assert.deepEqual(f.memory.search('Atlas').entities, [])
    f.memory.confirmEntity(entity.id, confirmation.evidenceId)
    assert.equal(f.memory.search('Atlas').entities[0].state, 'confirmed')
  } finally { f.close() }
})

test('entity and task recall avoids substring prefixes and rejects aliases with redacted sources', () => {
  const f = setup()
  try {
    const a = f.source('Atlas is also named Aurora.')
    const b = f.source('Atlas is maintained locally.')
    f.memory.ensureEntity({ name: 'Atlas', type: 'project', state: 'user-stated', evidenceId: a.evidenceId, quote: 'Atlas', aliases: ['Aurora'] })
    f.memory.ensureEntity({ name: 'Atlas', type: 'project', state: 'user-stated', evidenceId: b.evidenceId, quote: 'Atlas' })
    f.ledger.createTask({ objective: 'Maintain Atlas memory', state: 'open' })
    assert.deepEqual(f.memory.search('Atla').entities, [])
    assert.deepEqual(f.memory.search('Atla').tasks, [])
    assert.equal(f.memory.search('Aurora').entities.length, 1)
    f.database.db.prepare("UPDATE evidence SET redaction_state='redacted' WHERE evidence_id=?").run(a.evidenceId)
    assert.deepEqual(f.memory.search('Aurora').entities, [])
    assert.equal(f.memory.search('Atlas').tasks.length, 1)
  } finally { f.close() }
})

test('naming an existing candidate does not promote its unconfirmed attributes, tags or aliases', () => {
  const f = setup()
  try {
    const proposal = f.source('Atlas is also called Comet and might use Redis.')
    const candidate = f.memory.ensureEntity({ name: 'Atlas', type: 'project', attributes: { database: 'Redis' }, tags: ['Redis'], aliases: ['Comet'], evidenceId: proposal.evidenceId, quote: 'Atlas is also called Comet and might use Redis.' })
    const user = f.source('Atlas is my application.')
    const stated = f.memory.ensureEntity({ name: 'Atlas', type: 'project', state: 'user-stated', evidenceId: user.evidenceId, quote: 'Atlas is my application.' })
    assert.equal(stated.id, candidate.id)
    assert.equal(stated.state, 'user-stated')
    assert.deepEqual(stated.attributes, {})
    assert.deepEqual(stated.tags, [])
    assert.deepEqual(f.memory.getEntity(candidate.id).aliases, [])
    f.memory.ensureEntity({ name: 'Atlas', type: 'project', attributes: { database: 'Redis' }, aliases: ['Comet'], evidenceId: proposal.evidenceId, quote: 'Atlas is also called Comet and might use Redis.' })
    assert.deepEqual(f.memory.getEntity(candidate.id).attributes, {})
    assert.deepEqual(f.memory.getEntity(candidate.id).aliases, [])
    assert.equal(f.memory.search('Comet').entities.length, 0)
  } finally { f.close() }
})

test('an input budget too small for source metadata records a bounded retryable queue error', async () => {
  const f = setup({ analysisInputChars: 1000, memoryExtractionRetryLimit: 2 })
  try {
    const evidence = f.ledger.ingestSource({ sourceSystem: 'external-source-'.repeat(100), sourceKind: 'message', sourceUri: 'external://large-metadata', sourceLocator: 'one', sourceIdentity: 'one', text: 'Atlas uses SQLite.' })
    f.service.analysisRuns = { run() { assert.fail('Cannot start a model request before input fits') } }
    const first = await f.memory.run()
    assert.equal(first.processed, 0)
    assert.match(first.errors[0].last_error, /metadata exceeds/)
    assert.equal(first.errors[0].state, 'pending')
    const second = await f.memory.run()
    assert.equal(second.errors[0].state, 'error')
    assert.equal(second.errors[0].evidence_id, evidence.evidenceId)
    assert.equal(second.errors[0].attempts, 2)
  } finally { f.close() }
})

test('failed batches retry one experience at a time while untouched experiences remain queued', async () => {
  const f = setup()
  try {
    const a = f.source('Atlas uses SQLite for persistence.')
    const b = f.source('Atlas supports offline use.')
    let calls = 0
    f.service.analysisRuns = { async run(options, commit) {
      calls++
      if (calls === 1) { assert.equal(options.input.evidence.length, 2); throw new Error('model output exceeds budget') }
      assert.equal(options.input.evidence.length, 1)
      commit({ entities: [], memories: [], relations: [] })
    } }
    await f.memory.run()
    assert.equal((await f.memory.run()).processed, 1)
    assert.deepEqual(f.database.db.prepare('SELECT state,COUNT(*) AS n FROM memory_extraction_jobs WHERE evidence_id IN (?,?) GROUP BY state ORDER BY state').all(a.evidenceId,b.evidenceId).map(row=>({...row})), [{state:'done',n:1},{state:'pending',n:1}])
  } finally { f.close() }
})

test('deleting one supporting experience keeps a relationship backed by its remaining source', () => {
  const f = setup()
  try {
    const text = 'Atlas uses SQLite.'
    const a = f.source(text), b = f.source(text)
    let atlas, sqlite
    for (const evidence of [a,b]) {
      atlas = f.memory.ensureEntity({ name: 'Atlas', type: 'project', state: 'user-stated', evidenceId: evidence.evidenceId, quote: text })
      sqlite = f.memory.ensureEntity({ name: 'SQLite', type: 'tool', state: 'user-stated', evidenceId: evidence.evidenceId, quote: text })
    }
    const record = f.memory.createRecord({ kind: 'fact', content: text, entityId: atlas.id, predicate: 'uses', object: {entityId:sqlite.id}, state: 'user-stated', createdBy: 'user', evidence: [a,b].map(source=>({id:source.evidenceId,quote:text})) })
    f.memory.removeExperience(a.evidenceId)
    assert.equal(f.memory.get(record.id).sources[0].evidenceId, b.evidenceId)
    const relation = f.memory.search('Atlas SQLite').relations.find(row=>row.relation==='uses')
    assert.ok(relation)
    assert.equal(relation.evidenceId, b.evidenceId)
    assert.equal(f.database.db.prepare('PRAGMA foreign_key_check').all().length, 0)
  } finally { f.close() }
})
