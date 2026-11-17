import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../lib/config.js'
import { PersonalAgentService } from '../lib/service.js'

async function serviceFixture(overrides = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'personal-agent-service-test-'))
  const config = resolveConfig({ dataDir: path.join(root, 'data'), codexHome: path.join(root, 'codex'), allowedWorkspaceRoots: [root], codexWorkerEnabled: true, ...overrides })
  const service = new PersonalAgentService(config)
  await service.initialize()
  return {
    root,
    service,
    async close() {
      await service.dispose()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function seedExecution(service, root, { state = 'running', mutatesWorkspace = false } = {}) {
  const project = service.ledger.upsertProject({ name: 'fixture', canonicalPath: root })
  const task = service.ledger.createTask({ objective: 'Verify service projections', acceptance: ['Verify service output'], projectId: project.projectId, sourceKey: `service:${Math.random()}` })
  let lease = null
  let baselineId = null
  if (mutatesWorkspace) {
    const location = service.database.db.prepare('SELECT canonical_path FROM project_locations WHERE location_id=?').get(project.locationId)
    lease = service.ledger.acquireLease({ resourceKey: `workspace:${location.canonical_path}`, locationId: project.locationId })
    baselineId = service.ledger.saveBaseline(project.locationId, {
      capturedAt: new Date().toISOString(), gitHead: null, gitIndexTree: null, statusPorcelain: '', dirtyPaths: [], pathHashes: {}, captureComplete: true,
    })
  }
  const planned = service.ledger.planExecution({
    taskId: task.taskId,
    executorKind: 'codex',
    locationId: mutatesWorkspace ? project.locationId : null,
    baselineId,
    leaseId: lease?.leaseId ?? null,
    method: 'turn/start',
    params: { threadId: 'thread-1', input: [{ type: 'text', text: 'continue', text_elements: [] }] },
    mutatesWorkspace,
  })
  if (state !== 'dispatch_pending') service.ledger.transitionExecution(planned.executionId, state)
  const thread = service.ledger.upsertSession({ system: 'codex', externalId: 'thread-1', sourceKind: 'app_server_thread', durability: 'durable' })
  const turn = service.ledger.upsertSession({ system: 'codex', externalId: 'turn-1', sourceKind: 'app_server_turn', durability: 'durable' })
  service.ledger.attachExecutionSession(planned.executionId, thread.sessionRefId)
  service.ledger.attachExecutionSession(planned.executionId, turn.sessionRefId)
  return { task, planned, lease }
}

test('assistant recalls historical task summaries and grouped source matches independently of the execution ledger', async () => {
  const f=await serviceFixture()
  try {
    const history=f.service.ledger.history
    for(const system of ['dsh','codex']) {
      const session=f.service.ledger.upsertSession({system,externalId:system+'-tutor',cwd:f.root})
      history.stage({sessionRefId:session.sessionRefId,sourceSystem:system,sourceKind:'message',sourceUri:system+'://tutor',sourceLocator:'seq:1',sourceIdentity:'one',text:'高中数学陪练采用逐题讲解。',authorRole:'user',occurredAt:'2026-11-13T00:00:00Z'})
      history.complete(session.sessionRefId)
    }
    f.service.analysisRuns.run=async(options,commit)=>commit(!options.input.messages?{merges:[]}:{tasks:[{id:'new:tutor',title:'高中数学陪练',goal:'高中数学陪练',summary:'采用逐题讲解',state:'open'}],assignments:options.input.messages.map(message=>({messageId:message.messageId,taskIds:['new:tutor'],status:'assigned'}))})
    await history.segmentNext();await history.segmentNext()
    assert.deepEqual((await f.service.operate({action:'list_tasks'})).tasks,[])
    const found=await f.service.operate({action:'search_history',query:'逐题讲解',sourceSystem:'codex'})
    assert.equal(found.results.length,1);assert.equal(found.results[0].sessionId,'codex-tutor')
    assert.equal(found.results[0].matchCount,1)
    const detail=await f.service.operate({action:'memory_get',sessionTaskId:found.results[0].id})
    assert.equal(detail.messages.length,1)
    assert.match((await f.service.operate({action:'memory_get',evidenceId:detail.messages[0].evidenceId})).content,/逐题讲解/)
    assert.equal((await f.service.operate({action:'memory_search',query:'高中 陪练'})).sessionTasks.length,2)
    assert.equal((await f.service.operate({action:'search_history',query:'逐题讲解',from:'2026-11-14T00:00:00Z'})).results.length,0)
  }finally{await f.close()}
})

test('memory extraction bounds candidate output and reports the invalid relation path', async () => {
  const f = await serviceFixture()
  try {
    const rows = [{ evidence_id: 'source-1', text: 'Atlas supports SQLite.' }]
    assert.throws(() => f.service.memory.validateExtraction({ entities: [], memories: [], relations: [
      { fromEntity: 'Atlas', toEntity: 'SQLite', relation: 'supports', evidenceId: 'source-1', quote: 'not in the source' },
    ] }, rows), /Invalid extracted relation at relations\[0\]/)
    assert.throws(() => f.service.memory.validateExtraction({ entities: Array(7), memories: [], relations: [] }, rows), /at most 6 entities/)
  } finally { await f.close() }
})

test('tracked background operations invoke callbacks and settle before disposal', async () => {
  const f = await serviceFixture()
  try {
    let invoked = 0
    const result = await f.service.trackOperation(async () => { invoked += 1; return 'done' }, 'fixture operation')
    assert.equal(result, 'done')
    assert.equal(invoked, 1)
    await f.service.dispose()
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('history calls coalesce and disposal cancels the owned import before closing SQLite', async t => {
  const f = await serviceFixture()
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  let calls = 0
  let dshCalls = 0
  t.mock.method(f.service.codexImporter, 'run', async ({ checkpoint }) => {
    calls += 1
    entered.resolve()
    await release.promise
    await checkpoint()
    return {}
  })
  t.mock.method(f.service.dshImporter, 'importFromPersistence', async () => { dshCalls += 1; return {} })
  try {
    const first = f.service.importHistory()
    const second = f.service.importHistory()
    const outcomes = Promise.allSettled([first, second])
    await entered.promise
    const stopping = f.service.dispose()
    assert.equal(f.service.database.closed, false)
    release.resolve()
    await stopping
    const results = await outcomes
    assert.equal(calls, 1)
    assert.equal(dshCalls, 0)
    assert.ok(results.every(result => result.status === 'rejected' && result.reason.name === 'AbortError'))
    assert.equal(f.service.database.closed, true)
    await assert.rejects(f.service.importHistory(), { name: 'AbortError' })
  } finally {
    release.resolve()
    await f.close()
  }
})

test('Codex history import waits for its switch and the switch removes local history mirrors', async t => {
  const f = await serviceFixture({ codexWorkerEnabled: false })
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  t.mock.method(f.service.codexImporter, 'run', async () => {
    entered.resolve()
    await release.promise
    return { index: { imported: 0 }, rollouts: { evidenceImported: 0 } }
  })
  try {
    const enabling = f.service.setCodexEnabled(true)
    await entered.promise
    assert.equal(f.service.runtimeSettingsView().settings.codexWorkerEnabled, false)
    assert.throws(() => f.service.setCodexEnabled(false), /currently being changed/)
    release.resolve()
    const enabled = await enabling
    assert.equal(enabled.enabled, true)
    assert.equal(f.service.config.codexWorkerEnabled, true)

    const session = f.service.ledger.upsertSession({ system: 'codex', externalId: 'history-thread', sourceKind: 'session_index', durability: 'durable' })
    const task = f.service.ledger.createTask({ objective: 'Imported Codex history', sourceKey: 'codex-thread:history-thread', state: 'candidate' })
    const source = f.service.ledger.ingestSource({
      sourceSystem: 'codex', sourceKind: 'session_index', externalId: 'history-thread', sourceUri: '/tmp/session_index.jsonl',
      sourceLocator: 'line:1', sourceIdentity: 'history-thread-v1', text: 'Codex-only history marker',
      sessionRefId: session.sessionRefId, taskId: task.taskId, sourceType: 'session_title',
    })
    assert.equal(source.inserted, true)
    assert.equal(f.service.ledger.search('Codex-only history marker').length, 1)
    f.service.database.db.prepare(`INSERT INTO import_cursors(importer_id,source_uri,source_instance_id,cursor_json,last_attempted_at,last_successful_at)
      VALUES('codex-rollout','/tmp/rollout.jsonl','/tmp/rollout.jsonl','{}',?,?)`).run(new Date().toISOString(), new Date().toISOString())

    const disabled = await f.service.setCodexEnabled(false)
    assert.equal(disabled.enabled, false)
    assert.equal(f.service.config.codexWorkerEnabled, false)
    assert.equal(f.service.ledger.search('Codex-only history marker').length, 0)
    assert.equal(f.service.database.db.prepare("SELECT COUNT(*) AS count FROM source_records WHERE source_system='codex' AND source_kind='session_index'").get().count, 0)
    assert.equal(f.service.database.db.prepare("SELECT COUNT(*) AS count FROM session_refs WHERE system='codex' AND external_id='history-thread'").get().count, 0)
    assert.equal(f.service.database.db.prepare("SELECT COUNT(*) AS count FROM import_cursors WHERE importer_id IN ('codex-session-index','codex-rollout')").get().count, 0)
    assert.equal(f.service.database.db.prepare("SELECT COUNT(*) AS count FROM import_cursors WHERE importer_id='codex-rollout'").get().count, 0)
    assert.throws(() => f.service.updateRuntimeSettings({ codexWorkerEnabled: true }), /Use the Codex settings switch/)
  } finally {
    release.resolve()
    await f.close()
  }
})

test('scheduled history import skips Codex while the Codex switch is off', async t => {
  const f = await serviceFixture({ codexWorkerEnabled: false })
  let codexImports = 0
  let dshImports = 0
  t.mock.method(f.service.codexImporter, 'run', async () => { codexImports += 1; return {} })
  t.mock.method(f.service.dshImporter, 'importFromPersistence', async () => { dshImports += 1; return { supported: false } })
  try {
    const result = await f.service.importHistory()
    assert.deepEqual(result.codex, { skipped: true, reason: 'codex-disabled' })
    assert.equal(codexImports, 0)
    assert.equal(dshImports, 1)
    assert.equal((await f.service.memory.run()).processed, 0)
  } finally { await f.close() }
})

test('disabling Codex waits for an active Codex rollout scan before clearing its records', async t => {
  const f = await serviceFixture({ codexWorkerEnabled: true })
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  let finished = false
  try {
    const scan = f.service.runCodexHistoryScan(async () => { entered.resolve(); await release.promise; return 1 })
    await entered.promise
    const disabling = f.service.setCodexEnabled(false).then(value => { finished = true; return value })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.service.config.codexWorkerEnabled, false)
    assert.equal(finished, false)
    release.resolve()
    assert.equal(await scan, 1)
    assert.equal((await disabling).enabled, false)
    assert.equal(finished, true)
  } finally {
    release.resolve()
    await f.close()
  }
})

test('terminal Codex notification completes execution and releases write lease', async () => {
  const f = await serviceFixture()
  try {
    const seeded = seedExecution(f.service, f.root, { mutatesWorkspace: true })
    f.service.projectCodexNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } })
    const execution = f.service.database.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(seeded.planned.executionId)
    const lease = f.service.database.db.prepare('SELECT lease_state,release_reason FROM leases WHERE lease_id=?').get(seeded.lease.leaseId)
    assert.equal(execution.execution_state, 'succeeded')
    assert.equal(lease.lease_state, 'released')
    assert.equal(lease.release_reason, 'terminal')
    assert.equal(f.service.ledger.getTask(seeded.task.taskId).state, 'waiting')
  } finally { await f.close() }
})

test('early turn notification heartbeats a pending execution and write lease', async () => {
  const f = await serviceFixture()
  try {
    const seeded = seedExecution(f.service, f.root, { state: 'dispatch_pending', mutatesWorkspace: true })
    f.service.projectCodexNotification({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress' } } })
    const execution = f.service.database.db.prepare('SELECT execution_state,heartbeat_at FROM executions WHERE execution_id=?').get(seeded.planned.executionId)
    const lease = f.service.database.db.prepare('SELECT heartbeat_at,expires_at FROM leases WHERE lease_id=?').get(seeded.lease.leaseId)
    assert.equal(execution.execution_state, 'running')
    assert.ok(execution.heartbeat_at)
    assert.ok(lease.heartbeat_at)
    assert.ok(lease.expires_at > lease.heartbeat_at)
  } finally { await f.close() }
})

test('string approval request ids preserve exact JSON-RPC identity during retry and decision', async () => {
  const f = await serviceFixture()
  try {
    const seeded = seedExecution(f.service, f.root, { state: 'dispatch_pending' })
    const replies = []
    f.service.approvals.adapter = { adapterInstanceId: 'adapter-string-id', connectionEpoch: 7, replyToServerRequest: async (handle, response) => replies.push({ handle, response }) }
    const request = { inboxId: null, handle: { adapterInstanceId: 'adapter-string-id', connectionEpoch: 7, externalRequestId: '001' }, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1' } }
    await f.service.onServerRequest(request)
    const approval = f.service.database.db.prepare('SELECT approval_id FROM approvals').get()
    await f.service.operate({ action: 'decide_approval', approvalId: approval.approval_id, decision: 'approved' }, { actor: 'test-user', approvalAuthority: true })
    assert.equal(replies.at(-1).handle.externalRequestId, '001')
  } finally { await f.close() }
})

test('early approval request persists attention and resumes after a decision', async () => {
  const f = await serviceFixture()
  try {
    const seeded = seedExecution(f.service, f.root, { state: 'dispatch_pending' })
    const replies = []
    const adapter = { adapterInstanceId: 'adapter-1', connectionEpoch: 3, replyToServerRequest: (handle, response) => replies.push({ handle, response }), close: async () => {} }
    f.service.adapter = adapter
    f.service.approvals.adapter = adapter
    const approvalRequest = {
      handle: { adapterInstanceId: 'adapter-1', connectionEpoch: 3, externalRequestId: 41 },
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', cwd: f.root, command: ['echo', 'ok'] },
    }
    await f.service.onServerRequest(approvalRequest)
    await f.service.onServerRequest(approvalRequest)
    const approval = f.service.database.db.prepare('SELECT approval_id,approval_state FROM approvals WHERE execution_id=?').get(seeded.planned.executionId)
    assert.equal(f.service.database.db.prepare('SELECT COUNT(*) AS count FROM approvals WHERE execution_id=?').get(seeded.planned.executionId).count, 1)
    assert.equal(f.service.database.db.prepare("SELECT COUNT(*) AS count FROM attention_items WHERE state='open' AND kind='approval_required'").get().count, 1)
    assert.equal(approval.approval_state, 'pending')
    assert.equal(f.service.database.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(seeded.planned.executionId).execution_state, 'waiting_approval')
    const result = await f.service.operate({ action: 'decide_approval', approvalId: approval.approval_id, decision: 'approved' }, { actor: 'test-user', approvalAuthority: true })
    assert.equal(result.state, 'approved')
    assert.equal(replies.length, 1)
    assert.deepEqual(replies[0].response, { decision: 'accept' })
    assert.equal(f.service.database.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(seeded.planned.executionId).execution_state, 'running')
    assert.equal(f.service.database.db.prepare("SELECT COUNT(*) AS count FROM attention_items WHERE state='open'").get().count, 0)
  } finally { await f.close() }
})

test('denied approval cancels the waiting execution instead of resuming it', async () => {
  const f = await serviceFixture()
  try {
    const seeded = seedExecution(f.service, f.root, { state: 'dispatch_pending' })
    const replies = []
    const adapter = { adapterInstanceId: 'adapter-deny', connectionEpoch: 2, initialized: true, replyToServerRequest: (handle, response) => replies.push({ handle, response }), close: async () => {} }
    f.service.adapter = adapter
    f.service.approvals.adapter = adapter
    await f.service.onServerRequest({ handle: { adapterInstanceId: adapter.adapterInstanceId, connectionEpoch: adapter.connectionEpoch, externalRequestId: 9 }, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', cwd: f.root, command: ['echo', 'no'] } })
    const approval = f.service.database.db.prepare('SELECT approval_id FROM approvals').get()
    await f.service.operate({ action: 'decide_approval', approvalId: approval.approval_id, decision: 'denied' }, { actor: 'test-user', approvalAuthority: true })
    assert.equal(f.service.database.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(seeded.planned.executionId).execution_state, 'cancelled')
    assert.deepEqual(replies.at(-1).response, { decision: 'decline' })
  } finally { await f.close() }
})

test('failed unsupported request reply remains retryable when transport fails', async () => {
  const f = await serviceFixture()
  try {
    const adapter = { adapterInstanceId: 'adapter-error', connectionEpoch: 4, replyToServerRequest: async () => { throw new Error('socket closed') }, close: async () => {} }
    f.service.adapter = adapter
    const inbox = f.service.ledger.recordInbox({ adapterInstanceId: adapter.adapterInstanceId, connectionEpoch: adapter.connectionEpoch, externalEventId: 12, method: 'unsupported/request', payload: {}, dedupeKey: 'unsupported-retry' })
    await f.service.onServerRequest({ inboxId: inbox.inboxId, handle: { adapterInstanceId: adapter.adapterInstanceId, connectionEpoch: adapter.connectionEpoch, externalRequestId: 12 }, method: 'unsupported/request', params: {} })
    const row = f.service.database.db.prepare('SELECT processed_at,process_error FROM inbox WHERE inbox_id=?').get(inbox.inboxId)
    assert.equal(row.processed_at, null)
    assert.match(row.process_error, /socket closed/)
  } finally { await f.close() }
})

test('failed approval projection rolls back and safely retries on the same connection', async () => {
  const f = await serviceFixture()
  try {
    const seeded = seedExecution(f.service, f.root, { state: 'dispatch_pending' })
    const replies = []
    const adapter = { adapterInstanceId: 'adapter-rollback', connectionEpoch: 5, initialized: true, replyToServerRequest(handle, response) { replies.push({ handle, response }) }, close: async () => {} }
    f.service.adapter = adapter
    f.service.approvals.adapter = adapter
    const payload = { threadId: 'thread-1', turnId: 'turn-1', cwd: f.root, command: ['echo', 'ok'] }
    const inbox = f.service.ledger.recordInbox({ adapterInstanceId: adapter.adapterInstanceId, connectionEpoch: adapter.connectionEpoch, externalEventId: 42, method: 'item/commandExecution/requestApproval', payload, dedupeKey: 'approval-rollback' })
    const originalOpenAttention = f.service.openAttention.bind(f.service)
    let calls = 0
    f.service.openAttention = args => {
      calls += 1
      if (calls === 1) throw new Error('simulated projection failure')
      return originalOpenAttention(args)
    }
    const request = { handle: { adapterInstanceId: adapter.adapterInstanceId, connectionEpoch: adapter.connectionEpoch, externalRequestId: 42 }, method: 'item/commandExecution/requestApproval', params: payload, inboxId: inbox.inboxId }
    await f.service.onServerRequest(request)
    assert.equal(f.service.database.db.prepare('SELECT COUNT(*) AS count FROM approvals').get().count, 0)
    assert.equal(f.service.database.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(seeded.planned.executionId).execution_state, 'dispatch_pending')
    assert.match(f.service.database.db.prepare('SELECT process_error FROM inbox WHERE inbox_id=?').get(inbox.inboxId).process_error, /simulated projection failure/)
    assert.equal(f.service.database.db.prepare('SELECT external_event_id FROM inbox WHERE inbox_id=?').get(inbox.inboxId).external_event_id, 'n:42')

    f.service.openAttention = originalOpenAttention
    const retried = await f.service.retryInboxProjections()
    assert.equal(retried.completed, 1)
    assert.equal(f.service.database.db.prepare('SELECT COUNT(*) AS count FROM approvals').get().count, 1)
    assert.equal(f.service.database.db.prepare('SELECT processed_at FROM inbox WHERE inbox_id=?').get(inbox.inboxId).processed_at !== null, true)
    const approval = f.service.database.db.prepare('SELECT approval_id FROM approvals').get()
    await f.service.operate({ action: 'decide_approval', approvalId: approval.approval_id, decision: 'approved' }, { actor: 'test-user', approvalAuthority: true })
    assert.equal(replies.at(-1).handle.externalRequestId, 42)
  } finally { await f.close() }
})

test('reconciliation never substitutes a newer turn when the recorded turn is missing', async () => {
  const f = await serviceFixture()
  try {
    const old = seedExecution(f.service, f.root, { state: 'dispatch_unknown' })
    const newer = f.service.ledger.planExecution({
      taskId: old.task.taskId,
      executorKind: 'codex',
      method: 'turn/start',
      params: { threadId: 'thread-1', input: [] },
      idempotencyKey: 'newer-reconciliation-turn',
    })
    f.service.ledger.transitionExecution(newer.executionId, 'running')
    const thread = f.service.database.db.prepare("SELECT session_ref_id FROM session_refs WHERE source_kind='app_server_thread' AND external_id='thread-1'").get()
    const turn = f.service.ledger.upsertSession({ system: 'codex', externalId: 'turn-2', sourceKind: 'app_server_turn', durability: 'durable' })
    f.service.ledger.attachExecutionSession(newer.executionId, thread.session_ref_id)
    f.service.ledger.attachExecutionSession(newer.executionId, turn.sessionRefId)
    f.service.adapter = {
      close: async () => {},
      request: async () => ({ thread: { id: 'thread-1', turns: [{ id: 'turn-2', status: 'completed' }] } }),
    }

    const summary = await f.service.reconcileExecutions()

    assert.deepEqual(summary, { examined: 1, running: 0, terminal: 0, unresolved: 1 })
    assert.equal(f.service.database.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(old.planned.executionId).execution_state, 'reconciling')
    assert.equal(f.service.database.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(newer.executionId).execution_state, 'running')
  } finally { await f.close() }
})

test('reconciliation projects an unknown Codex turn to terminal state', async () => {
  const f = await serviceFixture()
  try {
    const seeded = seedExecution(f.service, f.root, { state: 'dispatch_unknown' })
    f.service.adapter = {
      close: async () => {},
      request: async (method, params) => {
        assert.equal(method, 'thread/read')
        assert.equal(params.threadId, 'thread-1')
        return { thread: { id: 'thread-1', turns: [{ id: 'turn-1', status: 'completed' }] } }
      },
    }
    const summary = await f.service.reconcileExecutions()
    assert.deepEqual(summary, { examined: 1, running: 0, terminal: 1, unresolved: 0 })
    assert.equal(f.service.database.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(seeded.planned.executionId).execution_state, 'succeeded')
  } finally { await f.close() }
})

function installAdapter(service, handler) {
  const calls = []
  const adapter = {
    initialized: true,
    adapterInstanceId: 'test-adapter',
    connectionEpoch: 1,
    close: async () => {},
    request: async (method, params) => {
      calls.push({ method, params })
      return handler(method, params, calls)
    },
  }
  service.adapter = adapter
  service.dispatcher.adapter = adapter
  service.approvals.adapter = adapter
  return calls
}

function enableExecution(service, ...flags) {
  service.flags.set('codex.daemon.connect', true, { actor: 'test' })
  for (const flag of flags) service.flags.set(flag, true, { actor: 'test' })
}

const operatorOperate = (service, args) => service.operate(args, { actor: 'operator', codexMutationAuthority: true, featureAuthority: true, approvalAuthority: true })

test('execute creates a native task, controlled thread, and turn exactly once', async () => {
  const f = await serviceFixture()
  try {
    enableExecution(f.service, 'codex.new_thread.execute')
    const calls = installAdapter(f.service, async (method, params) => {
      if (method === 'thread/start') return { thread: { id: 'thread-new', cwd: f.root } }
      if (method === 'turn/start') return { thread: { id: params.threadId, cwd: f.root }, turn: { id: 'turn-new', status: 'inProgress' } }
      throw new Error(`Unexpected method: ${method}`)
    })
    const request = { action: 'execute', requestId: 'new-1', objective: 'Implement the coordinator', workspacePath: f.root, mutatesWorkspace: false, forceNew: true, approvalPolicy: 'never', permissions: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } }
    const [result, concurrent] = await Promise.all([operatorOperate(f.service, request), operatorOperate(f.service, { ...request })])
    assert.equal(concurrent.routeDecisionId, result.routeDecisionId)
    assert.equal(result.decision.semanticAction, 'new_task')
    assert.equal(result.threadId, 'thread-new')
    assert.equal(result.executions.length, 2)
    assert.deepEqual(calls.map(call => call.method), ['thread/start','turn/start'])
    assert.equal(calls.some(call => 'approvalPolicy' in call.params || 'permissions' in call.params || 'sandboxPolicy' in call.params), false)
    assert.equal(f.service.database.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(result.executions[0].executionId).execution_state, 'succeeded')
    const turnExecution = f.service.database.db.prepare('SELECT execution_state,workspace_baseline_id FROM executions WHERE execution_id=?').get(result.executions[1].executionId)
    assert.equal(turnExecution.execution_state, 'running')
    assert.ok(turnExecution.workspace_baseline_id)
    assert.ok(result.executions[1].leaseId)
    assert.equal(f.service.database.db.prepare("SELECT source_kind FROM session_refs WHERE external_id='thread-new'").get().source_kind, 'app_server_thread')

    const repeated = await operatorOperate(f.service, request)
    assert.equal(repeated.repeated, true)
    assert.equal(repeated.routeDecisionId, result.routeDecisionId)
    assert.equal(calls.length, 2)
  } finally { await f.close() }
})

test('Codex executions retain the current DSH interaction session', async () => {
  const f = await serviceFixture()
  try {
    enableExecution(f.service, 'codex.new_thread.execute')
    installAdapter(f.service, async (method, params) => {
      if (method === 'thread/start') return { thread: { id: 'thread-associated', cwd: f.root } }
      if (method === 'turn/start') return { thread: { id: params.threadId, cwd: f.root }, turn: { id: 'turn-associated', status: 'inProgress' } }
      throw new Error(`Unexpected method: ${method}`)
    })
    const agent = { session: { id: 'dsh-interaction-session', header: { cwd: f.root } } }
    const result = await f.service.executeObjective({ requestId: 'interaction-association', objective: 'Keep the caller session attached', workspacePath: f.root, forceNew: true }, { codexMutationAuthority: true, agent })
    const session = f.service.database.db.prepare("SELECT session_ref_id FROM session_refs WHERE system='dsh' AND external_id=?").get(agent.session.id)
    assert.ok(session)
    const trigger = f.service.database.db.prepare('SELECT source_session_ref_id FROM triggers WHERE trigger_id=?').get(result.triggerId)
    assert.equal(trigger.source_session_ref_id, session.session_ref_id)
    assert.equal(f.service.database.db.prepare('SELECT relation FROM task_sessions WHERE task_id=? AND session_ref_id=?').get(result.taskId, session.session_ref_id).relation, 'interaction')
    const linked = f.service.database.db.prepare("SELECT COUNT(*) AS count FROM execution_sessions WHERE session_ref_id=? AND role='interaction'").get(session.session_ref_id)
    assert.equal(linked.count, 2)
  } finally { await f.close() }
})

test('DSH workers use an allowed preset and remain pending acceptance after success', async () => {
  const f = await serviceFixture()
  try {
    const calls = []
    const activation = {
      childId: 'dsh-worker-1',
      result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'Worker completed the implementation' }] }),
      async dispose() { calls.push('dispose') },
    }
    const agent = { id: 'assistant-agent', session: { id: 'dsh-worker-parent', header: { cwd: f.root } } }
    f.service.context = { get(name) { return name === 'subagents' ? { startActivation: async spec => { calls.push(spec); return activation } } : null } }
    const result = await f.service.executeObjective({ worker: 'dsh_subagent', requestId: 'dsh-worker-1', objective: 'Implement the worker test', workspacePath: f.root, agentPreset: 'cordis' }, { agent })
    assert.equal(result.worker, 'dsh_subagent')
    assert.ok(result.routeDecisionId)
    assert.equal(calls.at(0).agentPreset, 'cordis')
    assert.equal(calls.at(-1), 'dispose')
    const execution = f.service.database.db.prepare('SELECT executor_kind,execution_state,worker_policy_json,route_decision_id FROM executions WHERE execution_id=?').get(result.executionId)
    assert.equal(execution.executor_kind, 'dsh_subagent')
    assert.equal(execution.execution_state, 'succeeded')
    assert.equal(JSON.parse(execution.worker_policy_json).agentPreset, 'cordis')
    assert.equal(execution.route_decision_id, result.routeDecisionId)
    assert.equal(f.service.database.db.prepare("SELECT COUNT(*) AS count FROM execution_sessions WHERE execution_id=? AND role='interaction'").get(result.executionId).count, 1)
    assert.equal(f.service.ledger.getTask(result.taskId).state, 'active')
    assert.equal(f.service.ledger.acceptanceStatus(result.taskId).results[0].state, 'pending')
  } finally { await f.close() }
})

test('DSH fork workers inherit standard preset and reject independent presets', async () => {
  const f = await serviceFixture()
  try {
    const calls = []
    const activation = {
      childId: 'dsh-fork-worker-1',
      result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'Fork completed' }] }),
      async dispose() {},
    }
    const agent = { id: 'assistant-agent', session: { id: 'dsh-fork-parent', header: { cwd: f.root } } }
    f.service.context = { get(name) {
      return name === 'subagents' ? { startActivation: async spec => { calls.push(spec); return activation } } : null
    } }
    const result = await f.service.executeObjective({ worker: 'dsh_subagent', provider: 'fork', requestId: 'dsh-fork-standard', objective: 'Fork a standard worker', workspacePath: f.root, agentPreset: 'standard' }, { agent })
    assert.equal(result.worker, 'dsh_subagent')
    assert.equal(Object.hasOwn(calls[0], 'agentPreset'), false)
    await assert.rejects(f.service.executeObjective({ worker: 'dsh_subagent', provider: 'fork', requestId: 'dsh-fork-cordis', objective: 'Reject a nonstandard fork', workspacePath: f.root, agentPreset: 'cordis' }, { agent }), error => error.code === 'DSH_FORK_PRESET_UNSUPPORTED')
  } finally { await f.close() }
})

