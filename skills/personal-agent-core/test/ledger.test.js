import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fixture, seedTask } from './helpers.js'

const at = '2026-11-09T00:00:00.000Z'

test('fresh schema seeds conservative feature flags without schema bookkeeping', () => {
  const f = fixture()
  try {
    const health = f.database.health()
    assert.equal(Object.hasOwn(health, 'schemaVersion'), false)
    assert.equal(f.database.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get(), undefined)
    assert.equal(health.flags['history.read'], true)
    assert.equal(health.flags['codex.daemon.connect'], false)
    assert.equal(health.flags['routing.resume'], false)
    assert.equal(Object.hasOwn(health.flags, 'housekeeper.core_read_model'), false)
    assert.equal(f.database.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='assistant_scan_state'").get(), undefined)
    assert.equal(f.database.integrityCheck().ok, true)
  } finally { f.close() }
})

test('nested ledger transactions remain inside the outer rollback boundary', () => {
  const f = fixture()
  try {
    assert.throws(() => f.database.transaction(() => {
      f.ledger.createTask({ objective: 'Must roll back', sourceKey: 'nested-rollback' })
      throw new Error('rollback outer transaction')
    }), /rollback outer transaction/)
    assert.equal(f.database.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE source_key='nested-rollback'").get().count, 0)
  } finally { f.close() }
})

test('nested savepoints roll back inner writes while preserving outer writes', () => {
  const f = fixture()
  try {
    f.database.transaction(() => {
      f.ledger.createTask({ objective: 'Outer write', sourceKey: 'nested-outer' })
      assert.throws(() => f.database.transaction(() => {
        f.ledger.createTask({ objective: 'Inner write', sourceKey: 'nested-inner' })
        throw new Error('rollback inner savepoint')
      }), /rollback inner savepoint/)
      f.ledger.createTask({ objective: 'Outer write after inner failure', sourceKey: 'nested-outer-after' })
    })
    assert.equal(f.database.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE source_key='nested-outer'").get().count, 1)
    assert.equal(f.database.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE source_key='nested-outer-after'").get().count, 1)
    assert.equal(f.database.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE source_key='nested-inner'").get().count, 0)
  } finally { f.close() }
})

test('immutable source revisions preserve provenance while blobs deduplicate', () => {
  const f = fixture()
  try {
    const first = f.ledger.ingestSource({ sourceSystem: 'codex', sourceKind: 'message', externalId: 'thread-1', sourceUri: '/tmp/a.jsonl', sourceLocator: 'line:2', sourceIdentity: 'r1', occurredAt: at, text: 'implemented durable ledger'})
    const duplicate = f.ledger.ingestSource({ sourceSystem: 'codex', sourceKind: 'message', externalId: 'thread-1', sourceUri: '/tmp/a.jsonl', sourceLocator: 'line:2', sourceIdentity: 'r1', occurredAt: at, text: 'implemented durable ledger'})
    const revision = f.ledger.ingestSource({ sourceSystem: 'codex', sourceKind: 'message', externalId: 'thread-1', sourceUri: '/tmp/a.jsonl', sourceLocator: 'line:2', sourceIdentity: 'r2', occurredAt: at, text: 'implemented durable ledger'})
    assert.equal(first.inserted, true)
    assert.equal(duplicate.inserted, false)
    assert.notEqual(first.sourceRecordId, revision.sourceRecordId)
    assert.equal(f.database.db.prepare('SELECT COUNT(*) AS n FROM source_records').get().n, 2)
    assert.equal(f.database.db.prepare('SELECT COUNT(*) AS n FROM source_blobs').get().n, 1)
    const results = f.ledger.search('durable ledger')
    assert.equal(results.length, 2)
    assert.equal(results[0].citation.uri, '/tmp/a.jsonl')
    assert.match(results[0].citation.locator, /line:2/)
  } finally { f.close() }
})

test('task transitions require the observed state and a valid transition', () => {
  const f = fixture()
  try {
    const task = f.ledger.createTask({ objective: 'state machine', sourceKey: 'test:state', state: 'open' })
    const active = f.ledger.transitionTask(task.taskId, 'active', task.state)
    assert.equal(active.state, 'active')
    assert.throws(() => f.ledger.transitionTask(task.taskId, 'completed', task.state), /state changed/)
    assert.throws(() => f.ledger.transitionTask(task.taskId, 'merged', active.state), /Invalid task transition/)
  } finally { f.close() }
})

test('task completion waits for passed acceptance evidence', () => {
  const f = fixture()
  try {
    const task = f.ledger.createTask({ objective: 'Verify worker output', sourceKey: 'test:acceptance', state: 'active', acceptance: ['Run the verification'] })
    const planned = f.ledger.planExecution({ taskId: task.taskId, executorKind: 'internal', method: 'internal/test', params: {}, dispatch: false })
    f.ledger.transitionExecution(planned.executionId, 'running')
    const running = f.database.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(planned.executionId)
    f.ledger.transitionExecution(planned.executionId, 'succeeded', { expectedState: running.execution_state })
    assert.throws(() => f.ledger.transitionTask(task.taskId, 'completed', task.state), /Task completion requires acceptance evidence/)
    assert.throws(() => f.ledger.recordAcceptance(planned.executionId, { state: 'passed' }), /Passed acceptance requires evidence/)
    const evidence = f.ledger.ingestSource({ sourceSystem: 'dsh', sourceKind: 'test', externalId: 'worker', sourceUri: 'dsh://test/worker', sourceLocator: 'execution:1', sourceIdentity: '1', text: 'verification passed', taskId: task.taskId, executionId: planned.executionId }).evidenceId
    f.ledger.recordAcceptance(planned.executionId, { state: 'passed', summary: 'Verification passed', evidenceIds: [evidence] })
    const accepted = f.ledger.getTask(task.taskId)
    const completed = f.ledger.transitionTask(task.taskId, 'completed', accepted.state)
    assert.equal(completed.state, 'completed')
    assert.equal(f.ledger.acceptanceStatus(task.taskId).results[0].state, 'passed')
  } finally { f.close() }
})

test('acceptance evidence is owned by the task and execution that produced it', () => {
  const f = fixture()
  try {
    const first = f.ledger.createTask({ objective: 'First task', acceptance: ['Verify output'], sourceKey: 'test:acceptance-owner:first', state: 'active' })
    const second = f.ledger.createTask({ objective: 'Second task', acceptance: ['Verify output'], sourceKey: 'test:acceptance-owner:second', state: 'active' })
    const finish = planned => {
      f.ledger.transitionExecution(planned.executionId, 'running')
      const current = f.database.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(planned.executionId)
      f.ledger.transitionExecution(planned.executionId, 'succeeded', { expectedState: current.execution_state })
    }
    const firstExecution = f.ledger.planExecution({ taskId: first.taskId, executorKind: 'internal', method: 'internal/first', params: {}, dispatch: false })
    const secondExecution = f.ledger.planExecution({ taskId: first.taskId, executorKind: 'internal', method: 'internal/second', params: {}, dispatch: false })
    const otherTaskExecution = f.ledger.planExecution({ taskId: second.taskId, executorKind: 'internal', method: 'internal/other', params: {}, dispatch: false })
    finish(firstExecution)
    finish(secondExecution)
    finish(otherTaskExecution)
    const firstEvidence = f.ledger.ingestSource({ sourceSystem: 'dsh', sourceKind: 'test', externalId: 'first', sourceUri: 'dsh://first', sourceLocator: 'result', sourceIdentity: '1', text: 'first result', taskId: first.taskId, executionId: firstExecution.executionId }).evidenceId
    const secondEvidence = f.ledger.ingestSource({ sourceSystem: 'dsh', sourceKind: 'test', externalId: 'second', sourceUri: 'dsh://second', sourceLocator: 'result', sourceIdentity: '1', text: 'second result', taskId: first.taskId, executionId: secondExecution.executionId }).evidenceId
    const otherEvidence = f.ledger.ingestSource({ sourceSystem: 'dsh', sourceKind: 'test', externalId: 'other', sourceUri: 'dsh://other', sourceLocator: 'result', sourceIdentity: '1', text: 'other result', taskId: second.taskId, executionId: otherTaskExecution.executionId }).evidenceId
    assert.throws(() => f.ledger.recordAcceptance(firstExecution.executionId, { state: 'passed', evidenceIds: [otherEvidence] }), /another task/)
    assert.throws(() => f.ledger.recordAcceptance(firstExecution.executionId, { state: 'passed', evidenceIds: [secondEvidence] }), /another execution/)
    const accepted = f.ledger.recordAcceptance(firstExecution.executionId, { state: 'passed', evidenceIds: [firstEvidence] })
    assert.deepEqual(accepted.evidenceIds, [firstEvidence])
  } finally { f.close() }
})

test('task steps enforce same-task dependencies and route feedback retains correction', () => {
  const f = fixture()
  try {
    const task = f.ledger.createTask({ objective: 'Plan a small change', sourceKey: 'test:steps', state: 'open' })
    const first = f.ledger.createTaskStep(task.taskId, { objective: 'Inspect the change' })
    const second = f.ledger.createTaskStep(task.taskId, { objective: 'Apply the change', dependencies: [first.stepId], acceptance: ['Run a focused test'] })
    assert.deepEqual(second.dependencies, [first.stepId])
    assert.throws(() => f.ledger.createTaskStep(task.taskId, { objective: 'Invalid dependency', dependencies: ['step:other'] }), /dependency does not exist/)
    const triggerId = f.ledger.recordTrigger({ dedupeKey: 'test:route-feedback', content: 'route this' })
    const routeDecisionId = f.ledger.saveRouteDecision({ semanticAction: 'read_only', deliveryAction: 'none', snapshot: {}, reasonCodes: [], inputSnapshotHash: 'hash', explanation: 'test' }, { triggerId, taskId: task.taskId })
    const feedback = f.ledger.recordRouteFeedback(routeDecisionId, { outcome: 'corrected', correction: { semanticAction: 'new_task' } })
    assert.equal(feedback.routeDecisionId, routeDecisionId)
    assert.deepEqual(f.database.db.prepare('SELECT correction_json FROM route_feedback WHERE feedback_id=?').get(feedback.feedbackId).correction_json, JSON.stringify({ semanticAction: 'new_task' }))
  } finally { f.close() }
})

test('temporary evidence stays out of default search without creating memories automatically', () => {
  const f = fixture()
  try {
    const project = f.ledger.upsertProject({ name: 'fixture', canonicalPath: f.root })
    const task = f.ledger.createTask({ objective: 'Remember project architecture', projectId: project.projectId, sourceKey: 'test:memory', state: 'active' })
    f.ledger.ingestSource({ sourceSystem: 'dsh', sourceKind: 'message', externalId: 'session', sourceUri: 'dsh://session', sourceLocator: 'seq:1', sourceIdentity: '1', text: 'weather today', taskId: task.taskId })
    const durable = f.ledger.ingestSource({ sourceSystem: 'dsh', sourceKind: 'message', externalId: 'session', sourceUri: 'dsh://session', sourceLocator: 'seq:2', sourceIdentity: '1', authorRole: 'user', text: 'Project architecture decision: use SQLite for the ledger', taskId: task.taskId })
    assert.equal(f.ledger.search('weather today').length, 0)
    assert.equal(f.ledger.search('weather today', { includeTemporary: true }).length, 1)
    assert.equal(f.database.db.prepare('SELECT memory_class FROM evidence WHERE evidence_id=?').get(durable.evidenceId).memory_class, 'recent')
    assert.equal(f.database.db.prepare('SELECT COUNT(*) AS n FROM memory_records').get().n, 0)
  } finally { f.close() }
})

test('Git origin identity survives a repository move and URL spelling changes', () => {
  const f = fixture()
  try {
    const first = path.join(f.root, 'first')
    const second = path.join(f.root, 'second')
    mkdirSync(path.join(first, '.git'), { recursive: true })
    mkdirSync(path.join(second, '.git'), { recursive: true })
    writeFileSync(path.join(first, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:Acme/Private-Agent.git\n')
    writeFileSync(path.join(second, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/private-agent.git\n')
    const original = f.ledger.upsertProject({ name: 'first', canonicalPath: first })
    const reopened = f.ledger.upsertProject({ name: 'second', canonicalPath: second })
    assert.equal(reopened.projectId, original.projectId)
    const identity = f.database.db.prepare('SELECT identity_kind,identity_value FROM projects WHERE project_id=?').get(original.projectId)
    assert.deepEqual({ ...identity }, { identity_kind: 'git-remote-origin', identity_value: 'github.com/acme/private-agent' })
    assert.deepEqual(new Set(f.database.db.prepare('SELECT canonical_path FROM project_locations WHERE project_id=?').all(original.projectId).map(row => row.canonical_path)), new Set([realpathSync(first), realpathSync(second)]))
  } finally { f.close() }
})

test('mutating execution requires persisted baseline and active write lease', () => {
  const f = fixture()
  try {
    const { task, location } = seedTask(f.ledger, f.root)
    assert.throws(() => f.ledger.planExecution({ taskId: task.taskId, executorKind: 'codex', method: 'thread/start', params: {}, mutatesWorkspace: true }), /requires location, baseline, and lease/)
    const lease = f.ledger.acquireLease({ resourceKey: `workspace:${location.location_id}`, locationId: location.location_id })
    const baselineId = f.ledger.saveBaseline(location.location_id, { capturedAt: at, gitHead: null, gitIndexTree: null, statusPorcelain: '', dirtyPaths: [], pathHashes: {}, captureComplete: true })
    const planned = f.ledger.planExecution({ taskId: task.taskId, executorKind: 'codex', method: 'thread/start', params: { cwd: f.root }, mutatesWorkspace: true, locationId: location.location_id, baselineId, leaseId: lease.leaseId })
    assert.ok(planned.executionId)
    assert.throws(() => f.ledger.acquireLease({ resourceKey: `workspace:${location.location_id}`, locationId: location.location_id }), error => error.code === 'LEASE_CONFLICT')
    const claimed = f.ledger.claimOutbox(1)
    assert.equal(claimed.length, 1)
    f.ledger.resolveOutbox(claimed[0].outbox_id, 'uncertain', { error: 'connection closed' })
    f.ledger.holdLease(lease.leaseId)
    assert.equal(f.database.health().outboxUncertain, 1)
    assert.equal(f.database.health().recoveryHolds, 1)
    assert.throws(() => f.ledger.releaseLease(lease.leaseId, 'guess'), /requires/)
    f.ledger.releaseLease(lease.leaseId, 'process_dead')
  } finally { f.close() }
})

test('backup manifest supports isolated restore validation and detects tampering', () => {
  const f = fixture()
  try {
    seedTask(f.ledger, f.root)
    const backupPath = path.join(f.root, 'backups', 'ledger.sqlite')
    const backup = f.database.backup(backupPath)
    assert.equal(Object.hasOwn(backup, 'schemaVersion'), false)
    const manifest = JSON.parse(readFileSync(backup.manifestPath, 'utf8'))
    assert.equal(Object.hasOwn(manifest, 'schemaVersion'), false)
    assert.equal(Object.hasOwn(manifest, 'version'), false)
    assert.equal(f.database.validateBackup(backup.path).counts.tasks, 1)
    const restored = f.database.restoreToNewPath(backup.path, path.join(f.root, 'restore', 'ledger.sqlite'))
    assert.equal(restored.ok, true)
    assert.equal(restored.counts.tasks, 1)
    appendFileSync(backup.path, 'tampered')
    assert.throws(() => f.database.validateBackup(backup.path), /size mismatch|hash mismatch|integrity check failed/)
  } finally { f.close() }
})

test('startup recovery invalidates stale approval handles and reconciles their execution once', () => {
  const f = fixture()
  try {
    const { task, location } = seedTask(f.ledger, f.root)
    const lease = f.ledger.acquireLease({ resourceKey: `workspace:${f.root}`, locationId: location.location_id })
    const baselineId = f.ledger.saveBaseline(location.location_id, { capturedAt: at, gitHead: null, gitIndexTree: null, statusPorcelain: '', dirtyPaths: [], pathHashes: {}, captureComplete: true })
    const planned = f.ledger.planExecution({ taskId: task.taskId, executorKind: 'codex', method: 'turn/start', params: {}, mutatesWorkspace: true, locationId: location.location_id, baselineId, leaseId: lease.leaseId })
    f.ledger.transitionExecution(planned.executionId, 'waiting_approval')
    f.database.db.prepare(`INSERT INTO approvals(approval_id,execution_id,adapter_instance_id,connection_epoch,external_request_id,kind,scope_json,risk_summary,approval_state,requested_at)
      VALUES('approval-1',?,?,?,?,?,?,?,?,?)`).run(planned.executionId, 'dead-adapter', 2, '41', 'item/commandExecution/requestApproval', '{}', 'test', 'pending', at)
    f.database.db.prepare(`INSERT INTO attention_items(attention_id,task_id,execution_id,kind,severity,summary,detail_json,state,created_at,updated_at)
      VALUES('attention-1',?,?, 'approval_required','high','approval','{}','open',?,?)`).run(task.taskId, planned.executionId, at, at)

    const recovered = f.database.recoverLocalState()
    assert.deepEqual(recovered, { uncertainOutbox: 0, reconcilingExecutions: 1, recoveryHolds: 1, invalidatedApprovals: 1 })
    assert.equal(f.database.db.prepare("SELECT approval_state FROM approvals WHERE approval_id='approval-1'").get().approval_state, 'invalidated')
    assert.equal(f.database.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(planned.executionId).execution_state, 'reconciling')
    assert.equal(f.database.db.prepare('SELECT lease_state FROM leases WHERE lease_id=?').get(lease.leaseId).lease_state, 'recovery_hold')
    assert.equal(f.database.db.prepare("SELECT state FROM attention_items WHERE attention_id='attention-1'").get().state, 'resolved')
    assert.deepEqual(f.database.recoverLocalState(), { uncertainOutbox: 0, reconcilingExecutions: 0, recoveryHolds: 0, invalidatedApprovals: 0 })
  } finally { f.close() }
})

test('startup recovery marks in-flight dispatch and write leases uncertain', () => {
  const f = fixture()
  try {
    const { task, location } = seedTask(f.ledger, f.root)
    const lease = f.ledger.acquireLease({ resourceKey: `workspace:${location.location_id}`, locationId: location.location_id })
    const baselineId = f.ledger.saveBaseline(location.location_id, { capturedAt: at, gitHead: null, gitIndexTree: null, statusPorcelain: '', dirtyPaths: [], pathHashes: {}, captureComplete: true })
    f.ledger.planExecution({ taskId: task.taskId, executorKind: 'codex', method: 'turn/start', params: {}, mutatesWorkspace: true, locationId: location.location_id, baselineId, leaseId: lease.leaseId })
    f.ledger.claimOutbox(1)
    const recovered = f.database.recoverLocalState()
    assert.equal(recovered.uncertainOutbox, 1)
    assert.equal(recovered.recoveryHolds, 1)
    assert.equal(f.database.db.prepare('SELECT lease_state FROM leases WHERE lease_id=?').get(lease.leaseId).lease_state, 'recovery_hold')
  } finally { f.close() }
})
