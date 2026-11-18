import assert from 'node:assert/strict'
import test from 'node:test'
import { createFixture, loadJson } from './evaluation/fixture.js'
import { validateDataset, observedIds } from './evaluation/run.js'
import { recall, familyInterval, scoreAnswer } from './evaluation/score.js'

test('evaluation corpus keeps exact evidence and source families in one split', () => {
  const corpus = loadJson('corpus.json'), cases = loadJson('cases.json')
  assert.equal(validateDataset(corpus, cases).cases, 300)
  const invalid = structuredClone(cases)
  invalid.cases[0].split = 'holdout'
  assert.throws(() => validateDataset(corpus, invalid), /split mismatch/)
  const forged = structuredClone(corpus)
  forged.families[0].memories[0].evidence[0].quote = 'This quotation is deliberately absent from the synthetic source.'
  assert.throws(() => validateDataset(forged, cases), /Invalid exact quote/)
})

test('scoring distinguishes no gold evidence, missing retrieval and invalid model output', () => {
  assert.equal(recall(['a', 'a'], ['a', 'b']), 0.5)
  assert.equal(recall([], ['a']), 0)
  assert.equal(recall(['a'], []), null)
  const records = [{ familyId: 'a', value: 1 }, { familyId: 'a', value: 1 }, { familyId: 'b', value: 0 }]
  assert.equal(familyInterval(records, 'value').value, 0.5)
  assert.deepEqual(familyInterval(records, 'value'), familyInterval(records, 'value'))
  const item = { expected: { answerTerms: ['UTF-8'], abstain: false, evidenceMessageIds: ['e'], route: { decision: 'continue-existing', targetSessionTaskId: 't' } } }
  assert.equal(scoreAnswer(item, {}).parsed, false)
  assert.equal(scoreAnswer(item, { answer: 'UTF-8', abstain: false, evidenceMessageIds: [], route: { decision: 'new-task' } }).lexicalAnswerPass, false)
})

test('fixture preserves production candidate, expiry and archived-source retrieval semantics', async () => {
  const corpus = { datasetId: 'fixture-calibration', synthetic: true, families: [{ id: 'calibration', sessions: [{ id: 'native', sourceSystem: 'codex', title: 'Synthetic test',
    messages: [{ id: 'message', role: 'user', createdAt: '2026-01-01T00:00:00Z', text: 'Calibration uses SQLite. Pending requires review. Expired ended in February.' }] }],
  sessionTasks: [{ id: 'task', sessionId: 'native', title: 'Calibration', objective: 'Calibration storage', summary: 'Storage decisions', status: 'open', sourceMessageIds: ['message'] }],
  memories: [
    { id: 'current', text: 'Calibration uses SQLite.', status: 'user-stated', sessionTaskId: 'task', evidence: [{ messageId: 'message', quote: 'Calibration uses SQLite.' }] },
    { id: 'pending', text: 'Pending requires review.', status: 'candidate', sessionTaskId: 'task', evidence: [{ messageId: 'message', quote: 'Pending requires review.' }] },
    { id: 'expired', text: 'Expired ended in February.', status: 'user-stated', validUntil: '2026-02-01T00:00:00Z', sessionTaskId: 'task', evidence: [{ messageId: 'message', quote: 'Expired ended in February.' }] },
  ] }] }
  for (const coldBodies of [false, true]) {
    const fixture = await createFixture(corpus, { coldBodies })
    try {
      const value = await fixture.service.operate({ action: 'memory_search', query: 'SQLite' })
      const observed = observedIds('memory', value, fixture)
      assert.deepEqual(observed, { taskIds: ['task'], evidenceIds: ['message'], memoryIds: ['current'] })
      assert.equal(value.sessionTasks[0].sourceSystem, 'codex')
      assert.equal((await fixture.service.operate({ action: 'memory_search', query: 'Pending' })).memories.length, 0)
      assert.equal((await fixture.service.operate({ action: 'memory_search', query: 'Pending', includeCandidates: true })).memories.length, 1)
      assert.equal((await fixture.service.operate({ action: 'memory_search', query: 'Expired' })).memories.length, 0)
      assert.match((await fixture.service.operate({ action: 'memory_get', evidenceId: fixture.maps.messages.get('message') })).content, /SQLite/)
    } finally { await fixture.close() }
  }
})