test('worker capability reporting exposes DSH provider capabilities without adding them to Codex', async () => {
  const f = await serviceFixture()
  try {
    const providers = {
      spawn: { name: 'spawn', inheritsParentContext: false, capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true } },
      fork: { name: 'fork', inheritsParentContext: true, capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false } },
    }
    f.service.context = { get(name) { return name === 'subagents' ? { startActivation() {}, getProvider(provider) { return providers[provider] } } : null } }
    const capabilities = f.service.workerCapabilities()
    assert.deepEqual(capabilities.dsh.providers.spawn, { available: true, inheritsParentContext: false, capabilities: providers.spawn.capabilities })
    assert.deepEqual(capabilities.dsh.providers.fork, { available: true, inheritsParentContext: true, capabilities: providers.fork.capabilities })
    assert.equal(capabilities.codex.available, false)
    assert.equal(Object.hasOwn(capabilities.codex, 'presets'), false)
    assert.equal(Object.hasOwn(capabilities.codex, 'providers'), false)
  } finally { await f.close() }
})

test('internal execution records a real begin/finish lifecycle, pending acceptance, and DSH interaction', async () => {
  const f = await serviceFixture()
  try {
    const agent = { session: { id: 'dsh-internal-session', header: { cwd: f.root } } }
    const result = await f.service.executeObjective({ worker: 'internal', mutatesWorkspace: false, requestId: 'internal-result', objective: 'Record a direct result' }, { agent })
    assert.equal(result.executionState, 'running')
    const running = f.service.database.db.prepare('SELECT executor_kind,execution_state,worker_policy_json FROM executions WHERE execution_id=?').get(result.executionId)
    assert.equal(running.execution_state, 'running')
    recordWork(f.service, agent)
    const finished = await f.service.finishInternalExecution({ executionId: result.executionId, output: 'The direct result is ready' }, { agent })
    const execution = f.service.database.db.prepare('SELECT executor_kind,execution_state,worker_policy_json FROM executions WHERE execution_id=?').get(result.executionId)
    assert.equal(execution.executor_kind, 'internal')
    assert.equal(execution.execution_state, 'succeeded')
    assert.equal(JSON.parse(execution.worker_policy_json).worker, 'internal')
    assert.equal(f.service.ledger.acceptanceStatus(result.taskId).results[0].state, 'pending')
    assert.equal(f.service.database.db.prepare("SELECT COUNT(*) AS count FROM execution_sessions WHERE execution_id=? AND role='interaction'").get(result.executionId).count, 1)
    assert.equal(f.service.database.db.prepare('SELECT execution_id FROM evidence WHERE evidence_id=?').get(finished.evidenceId).execution_id, result.executionId)
  } finally { await f.close() }
})

