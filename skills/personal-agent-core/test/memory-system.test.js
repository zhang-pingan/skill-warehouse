import assert from 'node:assert/strict'
import test from 'node:test'
import { MemorySystem } from '../lib/memory-system.js'
import { PersonalAgentService } from '../lib/service.js'
import { fixture } from './helpers.js'

function memoryFixture() {
  const f = fixture()
  const service = {
    ledger: f.ledger,
    database: f.database,
    config: f.config,
    historyLifetime: new AbortController(),
    recordMemoryOperation: PersonalAgentService.prototype.recordMemoryOperation,
    dashboardTaskDetail: () => null,
  }
  service.memory = new MemorySystem(service)
  return { ...f, service, manage: args => PersonalAgentService.prototype.manageMemory.call(service, args) }
}

function ingest(ledger, text, sourceType = 'message') {
  return ledger.ingestSource({
    sourceSystem: 'dsh', sourceKind: sourceType, externalId: 'session-1', sourceUri: 'dsh://session/session-1',
    sourceLocator: 'message:1', sourceIdentity: sourceType, occurredAt: '2026-11-12T12:00:00.000Z',
    text, normalizedPayload: {}, trustLevel: 'user', authorRole: 'user', sourceType, memory: 'durable',
  })
}

test('memory browser lists every lane with empty filters and rejects punctuation-only matches', () => {
  const f = memoryFixture()
  try {
    const text = 'Aurora is a project using SQLite for durable local memory.'
    const source = ingest(f.ledger, text)
    const project = f.service.memory.ensureEntity({ name: 'Aurora', type: 'project', state: 'user-stated', evidenceId: source.evidenceId, quote: 'Aurora' })
    const tool = f.service.memory.ensureEntity({ name: 'SQLite', type: 'tool', state: 'user-stated', evidenceId: source.evidenceId, quote: 'SQLite' })
    const fact = f.service.memory.createRecord({
      kind: 'fact', content: text, entityId: project.id, predicate: 'uses', object: { entityId: tool.id, entityName: tool.name },
      state: 'user-stated', confidence: 1, createdBy: 'user', evidence: [{ id: source.evidenceId, quote: text }],
    })
    f.service.memory.createRecord({
      kind: 'fact', content: text, entityId: project.id, predicate: 'may-use', object: { entityId: tool.id, entityName: tool.name },
      state: 'candidate', confidence: 0.5, createdBy: 'model', evidence: [{ id: source.evidenceId, quote: text }],
    })
    const listed = f.service.memory.list({})
    assert.ok(listed.records.every(record => record.type !== 'experience'))
    assert.ok(listed.records.some(record => record.type === 'memory' && record.id === fact.id))
    assert.ok(listed.records.some(record => record.type === 'entity' && record.id === project.id))
    assert.ok(listed.graphRecords.some(record => record.type === 'relation' && record.relation === 'uses'
      && record.fromKind === 'entity' && record.fromId === project.id
      && record.toKind === 'entity' && record.toId === tool.id))
    for (const type of ['all','experience','memory','entity','relation','task']) {
      assert.deepEqual(f.service.memory.list({ type, query: '!!!' }).records, [], type)
    }
    assert.deepEqual(f.service.memory.search('!!!').memories, [])
    const recalled = f.service.memory.search('Aurora', { sourceSystem: 'dsh' })
    assert.deepEqual(recalled.memories.map(memory => memory.id), [fact.id])
    assert.equal(recalled.experiences.length, 0)
    assert.ok(recalled.relations.some(relation => relation.relation === 'uses'))
    assert.ok(recalled.relations.every(relation => relation.relation !== 'supports' && relation.relation !== 'may-use'))
    assert.deepEqual(f.service.memory.search('Aurora', { sourceSystem: 'codex' }).experiences, [])
  } finally { f.close() }
})

test('operator can edit experience annotations without changing its imported source text', async () => {
  const f = memoryFixture()
  try {
    const sourceText = 'The assistant discussed the Aurora project.'
    const source = ingest(f.ledger, sourceText)
    const project = f.service.memory.ensureEntity({ name: 'Aurora', type: 'project', state: 'user-stated', evidenceId: source.evidenceId, quote: 'Aurora project' })
    const updated = await f.manage({ action: 'edit-experience', evidenceId: source.evidenceId, note: 'Project planning', tags: ['project', 'planning'], entityIds: [project.id] })
    assert.equal(updated.content, sourceText)
    assert.equal(updated.note, 'Project planning')
    assert.deepEqual(updated.tags, ['project', 'planning'])
    assert.deepEqual(updated.associatedEntityIds, [project.id])
    assert.equal(f.service.memory.list({ type: 'experience', query: 'planning' }).records.length, 1)
  } finally { f.close() }
})

test('deleting the last source removes source-dependent memories and unreferenced entities', () => {
  const f = memoryFixture()
  try {
    const text = 'Aurora uses SQLite.'
    const source = ingest(f.ledger, text)
    const project = f.service.memory.ensureEntity({ name: 'Aurora', type: 'project', evidenceId: source.evidenceId, quote: 'Aurora' })
    const memory = f.service.memory.createRecord({ kind: 'fact', content: text, entityId: project.id, evidence: [{ id: source.evidenceId, quote: text }] })
    f.service.memory.removeExperience(source.evidenceId)
    assert.equal(f.service.memory.get(memory.id), null)
    assert.equal(f.service.memory.getEntity(project.id), null)
    assert.equal(f.service.memory.getExperience(source.evidenceId), null)
    assert.equal(f.database.integrityCheck().ok, true)
  } finally { f.close() }
})
