/** Deterministic late-result injection checks against the production ledger and extraction commit paths. */
import assert from 'node:assert/strict'
import path from 'node:path'
import { PersonalAgentService } from '../../lib/service.js'
import { resolveConfig } from '../../lib/config.js'

export async function runLifecycleGuards(root) {
  const service = new PersonalAgentService(resolveConfig({ dataDir: root, codexHome: path.join(root, 'codex'),
    historyRead: false, historySyncOnStart: false, memoryExtractionEnabled: false, inboxRetryEnabled: false, cleanupEnabled: false }))
  await service.initialize()
  const rows = [], history = service.ledger.history, db = service.database.db
  try {
    const session = service.ledger.upsertSession({ system: 'dsh', externalId: 'synthetic-version-race', cwd: root })
    const stage = (text, index) => history.stage({ sessionRefId: session.sessionRefId, sourceSystem: 'dsh', sourceKind: 'message',
      sourceUri: 'synthetic://lifecycle/version', sourceLocator: `seq:${index}`, sourceIdentity: `v:${index}`, authorRole: 'user', text,
      occurredAt: `2026-11-18T00:00:0${index}.000Z` })
    stage('Synthetic Atlas uses port 4100.', 0)
    history.complete(session.sessionRefId)
    service.analysisRuns = { async run(options, commit) { return commit(options.input.messages ? {
      tasks: [{ id: 'new:synthetic', title: 'Synthetic Atlas deployment', goal: 'Configure Atlas', summary: 'Atlas uses port 4100.', state: 'open' }],
      assignments: options.input.messages.map(message => ({ messageId: message.messageId, taskIds: ['new:synthetic'], status: 'assigned' })),
    } : { merges: [] }) } }
    assert.equal((await history.segmentNext()).published, true)
    const task = history.list().records[0], initial = history.get(task.id)
    const calls = []
    service.analysisRuns = { async run(options, commit) {
      const oldVersion = db.prepare('SELECT context_version FROM session_tasks WHERE session_task_id=?').get(task.id).context_version
      db.prepare("UPDATE session_tasks SET summary='User corrected Atlas port to 4201.' WHERE session_task_id=?").run(task.id)
      history.refreshTasks([task.id])
      const oldEvidence = options.input.evidence[0]
      calls.push({ oldVersion, submitted: 'Synthetic Atlas uses port 4100.', evidenceId: oldEvidence.id })
      return commit({ entities: [], memories: [{ kind: 'fact', content: 'Synthetic Atlas uses port 4100.', entityName: null,
        confidence: 0.8, evidence: [{ id: oldEvidence.id, quote: 'Synthetic Atlas uses port 4100.' }] }], relations: [] })
    } }
    const stale = await service.memory.runBatch()
    const after = db.prepare('SELECT context_version,extracted_version,attempts,last_error,summary FROM session_tasks WHERE session_task_id=?').get(task.id)
    assert.notEqual(after.context_version, initial.version)
    assert.equal(after.extracted_version, null); assert.equal(after.attempts, 0); assert.equal(after.last_error, null)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_records').get().n, 0)
    assert.throws(() => history.get(task.id, { version: initial.version }), /changed during paging/u)
    rows.push({ caseId: 'stale-extraction-and-versioned-read', ok: true, initialVersion: initial.version, calls, result: stale, current: after })

    service.analysisRuns = { async run(_options, commit) { return commit({ entities: [], memories: [], relations: [] }) } }
    const refreshed = await service.memory.runBatch()
    assert.equal(refreshed.processed, 1)
    const latest = db.prepare('SELECT context_version,extracted_version FROM session_tasks WHERE session_task_id=?').get(task.id)
    assert.equal(latest.context_version, latest.extracted_version)
    rows.push({ caseId: 'current-extraction-after-stale-result', ok: true, result: refreshed, versions: latest })

    stage('New source revision one.', 1); history.complete(session.sessionRefId)
    service.analysisRuns = { async run(options, commit) {
      if (options.input.messages) return commit({ tasks: [], assignments: options.input.messages.map(message => ({ messageId: message.messageId, taskIds: [task.id], status: 'assigned' })) })
      stage('New source revision two arrived before reconciliation returned.', 2)
      return commit({ merges: [] })
    } }
    const segmented = await history.segmentNext()
    const revision = db.prepare('SELECT revision,published_revision,attempts,last_error FROM history_sessions WHERE session_ref_id=?').get(session.sessionRefId)
    assert.ok(revision.revision > revision.published_revision)
    assert.equal(revision.attempts, 0); assert.equal(revision.last_error, null)
    rows.push({ caseId: 'stale-segmentation-remains-unpublished', ok: true, result: segmented, revision })

    const ledger = service.ledger, executionTask = ledger.createTask({ objective: 'Verify two current acceptance criteria', state: 'active', acceptance: ['Tests pass', 'Artifact exists'] })
    const attempt = () => {
      const run = ledger.planExecution({ taskId: executionTask.taskId, executorKind: 'internal', method: 'internal/verify', params: {}, dispatch: false })
      ledger.transitionExecution(run.executionId, 'running'); ledger.transitionExecution(run.executionId, 'succeeded')
      const evidenceId = ledger.ingestSource({ sourceSystem: 'dsh', sourceKind: 'verification', sourceUri: 'synthetic://lifecycle/acceptance',
        sourceLocator: run.executionId, sourceIdentity: run.executionId, text: 'Synthetic observed verification output', taskId: executionTask.taskId, executionId: run.executionId }).evidenceId
      return { ...run, evidenceId }
    }
    const accept = (run, id) => ledger.recordAcceptance(run.executionId, { state: 'passed', criterionId: id, evidenceIds: [run.evidenceId] })
    const first = attempt(); accept(first, '0'); accept(first, '1')
    const second = attempt()
    assert.throws(() => ledger.transitionTask(executionTask.taskId, 'completed', 'active'), /acceptance evidence/u)
    accept(first, '0'); accept(first, '1')
    assert.throws(() => ledger.transitionTask(executionTask.taskId, 'completed', 'active'), /acceptance evidence/u)
    accept(second, '0')
    assert.throws(() => ledger.transitionTask(executionTask.taskId, 'completed', 'active'), /every current criterion/u)
    assert.throws(() => ledger.recordAcceptance(second.executionId, { state: 'passed', criterionId: '1', evidenceIds: [first.evidenceId] }), /another execution/u)
    accept(second, '1')
    assert.equal(ledger.transitionTask(executionTask.taskId, 'completed', 'active').state, 'completed')
    assert.deepEqual(ledger.getTask(executionTask.taskId).acceptance, ['Tests pass', 'Artifact exists'])
    rows.push({ caseId: 'old-results-cannot-complete-latest-attempt', ok: true, first, second, status: ledger.acceptanceStatus(executionTask.taskId) })
    return { ok: true, mode: 'deterministic late-result injection; production ledger and commit checks; no model calls', rows }
  } finally { await service.dispose() }
}