test('internal mutating execution captures and releases its workspace lease', async () => {
  const f = await serviceFixture()
  try {
    const agent = { session: { id: 'dsh-internal-mutating-session', header: { cwd: f.root } } }
    await assert.rejects(f.service.executeObjective({ worker: 'internal', requestId: 'internal-no-path', objective: 'Reject mutation without a path', mutatesWorkspace: true }, { agent }), /requires workspacePath/)
    const result = await f.service.executeObjective({ worker: 'internal', requestId: 'internal-mutating', objective: 'Record a workspace mutation', workspacePath: f.root, mutatesWorkspace: true }, { agent, callerWorkspaceRoot: f.root })
    recordWork(f.service, agent)
    await f.service.finishInternalExecution({ executionId: result.executionId, output: 'Mutation recorded' }, { agent })
    const execution = f.service.database.db.prepare('SELECT workspace_baseline_id,execution_state FROM executions WHERE execution_id=?').get(result.executionId)
    assert.ok(execution.workspace_baseline_id)
    assert.equal(execution.execution_state, 'succeeded')
    assert.equal(f.service.database.db.prepare('SELECT lease_state FROM leases WHERE execution_id=?').get(result.executionId).lease_state, 'released')
  } finally { await f.close() }
})

test('service disposal reconciles admitted internal work before closing the ledger', async t => {
  const f = await serviceFixture()
  const agent = { session: { id: 'dsh-internal-disposal', header: { cwd: f.root } } }
  try {
    const begun = await f.service.executeObjective({ worker: 'internal', requestId: 'internal-disposal', objective: 'Hold a workspace mutation', workspacePath: f.root, mutatesWorkspace: true }, { agent, callerWorkspaceRoot: f.root })
    let observed = null
    const close = f.service.database.close.bind(f.service.database)
    t.mock.method(f.service.database, 'close', () => {
      observed = {
        execution: f.service.database.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(begun.executionId).execution_state,
        lease: f.service.database.db.prepare('SELECT lease_state FROM leases WHERE execution_id=?').get(begun.executionId).lease_state,
        active: f.service.activeInternalExecutions.size,
      }
      close()
    })
    await f.service.dispose()
    assert.deepEqual(observed, { execution: 'reconciling', lease: 'recovery_hold', active: 0 })
    await assert.rejects(f.service.executeObjective({ worker: 'internal', requestId: 'after-disposal', objective: 'Do not admit this' }, { agent }), /service is disposed/)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('DSH planning failure releases a captured mutation lease', async t => {
  const f = await serviceFixture()
  try {
    const agent = { session: { id: 'dsh-plan-failure', header: { cwd: f.root } } }
    f.service.context = { get(name) { return name === 'subagents' ? { startActivation() { assert.fail('activation must not start') } } : null } }
    t.mock.method(f.service.ledger, 'planExecution', () => { throw new Error('planned failure') })
    await assert.rejects(f.service.executeObjective({ worker: 'dsh_subagent', requestId: 'dsh-plan-failure', objective: 'Capture then fail planning', workspacePath: f.root, mutatesWorkspace: true }, { agent, callerWorkspaceRoot: f.root }), /planned failure/)
    assert.equal(f.service.database.db.prepare('SELECT lease_state FROM leases ORDER BY acquired_at DESC LIMIT 1').get().lease_state, 'released')
  } finally { await f.close() }
})

test('DSH mutation lease remains active until activation disposal settles', async () => {
  const f = await serviceFixture()
  const result = Promise.withResolvers()
  const disposed = Promise.withResolvers()
  const published = Promise.withResolvers()
  try {
    const activation = { childId: 'dsh-lease-order', result: result.promise, dispose: () => disposed.promise }
    f.service.context = { get(name) { return name === 'subagents' ? { async startActivation() { published.resolve(); return activation } } : null } }
    const agent = { session: { id: 'dsh-lease-parent', header: { cwd: f.root } } }
    const execution = f.service.executeObjective({ worker: 'dsh_subagent', requestId: 'dsh-lease-order', objective: 'Mutate with an owned lease', workspacePath: f.root, mutatesWorkspace: true }, { agent, callerWorkspaceRoot: f.root })
    await published.promise
    result.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] })
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(f.service.database.db.prepare('SELECT lease_state FROM leases ORDER BY acquired_at DESC LIMIT 1').get().lease_state, 'active')
    disposed.resolve()
    const completed = await execution
    assert.equal(f.service.database.db.prepare('SELECT lease_state FROM leases WHERE execution_id=?').get(completed.executionId).lease_state, 'released')
  } finally { disposed.resolve(); result.reject(new Error('cleanup')); await f.close() }
})

test('parent cancellation disposes a published DSH activation and releases its lease', async () => {
  const f = await serviceFixture()
  const published = Promise.withResolvers()
  let disposeCalls = 0
  try {
    f.service.context = { get(name) { return name === 'subagents' ? { async startActivation({ signal }) {
      const result = new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      published.resolve()
      return { childId: 'dsh-parent-cancel', result, async dispose() { disposeCalls += 1 } }
    } } : null } }
    const agent = { session: { id: 'dsh-parent-cancel-session', header: { cwd: f.root } } }
    const controller = new AbortController()
    const execution = f.service.executeObjective({ worker: 'dsh_subagent', requestId: 'dsh-parent-cancel', objective: 'Cancel this worker', workspacePath: f.root, mutatesWorkspace: true }, { agent, callerWorkspaceRoot: f.root, signal: controller.signal })
    await published.promise
    controller.abort(new DOMException('cancelled', 'AbortError'))
    await assert.rejects(execution, { name: 'AbortError' })
    assert.ok(disposeCalls >= 1)
    assert.equal(f.service.database.db.prepare('SELECT lease_state FROM leases ORDER BY acquired_at DESC LIMIT 1').get().lease_state, 'released')
  } finally { await f.close() }
})

test('Codex worker rejects DSH preset parameters', async () => {
  const f = await serviceFixture()
  try {
    await assert.rejects(f.service.executeObjective({ worker: 'codex', requestId: 'codex-mode-rejected', objective: 'Do not accept a DSH mode', agentPreset: 'standard' }, { codexMutationAuthority: true }), /agentPreset is only valid for a DSH worker/)
  } finally { await f.close() }
})

test('execute resumes an owned durable thread before starting its turn', async () => {
  const f = await serviceFixture()
  try {
    enableExecution(f.service, 'routing.resume')
    const project = f.service.ledger.upsertProject({ name: 'fixture', canonicalPath: f.root })
    const task = f.service.ledger.createTask({ objective: 'Continue owned work', acceptance: ['Observe continued work'], projectId: project.projectId, state: 'active', sourceKey: 'execute:resume' })
    const session = f.service.ledger.upsertSession({ system: 'codex', externalId: 'thread-owned', sourceKind: 'app_server_thread', cwd: f.root, durability: 'durable' })
    f.service.ledger.attachTaskSession(task.taskId, session.sessionRefId, { relation: 'executor', confidence: 1 })
    const calls = installAdapter(f.service, async (method, params) => {
      if (method === 'thread/loaded/list') return { data: [] }
      if (method === 'thread/read') return { thread: { id: params.threadId, turns: [] } }
      if (method === 'thread/resume') return { thread: { id: params.threadId, cwd: f.root } }
      if (method === 'turn/start') return { thread: { id: params.threadId }, turn: { id: 'turn-resumed', status: 'inProgress' } }
      throw new Error(`Unexpected method: ${method}`)
    })
    const result = await operatorOperate(f.service, { action: 'execute', requestId: 'resume-1', taskId: task.taskId, objective: task.objective, workspacePath: f.root, mutatesWorkspace: false })
    assert.equal(result.decision.semanticAction, 'resume_task')
    assert.equal(result.decision.deliveryAction, 'resume_thread')
    assert.deepEqual(calls.map(call => call.method), ['thread/loaded/list','thread/read','thread/resume','turn/start'])
    assert.equal(result.executions.length, 2)
  } finally { await f.close() }
})

test('execute forks completed work only from its recorded completed turn', async () => {
  const f = await serviceFixture()
  try {
    enableExecution(f.service, 'routing.fork')
    const seeded = seedExecution(f.service, f.root)
    const thread = f.service.database.db.prepare("SELECT session_ref_id FROM session_refs WHERE external_id='thread-1'").get()
    f.service.ledger.attachTaskSession(seeded.task.taskId, thread.session_ref_id, { relation: 'executor', confidence: 1 })
    f.service.projectCodexNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } })
    const waiting = f.service.ledger.getTask(seeded.task.taskId)
    f.service.database.db.prepare("UPDATE tasks SET task_state='completed' WHERE task_id=?").run(seeded.task.taskId)
    const calls = installAdapter(f.service, async (method, params) => {
      if (method === 'thread/loaded/list') return { data: [] }
      if (method === 'thread/read') return { thread: { id: params.threadId, turns: [{ id: 'turn-1', status: 'completed' }] } }
      if (method === 'thread/fork') {
        assert.equal(params.lastTurnId, 'turn-1')
        return { thread: { id: 'thread-forked', cwd: f.root } }
      }
      if (method === 'turn/start') return { thread: { id: params.threadId }, turn: { id: 'turn-forked', status: 'inProgress' } }
      throw new Error(`Unexpected method: ${method}`)
    })
    const result = await operatorOperate(f.service, { action: 'execute', requestId: 'fork-1', taskId: seeded.task.taskId, objective: 'Try an independent alternative', workspacePath: f.root, mutatesWorkspace: false })
    assert.equal(result.decision.semanticAction, 'fork_task')
    assert.equal(result.decision.deliveryAction, 'fork_thread')
    assert.equal(f.service.ledger.getTask(result.taskId).parentTaskId, seeded.task.taskId)
    assert.deepEqual(calls.map(call => call.method), ['thread/loaded/list','thread/read','thread/fork','turn/start'])
  } finally { await f.close() }
})

test('execute steers only an active turn owned by the current adapter epoch and workspace lease', async () => {
  const f = await serviceFixture()
  try {
    enableExecution(f.service, 'routing.resume', 'control.steer')
    const seeded = seedExecution(f.service, f.root, { mutatesWorkspace: true })
    f.service.activateTask(seeded.task.taskId)
    const thread = f.service.database.db.prepare("SELECT session_ref_id FROM session_refs WHERE external_id='thread-1'").get()
    f.service.ledger.attachTaskSession(seeded.task.taskId, thread.session_ref_id, { relation: 'executor', confidence: 1 })
    const calls = installAdapter(f.service, async (method, params) => {
      if (method === 'thread/loaded/list') return { data: [{ id: 'thread-1' }] }
      if (method === 'thread/read') return { thread: { id: params.threadId, turns: [{ id: 'turn-1', status: 'inProgress' }] } }
      if (method === 'turn/steer') {
        assert.equal(params.expectedTurnId, 'turn-1')
        return { turnId: 'turn-1' }
      }
      throw new Error(`Unexpected method: ${method}`)
    })
    f.service.threadEpochs.set('thread-1', f.service.adapter.connectionEpoch)
    const result = await operatorOperate(f.service, { action: 'execute', requestId: 'steer-1', taskId: seeded.task.taskId, objective: 'Correct the current implementation', workspacePath: f.root, mutatesWorkspace: false, kind: 'correction' })
    assert.equal(result.decision.deliveryAction, 'steer_turn')
    assert.deepEqual(calls.map(call => call.method), ['thread/loaded/list','thread/read','turn/steer'])
    assert.equal(f.service.database.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(result.executions[0].executionId).execution_state, 'succeeded')
  } finally { await f.close() }
})

test('assistant authority cannot enable features, decide approvals, or dispatch Codex', async () => {
  const f = await serviceFixture()
  try {
    enableExecution(f.service, 'codex.new_thread.execute')
    installAdapter(f.service, async method => { throw new Error(`Restricted assistant dispatched ${method}`) })
    await assert.rejects(f.service.operate({ action: 'set_feature', key: 'routing.resume', enabled: true }), /authenticated operator/)
    await assert.rejects(f.service.operate({ action: 'decide_approval', approvalId: 'missing', decision: 'approved' }), /authenticated operator/)
    const result = await f.service.operate({ action: 'execute', requestId: 'restricted-1', objective: 'Do not dispatch', workspacePath: f.root, forceNew: true }, { callerWorkspaceRoot: f.root })
    assert.equal(result.decision.deliveryAction, 'wait')
    assert.deepEqual(result.decision.reasonCodes, ['NEW_THREAD_FLAG_DISABLED'])
  } finally { await f.close() }
})

test('assistant execution cannot escape its trusted caller workspace', async () => {
  const f = await serviceFixture()
  enableExecution(f.service, 'codex.new_thread.execute')
  try {
    const child = path.join(f.root, 'child')
    mkdirSync(child)
    await assert.rejects(
      f.service.operate({ action: 'execute', requestId: 'caller-scope-1', objective: 'Do not escape', workspacePath: f.root, forceNew: true }, { callerWorkspaceRoot: child }),
      /outside the caller workspace/,
    )
  } finally { await f.close() }
})

test('operator cannot enable queue or dispatch queue methods', async () => {
  const f = await serviceFixture()
  try {
    await assert.rejects(operatorOperate(f.service, { action: 'set_feature', key: 'control.queue', enabled: true }), /baseline and lease handoff/)
    await assert.rejects(f.service.dispatchCodex({ method: 'thread/queue/add', taskId: 'none', params: {} }, { authorizedFeature: 'control.queue' }), /disabled until/)
  } finally { await f.close() }
})

test('execute persists a waiting route without touching Codex when mutation flags are disabled', async () => {
  const f = await serviceFixture()
  try {
    await assert.rejects(f.service.operate({ action: 'execute', requestId: 'disabled-1', objective: 'Do not dispatch', workspacePath: f.root, mutatesWorkspace: false, forceNew: true }, { callerWorkspaceRoot: f.root }), /No enabled worker/)
    assert.equal(f.service.database.db.prepare('SELECT COUNT(*) AS n FROM executions').get().n, 0)
  } finally { await f.close() }
})

test('steer waits without the exact active workspace lease authority', async () => {
  const f = await serviceFixture()
  try {
    enableExecution(f.service, 'routing.resume', 'control.steer')
    const seeded = seedExecution(f.service, f.root)
    f.service.activateTask(seeded.task.taskId)
    const thread = f.service.database.db.prepare("SELECT session_ref_id FROM session_refs WHERE external_id='thread-1'").get()
    f.service.ledger.attachTaskSession(seeded.task.taskId, thread.session_ref_id, { relation: 'executor', confidence: 1 })
    const calls = installAdapter(f.service, async (method, params) => {
      if (method === 'thread/loaded/list') return { data: [{ id: 'thread-1' }] }
      if (method === 'thread/read') return { thread: { id: params.threadId, turns: [{ id: 'turn-1', status: 'inProgress' }] } }
      throw new Error(`Unexpected method: ${method}`)
    })
    f.service.threadEpochs.set('thread-1', f.service.adapter.connectionEpoch)
    const result = await operatorOperate(f.service, { action: 'execute', requestId: 'steer-no-lease-1', taskId: seeded.task.taskId, objective: 'Correct the current implementation', workspacePath: f.root, kind: 'correction' })
    assert.equal(result.decision.deliveryAction, 'wait')
    assert.deepEqual(calls.map(call => call.method), ['thread/loaded/list','thread/read'])
  } finally { await f.close() }
})

test('old turn completion cannot terminate a newer execution on the same thread', async () => {
  const f = await serviceFixture()
  try {
    const old = seedExecution(f.service, f.root)
    f.service.projectCodexNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } })
    const planned = f.service.ledger.planExecution({
      taskId: old.task.taskId,
      executorKind: 'codex',
      method: 'turn/start',
      params: { threadId: 'thread-1', input: [] },
      idempotencyKey: 'newer-turn',
    })
    f.service.ledger.transitionExecution(planned.executionId, 'running')
    const thread = f.service.database.db.prepare("SELECT session_ref_id FROM session_refs WHERE source_kind='app_server_thread' AND external_id='thread-1'").get()
    const turn = f.service.ledger.upsertSession({ system: 'codex', externalId: 'turn-2', sourceKind: 'app_server_turn', durability: 'durable' })
    f.service.ledger.attachExecutionSession(planned.executionId, thread.session_ref_id)
    f.service.ledger.attachExecutionSession(planned.executionId, turn.sessionRefId)

    f.service.projectCodexNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } })

    assert.equal(f.service.database.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(planned.executionId).execution_state, 'running')
    assert.equal(f.service.database.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(old.planned.executionId).execution_state, 'succeeded')
  } finally { await f.close() }
})

test('failed inbox projection remains retryable and converges after retry', async () => {
  const f = await serviceFixture()
  try {
    const seeded = seedExecution(f.service, f.root)
    const payload = { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } }
    const inbox = f.service.ledger.recordInbox({ adapterInstanceId: 'adapter-1', connectionEpoch: 1, method: 'turn/completed', payload, dedupeKey: 'retryable-completion' })
    const original = f.service.ledger.transitionTask.bind(f.service.ledger)
    let failOnce = true
    f.service.ledger.transitionTask = (...args) => {
      if (failOnce) { failOnce = false; throw new Error('transient task conflict') }
      return original(...args)
    }

    assert.equal(f.service.projectCodexNotification({ method: 'turn/completed', params: payload, inboxId: inbox.inboxId }), false)
    const failed = f.service.database.db.prepare('SELECT processed_at,process_error FROM inbox WHERE inbox_id=?').get(inbox.inboxId)
    assert.equal(failed.processed_at, null)
    assert.match(failed.process_error, /transient task conflict/)

    const retry = await f.service.retryInboxProjections()
    assert.deepEqual({ examined: retry.examined, completed: retry.completed, failed: retry.failed, errors: retry.errors }, { examined: 1, completed: 1, failed: 0, errors: [] })
    const completed = f.service.database.db.prepare('SELECT processed_at,process_error FROM inbox WHERE inbox_id=?').get(inbox.inboxId)
    assert.ok(completed.processed_at)
    assert.equal(completed.process_error, null)
    assert.equal(f.service.ledger.getTask(seeded.task.taskId).state, 'waiting')
  } finally { await f.close() }
})

test('Codex item projection failures stay contained and retry clears their attention', async () => {
  const f = await serviceFixture()
  const seeded = seedExecution(f.service, f.root)
  const params = { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'item-1', type: 'agentMessage', text: 'verified output' } }
  const inbox = f.service.ledger.recordInbox({ adapterInstanceId: 'adapter-item', connectionEpoch: 1, method: 'item/completed', payload: params, dedupeKey: 'retryable-item-projection' })
  const original = f.service.ledger.ingestSource.bind(f.service.ledger)
  let failOnce = true
  f.service.ledger.ingestSource = (...args) => {
    if (failOnce && args[0]?.sourceKind === 'worker_item') {
      failOnce = false
      throw new Error('transient item write failure')
    }
    return original(...args)
  }
  try {
    assert.doesNotThrow(() => f.service.adapter.emit('notification', { method: 'item/completed', params, inboxId: inbox.inboxId }))
    const failed = f.service.database.db.prepare('SELECT processed_at,process_error FROM inbox WHERE inbox_id=?').get(inbox.inboxId)
    assert.equal(failed.processed_at, null)
    assert.match(failed.process_error, /transient item write failure/)
    assert.equal(f.service.database.db.prepare("SELECT state FROM attention_items WHERE execution_id=? AND kind='projection_failed'").get(seeded.planned.executionId).state, 'open')

    const retry = await f.service.retryInboxProjections()
    assert.deepEqual({ examined: retry.examined, completed: retry.completed, failed: retry.failed }, { examined: 1, completed: 1, failed: 0 })
    const completed = f.service.database.db.prepare('SELECT processed_at,process_error FROM inbox WHERE inbox_id=?').get(inbox.inboxId)
    assert.ok(completed.processed_at)
    assert.equal(completed.process_error, null)
    assert.equal(f.service.database.db.prepare("SELECT state FROM attention_items WHERE execution_id=? AND kind='projection_failed'").get(seeded.planned.executionId).state, 'resolved')
    assert.equal(f.service.database.db.prepare("SELECT COUNT(*) AS count FROM evidence WHERE execution_id=? AND source_type='worker_item'").get(seeded.planned.executionId).count, 1)
  } finally { await f.close() }
})

test('Codex usage projection failures remain retryable until persisted', async () => {
  const f = await serviceFixture()
  const seeded = seedExecution(f.service, f.root)
  const params = { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: { totalTokens: 17 } }
  const inbox = f.service.ledger.recordInbox({ adapterInstanceId: 'adapter-usage', connectionEpoch: 1, method: 'thread/tokenUsage/updated', payload: params, dedupeKey: 'retryable-usage-projection' })
  f.service.database.db.exec("CREATE TEMP TRIGGER reject_usage BEFORE INSERT ON execution_usage BEGIN SELECT RAISE(ABORT,'transient usage write failure'); END")
  try {
    assert.doesNotThrow(() => f.service.projectCodexNotification({ method: 'thread/tokenUsage/updated', params, inboxId: inbox.inboxId }))
    assert.match(f.service.database.db.prepare('SELECT process_error FROM inbox WHERE inbox_id=?').get(inbox.inboxId).process_error, /transient usage write failure/)
    f.service.database.db.exec('DROP TRIGGER reject_usage')

    const retry = await f.service.retryInboxProjections()
    assert.deepEqual({ examined: retry.examined, completed: retry.completed, failed: retry.failed }, { examined: 1, completed: 1, failed: 0 })
    assert.equal(f.service.database.db.prepare('SELECT COUNT(*) AS count FROM execution_usage WHERE execution_id=?').get(seeded.planned.executionId).count, 1)
    assert.equal(f.service.database.db.prepare('SELECT processed_at FROM inbox WHERE inbox_id=?').get(inbox.inboxId).processed_at !== null, true)
  } finally { await f.close() }
})

test('managed backup verification cannot inspect arbitrary SQLite paths', async () => {
  const f = await serviceFixture()
  try {
    const created = await f.service.operate({ action: 'backup' })
    const name = path.basename(created.backup.path)
    const verification = await f.service.operate({ action: 'verify_backup', backupName: name })
    assert.equal(verification.ok, true)
    await assert.rejects(() => f.service.operate({ action: 'verify_backup', backupName: f.service.config.databasePath }), /Backup name is invalid/)
    await assert.rejects(() => f.service.operate({ action: 'verify_backup', backupName: '../ledger.sqlite' }), /Backup name is invalid/)
    assert.equal(f.service.health().lastBackup.name, name)
  } finally { await f.close() }
})

test('Codex execution rejects workspaces outside the configured allowlist', async () => {
  const f = await serviceFixture()
  const outside = mkdtempSync(path.join(os.tmpdir(), 'personal-agent-outside-test-'))
  try {
    enableExecution(f.service, 'codex.new_thread.execute')
    await assert.rejects(
      operatorOperate(f.service, { action: 'execute', requestId: 'outside-1', objective: 'Touch another directory', workspacePath: outside, forceNew: true }),
      /outside the configured Codex workspace allowlist/,
    )
    assert.equal(f.service.database.db.prepare('SELECT COUNT(*) AS count FROM executions').get().count, 0)
  } finally {
    rmSync(outside, { recursive: true, force: true })
    await f.close()
  }
})

test('symlink aliases share one canonical workspace lease', async () => {
  const f = await serviceFixture()
  try {
    const alias = path.join(f.root, 'workspace-alias')
    symlinkSync(f.root, alias, 'dir')
    const project = f.service.ledger.upsertProject({ name: 'fixture', canonicalPath: f.root })
    const firstTask = f.service.ledger.createTask({ objective: 'First writer', projectId: project.projectId, sourceKey: 'service:first-writer' })
    const secondTask = f.service.ledger.createTask({ objective: 'Second writer', projectId: project.projectId, sourceKey: 'service:second-writer' })
    enableExecution(f.service, 'routing.resume')
    installAdapter(f.service, async (method, params) => ({ thread: { id: params.threadId }, turn: { id: 'turn-first', status: 'inProgress' } }))

    const first = await f.service.dispatchCodex({ taskId: firstTask.taskId, method: 'turn/start', params: { threadId: 'thread-first', input: [] }, workspacePath: f.root, mutatesWorkspace: false })
    assert.ok(first.leaseId)
    await assert.rejects(
      f.service.dispatchCodex({ taskId: secondTask.taskId, method: 'turn/start', params: { threadId: 'thread-second', input: [] }, workspacePath: alias, mutatesWorkspace: false }),
      error => error.code === 'LEASE_CONFLICT',
    )
    assert.equal(f.service.database.db.prepare('SELECT COUNT(*) AS count FROM project_locations WHERE project_id=?').get(project.projectId).count, 1)
  } finally { await f.close() }
})

test('definite mutating dispatch failure releases its workspace lease', async () => {
  const f = await serviceFixture()
  try {
    const project = f.service.ledger.upsertProject({ name: 'fixture', canonicalPath: f.root })
    const task = f.service.ledger.createTask({ objective: 'Run a controlled mutation', projectId: project.projectId, sourceKey: 'service:dispatch-failure' })
    f.service.flags.set('codex.daemon.connect', true, { actor: 'test' })
    f.service.flags.set('routing.resume', true, { actor: 'test' })
    const adapter = { initialized: true, request: async () => { throw new Error('definite rejection') }, close: async () => {} }
    f.service.adapter = adapter
    f.service.dispatcher.adapter = adapter
    const result = await f.service.dispatchCodex({
      taskId: task.taskId,
      method: 'turn/start',
      params: { threadId: 'thread-fail', input: [{ type: 'text', text: 'change a file', text_elements: [] }] },
      mutatesWorkspace: true,
      workspacePath: f.root,
    })
    assert.equal(result.dispatch.failed, 1)
    const lease = f.service.database.db.prepare('SELECT lease_state,release_reason FROM leases WHERE lease_id=?').get(result.leaseId)
    assert.equal(lease.lease_state, 'released')
    assert.equal(lease.release_reason, 'quiescent')
  } finally { await f.close() }
})

test('a persisted assistant target remains recognized before its first task', async () => {
  const f = await serviceFixture()
  try {
    f.service.database.db.prepare("INSERT INTO main_session_binding VALUES(1,'blank-assistant',1,'ready','2026-11-17T00:00:00Z')").run()
    assert.equal(f.service.isAssistantSession('blank-assistant'), true)
    assert.equal(f.service.database.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE source_key='assistant-session:blank-assistant'").get().count, 0)
    const created = f.service.createAssistantTask({ sessionId: 'blank-assistant', objective: 'First real request' })
    assert.equal(created.state, 'active')
    assert.equal(f.service.dashboard().tasks.active[0].id, created.id)
  } finally { await f.close() }
})

test('dashboard only exposes top-level native assistant tasks', async () => {
  const f = await serviceFixture()
  try {
    const created = f.service.createAssistantTask({ sessionId: 'assistant-session-1', objective: 'Prepare the release' })
    const repeated = f.service.createAssistantTask({ sessionId: 'assistant-session-1', objective: 'A duplicate title is ignored' })
    assert.notEqual(repeated.id, created.id)
    assert.equal(repeated.title, 'A duplicate title is ignored')
    assert.equal(await f.service.assistantSessionTarget(), null)
    f.service.database.db.prepare("INSERT INTO main_session_binding VALUES(1,'assistant-session-1',1,'ready','2026-11-16T00:00:00Z')").run()
    assert.equal(await f.service.assistantSessionTarget(), 'assistant-session-1')
    assert.equal(f.service.isAssistantSession('assistant-session-1'), true)
    assert.equal(f.service.isAssistantSession('unknown-session'), false)

    const completed = f.service.ledger.createTask({ objective: 'Review the rollout', sourceKey: 'native:rollout', state: 'completed' })
    f.service.ledger.createTask({ objective: 'Hidden worker branch', sourceKey: 'native-request:child', parentTaskId: created.id, state: 'active' })
    f.service.ledger.createTask({ objective: 'Imported DSH session', sourceKey: 'dsh:history', state: 'completed' })
    f.service.ledger.createTask({ objective: 'Imported Codex thread', sourceKey: 'codex-thread:history', state: 'candidate' })

    const dashboard = f.service.dashboard()
    assert.deepEqual(Object.keys(dashboard).sort(), ['codex', 'evaluation', 'tasks', 'workers'])
    assert.deepEqual(new Set(dashboard.tasks.active.map(task => task.id)), new Set([created.id, repeated.id]))
    assert.deepEqual(dashboard.tasks.completed.map(task => task.id), [completed.taskId])
    assert.deepEqual(Object.keys(dashboard.codex), ['connected'])
    assert.equal(Object.hasOwn(dashboard, 'database'), false)
  } finally { await f.close() }
})

test('dashboard task detail exposes only the top-level summary and worker sessions', async () => {
  const f = await serviceFixture()
  try {
    const root = f.service.createAssistantTask({ sessionId: 'assistant-session-2', objective: 'Implement the dashboard' })
    const child = f.service.ledger.createTask({ objective: 'Implement the server', sourceKey: 'native-request:server', parentTaskId: root.id, state: 'active' })
    const planned = f.service.ledger.planExecution({
      taskId: child.taskId,
      executorKind: 'codex',
      method: 'turn/start',
      params: { threadId: 'worker-thread', model: 'gpt-5.6-sol', input: [] },
      mutatesWorkspace: false,
    })
    const worker = f.service.ledger.upsertSession({ system: 'codex', externalId: 'worker-thread', sourceKind: 'app_server_thread', durability: 'durable', nativeStatus: 'running' })
    f.service.ledger.attachExecutionSession(planned.executionId, worker.sessionRefId, { role: 'executor' })

    const dashboard = f.service.dashboard()
    assert.equal(dashboard.tasks.active[0].workerCount, 1)
    const detail = f.service.dashboardTaskDetail(root.id)
    assert.deepEqual(Object.keys(detail).sort(), ['task', 'workers'])
    assert.equal(detail.task.id, root.id)
    assert.equal(detail.task.workerCount, 1)
    assert.deepEqual(Object.keys(detail.workers[0]).sort(), ['model', 'route', 'sessionId', 'status', 'system'])
    assert.equal(detail.workers[0].sessionId, 'worker-thread')
    assert.equal(detail.workers[0].system, 'codex')
    assert.equal(detail.workers[0].status, 'running')
    assert.equal(detail.workers[0].model, 'gpt-5.6-sol')
    assert.equal(detail.workers[0].route, null)
    assert.throws(() => f.service.dashboardTaskDetail(child.taskId), error => error.code === 'ASSISTANT_TASK_NOT_FOUND')
  } finally { await f.close() }
})

function recordWork(service, agent) {
  agent.session.seq = 1
  service.context = { ...service.context, sessionPersistence: { async flush() {}, async open() { return { async read() { return { events: [{ seq: 0, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Observed verification output' }] } } }] } }, async close() {} } } } }
}


test('inbox retries share one batch across notifications and current approvals, excluding stale connections and exhausted rows', async () => {
  const f = await serviceFixture()
  try {
    f.service.updateRuntimeSettings({ inboxBatchSize: 2, inboxRetryLimit: 2, inboxRetryBudgetMs: 60000 })
    const adapter = { adapterInstanceId: 'live', connectionEpoch: 2, initialized: true, replyToServerRequest() {}, close: async () => {} }
    f.service.adapter = adapter
    let ordinal = 0
    const record = (key, method = 'turn/completed', epoch = 2) => {
      const id = f.service.ledger.recordInbox({ adapterInstanceId: 'live', connectionEpoch: epoch, method, externalEventId: key, payload: {}, dedupeKey: key }).inboxId
      f.service.database.db.prepare('UPDATE inbox SET received_at=? WHERE inbox_id=?').run(new Date(1000000000000 + ordinal++).toISOString(), id)
      return id
    }
    const stale = record('stale', 'item/commandExecution/requestApproval', 1)
    const exhausted = record('exhausted')
    f.service.database.db.prepare('UPDATE inbox SET retry_attempts=2,process_error=? WHERE inbox_id=?').run('Earlier failure', exhausted)
    record('notification')
    record('approval', 'item/commandExecution/requestApproval')
    record('notification-2')
    const operation = f.service.retryInboxProjections()
    assert.equal(f.service.retryInboxProjections(), operation)
    const result = await f.service.backgroundJobs.run('inbox', () => operation)
    assert.equal(result.examined, 2)
    assert.equal(result.failed, 1)
    assert.equal(result.completed, 1)
    assert.match(f.service.backgroundJobs.state('inbox').lastError, /Earlier failure/)
    const rows = f.service.database.db.prepare('SELECT inbox_id,retry_attempts FROM inbox').all()
    assert.equal(rows.find(row => row.inbox_id === stale).retry_attempts, 0)
    assert.equal(rows.find(row => row.inbox_id === exhausted).retry_attempts, 2)
    await f.service.retryInboxProjections()
    await f.service.retryInboxProjections()
    const settled = await f.service.retryInboxProjections()
    assert.equal(settled.examined, 0)
    assert.equal(settled.counts.find(row => row.state === 'exhausted').count, 3)
    const saved = f.service.database.db.prepare('SELECT processed_at,process_error,retry_attempts FROM inbox WHERE inbox_id=?').get(exhausted)
    assert.equal(saved.processed_at, null)
    assert.equal(saved.process_error, 'Earlier failure')
    await assert.rejects(f.service.operate({ action: 'retry_inbox', sourceKey: exhausted }), /authenticated operator/)
    await f.service.operate({ action: 'retry_inbox', sourceKey: exhausted }, { codexMutationAuthority: true, actor: 'test-operator' })
    assert.equal(f.service.database.db.prepare('SELECT retry_attempts FROM inbox WHERE inbox_id=?').get(exhausted).retry_attempts, 0)
    assert.equal(f.service.database.db.prepare('SELECT COUNT(*) AS count FROM approvals').get().count, 0)
    assert.equal(f.service.database.db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type='inbox.retry_reset'").get().count, 1)
  } finally { await f.close() }
})

test('inbox budget checkpoints leave untouched rows for another batch and preserve retry counts across restart', async t => {
  const { performance } = await import('node:perf_hooks')
  const f = await serviceFixture()
  let restarted
  try {
    f.service.updateRuntimeSettings({ inboxRetryEnabled: false, inboxRetryLimit: 2, inboxRetryBudgetMs: 10 })
    for (const key of ['budget-a','budget-b']) f.service.ledger.recordInbox({ adapterInstanceId: 'a', connectionEpoch: 1, method: 'turn/completed', payload: {}, dedupeKey: key })
    let now = 0
    t.mock.method(performance, 'now', () => now)
    const project = f.service.projectCodexNotification.bind(f.service)
    t.mock.method(f.service, 'projectCodexNotification', args => { const result = project(args); now = 11; return result })
    const result = await f.service.retryInboxProjections()
    assert.equal(result.examined, 1)
    assert.equal(result.failed, 1)
    assert.equal(result.budgetExceeded, true)
    assert.deepEqual(f.service.database.db.prepare('SELECT retry_attempts FROM inbox ORDER BY retry_attempts').all().map(row => row.retry_attempts), [0,1])
    await f.service.dispose()
    restarted = new PersonalAgentService(f.service.initialConfig)
    await restarted.initialize()
    assert.deepEqual(restarted.database.db.prepare('SELECT retry_attempts FROM inbox ORDER BY retry_attempts').all().map(row => row.retry_attempts), [0,1])
    assert.equal(restarted.runtimeSettings.inboxRetryEnabled, false)
  } finally { await restarted?.dispose(); await f.close() }
})

test('pending memory extraction failures remain visible before the retry limit is exhausted', async () => {
  const f = await serviceFixture()
  try {
    f.service.ledger.ingestSource({ sourceSystem: 'dsh', sourceKind: 'message', sourceUri: 'dsh://memory', sourceLocator: 'seq:1', sourceIdentity: '1', text: '项目用途是本地知识检索。' })
    const result = await f.service.backgroundJobs.run('memory-extraction', () => f.service.memory.run())
    assert.equal(result.processed, 0)
    assert.ok(result.errors.some(row => row.state === 'pending' && row.attempts === 1))
    assert.ok(f.service.backgroundJobs.state('memory-extraction').lastError)
    assert.equal(f.service.backgroundJobs.state('memory-extraction').lastSuccessfulAt, undefined)
  } finally { await f.close() }
})


test('shutdown joins an accepted Codex server request before closing its ledger', async t => {
  const f = await serviceFixture()
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  try {
    const request = f.service.ledger.recordInbox({ adapterInstanceId: 'shutdown', connectionEpoch: 1, externalEventId: 1, method: 'unsupported/request', payload: {}, dedupeKey: 'shutdown-request' })
    t.mock.method(f.service.adapter, 'replyToServerRequest', async () => { entered.resolve(); await release.promise })
    f.service.adapter.emit('serverRequest', { handle: {}, method: 'unsupported/request', inboxId: request.inboxId })
    await entered.promise
    const disposal = f.service.dispose()
    assert.equal(f.service.database.closed, false)
    release.resolve()
    await disposal
    assert.equal(f.service.database.closed, true)
    assert.doesNotThrow(() => f.service.adapter.emit('notification', { method: 'turn/completed', params: {} }))
    assert.doesNotThrow(() => f.service.adapter.emit('serverRequest', { method: 'unsupported/request' }))
    assert.equal(f.service.inFlightOperations.size, 0)
  } finally { release.resolve(); await f.close() }
})


test('memory operations retain exact user sources without granting assistant identity', async () => {
  const f = await serviceFixture({ memoryExtractionEnabled: false })
  try {
    const db = f.service.database.db
    db.prepare("INSERT INTO main_session_binding VALUES(1,'main',1,'ready','2026-11-17T00:00:00Z')").run()
    f.service.ledger.upsertSession({system:'dsh',externalId:'imported',sourceKind:'session'})
    for (const sessionId of ['fresh','imported','main']) {
      let current = {id: `${sessionId}-remember`,role:'user',source:{kind:'user'},content:[{type:'text',text:`记住${sessionId}喜欢简洁的回答`}]}
      const agent = {session:{id:sessionId,deriveMessages:()=>[current]}}
      const record = await f.service.operate({action:'remember',content:`${sessionId}喜欢简洁的回答`}, {actor:'assistant',agent})
      current = {...current,id:`${sessionId}-confirm`,content:[{type:'text',text:'确认这条记忆'}]}
      await f.service.operate({action:'confirm_memory',memoryId:record.id}, {actor:'assistant',agent})
      current = {...current,id:`${sessionId}-correct`,content:[{type:'text',text:`更正为${sessionId}喜欢具体的回答`}]}
      await f.service.operate({action:'correct_memory',memoryId:record.id,content:`${sessionId}喜欢具体的回答`}, {actor:'assistant',agent})
      current = {...current,id:`${sessionId}-retract`,content:[{type:'text',text:'撤回这条记忆'}]}
      await f.service.operate({action:'retract_memory',memoryId:record.id}, {actor:'assistant',agent})
      const sources = db.prepare(`SELECT r.source_locator,e.source_uri,e.author_role FROM evidence e
        JOIN source_records r USING(source_record_id) JOIN session_refs s USING(session_ref_id)
        WHERE s.external_id=? ORDER BY r.source_locator`).all(sessionId)
      assert.equal(sources.length,4)
      assert.deepEqual(sources.map(row=>row.source_locator),['confirm','correct','remember','retract'].map(action=>`user-message:${sessionId}-${action}`))
      assert.ok(sources.every(row=>row.source_uri===`dsh://session/${sessionId}`&&row.author_role==='user'))
      assert.equal(f.service.isAssistantSession(sessionId),sessionId==='main')
      assert.equal(await f.service.assistantSessionTarget(),'main')
      assert.equal(db.prepare('SELECT source_kind FROM session_refs WHERE external_id=?').get(sessionId).source_kind,sessionId==='imported'?'session':'interaction')
    }
    assert.equal(db.prepare("SELECT count(*) AS n FROM session_refs WHERE source_kind='personal_assistant'").get().n,0)
  } finally { await f.close() }
})

test('restart clears obsolete role labels while preserving memory sources and the sole main identity', async () => {
  const f = await serviceFixture({memoryExtractionEnabled:false})
  let restarted
  try {
    const db=f.service.database.db
    db.prepare("INSERT INTO main_session_binding VALUES(1,'main',1,'ready','2026-11-17T00:00:00Z')").run()
    const legacy=f.service.ledger.upsertSession({system:'dsh',externalId:'legacy',sourceKind:'personal_assistant'})
    const evidence=f.service.ledger.ingestSource({sourceSystem:'dsh',sourceKind:'memory_statement',sourceUri:'dsh://session/legacy',sourceLocator:'user-message:old',sourceIdentity:'old',text:'我喜欢简洁的回答',authorRole:'user',sessionRefId:legacy.sessionRefId})
    f.service.ledger.createTask({objective:'Old assistant role',sourceKey:'assistant-session:legacy'})
    assert.equal(f.service.isAssistantSession('legacy'),false)
    await f.service.dispose()
    restarted=new PersonalAgentService(f.service.config)
    await restarted.initialize()
    assert.equal(restarted.isAssistantSession('legacy'),false)
    assert.equal(restarted.isAssistantSession('main'),true)
    assert.equal(restarted.database.db.prepare('SELECT source_kind FROM session_refs WHERE session_ref_id=?').get(legacy.sessionRefId).source_kind,'interaction')
    assert.equal(restarted.database.db.prepare('SELECT session_ref_id FROM evidence WHERE evidence_id=?').get(evidence.evidenceId).session_ref_id,legacy.sessionRefId)
  } finally { await restarted?.dispose(); await f.close() }
})
