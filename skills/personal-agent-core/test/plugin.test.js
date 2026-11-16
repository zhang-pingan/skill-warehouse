function collectEffect(callback) {
  const effect = callback()
  if (typeof effect === 'function') return effect
  const disposers = []
  const iterator = effect[Symbol.iterator]()
  while (true) {
    const item = iterator.next()
    if (typeof item.value === 'function') disposers.push(item.value)
    if (item.done) break
  }
  let closing
  return () => closing ??= (async () => { for (const dispose of disposers.reverse()) await dispose() })()
}

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, assistantContextMessage, ASSISTANT_CONTEXT, TOOL } from '../index.js'
import { PersonalAgentService } from '../lib/service.js'

function validateSchema(definition) {
  assert.equal(typeof definition.name, 'string')
  assert.equal(definition.parameters.type, 'object')
  assert.equal(definition.output.schema.type, 'object')
  assert.equal(typeof definition.output.render, 'function')
}

test('DSH tool definition includes required public ABI fields', () => validateSchema(TOOL))

test('assistant session context uses the native instruction projection without becoming a real user turn', () => {
  const message = assistantContextMessage()
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'agent-instructions')
  assert.equal(message.source.form, 'instructions')
  assert.deepEqual(message.source.changes, [{ action: 'add', scope: 'session', path: 'personal-assistant' }])
  assert.equal(message.content[0].type, 'text')
  assert.equal(message.content[0].text, ASSISTANT_CONTEXT)
  assert.match(ASSISTANT_CONTEXT, /personal_agent/)
  assert.match(ASSISTANT_CONTEXT, /resume, fork, or new-session/)
  assert.match(ASSISTANT_CONTEXT, /explicit agentPreset: standard/)
  assert.match(ASSISTANT_CONTEXT, /cordis for developing or configuring Harness plugins/)
  assert.match(ASSISTANT_CONTEXT, /fork provider inherits the main session's standard preset/)
  assert.match(ASSISTANT_CONTEXT, /ordinary questions, progress checks, and brief work directly/)
  assert.match(ASSISTANT_CONTEXT, /grouped and paginated by historical task/)
  assert.match(ASSISTANT_CONTEXT, /Absence from list_tasks never establishes absence from historical conversations/)
  assert.match(ASSISTANT_CONTEXT, /successful turn is not Task completion/)
  assert.equal(Object.isFrozen(message), true)
  assert.equal(Object.isFrozen(message.source), true)
  assert.equal(Object.isFrozen(message.source.changes), true)
  assert.equal(Object.isFrozen(message.source.changes[0]), true)
  assert.equal(Object.isFrozen(message.content), true)
})

test('DSH tool does not expose Codex privilege or operator controls', () => {
  for (const key of ['approvalPolicy','permissions','sandboxPolicy','key','enabled','approvalId','decision','response']) {
    assert.equal(Object.hasOwn(TOOL.parameters.properties, key), false)
  }
  assert.equal(TOOL.parameters.properties.action.enum.includes('set_feature'), false)
  assert.equal(TOOL.parameters.properties.action.enum.includes('decide_approval'), false)
})

test('assistant bootstrap command injects context and flushes persistence', async () => {
  let cleanup
  let command
  let tool
  let flushes = 0
  let workspaceEnsures = 0
  const injected = []
  const modelSelections = []
  const permissionSelections = []
  const presetSelections = []
  let currentPreset = 'cordis'
  let presetLocked = false
  const originalInitialize = PersonalAgentService.prototype.initialize
  const originalDispose = PersonalAgentService.prototype.dispose
  const originalRegisterAssistantSession = PersonalAgentService.prototype.registerAssistantSession
  const originalCreateAssistantTask = PersonalAgentService.prototype.createAssistantTask
  const originalOperate = PersonalAgentService.prototype.operate
  let registeredSession = null
  let sessionEvent = null
  let eventListenerDisposals = 0
  const createdTasks = []
  PersonalAgentService.prototype.initialize = async () => ({ ok: true })
  PersonalAgentService.prototype.dispose = async () => {}
  PersonalAgentService.prototype.registerAssistantSession = function (sessionId) { registeredSession = sessionId; this.assistantSessionIds.add(sessionId) }
  PersonalAgentService.prototype.createAssistantTask = args => { createdTasks.push(args); return args }
  PersonalAgentService.prototype.operate = async (_args, authority) => authority
  const ctx = {
    effect(callback) { cleanup = collectEffect(callback) },
    appReady: { onReady(listener) { listener(); return () => {} } },
    on(name, listener) { sessionEvent = { name, listener }; return () => { eventListenerDisposals += 1 } },
    webServer: { register: () => async () => {} },
    connection: {},
    tools: { register(definition) { tool = definition; return async () => {} } },
    commands: { register(definition) { command = definition; return async () => {} } },
    workingDirectory: { async ensure() { workspaceEnsures += 1; return '/workspace' } },
    sessionPersistence: { async flush() { flushes += 1 } },
    permissionPresets: { async set(session, preset) { permissionSelections.push({ session, preset }) } },
    agentPresets: { presetForSession: () => currentPreset, async select(agent, preset) { if (presetLocked) throw new Error('preset locked'); presetSelections.push({ session: agent.session, preset }); currentPreset = preset } },
    timer: { interval: () => () => {} },
    logger: { warn() {}, error() {} },
  }
  try {
    apply(ctx, { historyRead: false })
    assert.equal(command.name, 'personal-assistant')
    const session = { id: 'session-private-1' }
    const result = await command.handler({ agent: { session, model: { async select(selection) { modelSelections.push(selection) } }, inject(message) { injected.push(message) } } })
    assert.equal(result.kind, 'success')
    assert.equal(registeredSession, 'session-private-1')
    assert.deepEqual(modelSelections, [])
    assert.deepEqual(permissionSelections, [])
    assert.deepEqual(presetSelections, [{ session, preset: 'standard' }])
    assert.equal(injected.length, 1)
    assert.equal(injected[0].content[0].text, ASSISTANT_CONTEXT)
    assert.equal(flushes, 1)
    assert.equal(sessionEvent, null)
    assert.deepEqual(createdTasks, [])
    const authority = await tool.execute({ action: 'health' }, { agent: { session } })
    assert.equal(authority.callerWorkspaceRoot, null)
    assert.equal(workspaceEnsures, 0)
    const ordinary = await tool.execute({ action: 'health' }, { agent: { session: { id: 'ordinary-session' } } })
    assert.equal(ordinary.callerWorkspaceRoot, '/workspace')
    assert.equal(workspaceEnsures, 1)
    await command.handler({ agent: { session, model: { async select(selection) { modelSelections.push(selection) } }, inject(message) { injected.push(message) } } })
    assert.equal(presetSelections.length, 1, 'an existing standard session needs no preset selection')
    currentPreset = 'cordis'
    presetLocked = true
    await assert.rejects(command.handler({ agent: { session, model: { select() { assert.fail('stop after a locked preset') } }, inject() { assert.fail('do not register a partial role') } } }), /preset locked/)
    assert.equal(injected.length, 2)
    assert.equal(flushes, 2)
  } finally {
    await cleanup?.()
    assert.equal(eventListenerDisposals, 0)
    PersonalAgentService.prototype.initialize = originalInitialize
    PersonalAgentService.prototype.dispose = originalDispose
    PersonalAgentService.prototype.registerAssistantSession = originalRegisterAssistantSession
    PersonalAgentService.prototype.createAssistantTask = originalCreateAssistantTask
    PersonalAgentService.prototype.operate = originalOperate
  }
})

test('operator HTTP route requires an independent bearer token', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'personal-agent-plugin-test-'))
  const routes = new Map()
  let cleanup
  let rejection = undefined
  const originalInitialize = PersonalAgentService.prototype.initialize
  const originalDispose = PersonalAgentService.prototype.dispose
  const originalOperate = PersonalAgentService.prototype.operate
  PersonalAgentService.prototype.initialize = async () => ({ ok: true })
  PersonalAgentService.prototype.dispose = async () => {}
  PersonalAgentService.prototype.operate = async (_args, authority) => ({ actor: authority.actor })
  const ctx = {
    effect(callback) { cleanup = collectEffect(callback) },
    appReady: { onReady(listener) { listener(); return () => {} } },
    webServer: { register(definition) { assert.equal(routes.has(definition.path), false, `duplicate route ${definition.path}`); routes.set(definition.path, definition.handler); return async () => {} } },
    connection: { requestRejection: () => rejection },
    tools: { register: () => async () => {} },
    commands: { register: () => async () => {} },
    sessionPersistence: { flush: async () => {} },
    permissionPresets: { set: async () => {} },
    timer: { interval: () => () => {} },
    logger: { warn() {}, error() {} },
  }
  const invoke = async authorization => {
    const req = { method: 'POST', headers: authorization ? { authorization } : {}, async *[Symbol.asyncIterator]() { yield Buffer.from('{"action":"health"}') } }
    const response = { headers: {}, setHeader(key, value) { this.headers[key] = value }, end(body = '') { this.body = body } }
    await routes.get('/api/personal-agent/operate')(req, response)
    return response
  }
  const invokeAsset = async (method = 'GET', range = undefined, asset = 'starmap_bg.mp4') => {
    const req = { method, headers: range === undefined ? {} : { range } }
    const response = { headers: {}, setHeader(key, value) { this.headers[key] = value }, end(body = '') { this.body = body } }
    await routes.get('/api/personal-agent/assets/' + asset)(req, response)
    return response
  }
  try {
    apply(ctx, { dataDir: path.join(root, 'data'), codexHome: path.join(root, 'codex'), operatorToken: '0123456789abcdef0123456789abcdef' })
    assert.deepEqual([...routes.keys()].sort(), ['/api/personal-agent/assets/starmap_bg.mp4', '/api/personal-agent/dashboard', '/api/personal-agent/memory', '/api/personal-agent/memory/extraction', '/api/personal-agent/memory/initialization', '/api/personal-agent/memory/item', '/api/personal-agent/operate', '/api/personal-agent/session', '/api/personal-agent/settings', '/api/personal-agent/settings/codex', '/api/personal-agent/task'])
    const denied = await invoke(null)
    assert.equal(denied.statusCode, 403)
    assert.equal(JSON.parse(denied.body).code, 'OPERATOR_AUTH_REQUIRED')
    const allowed = await invoke('Bearer 0123456789abcdef0123456789abcdef')
    assert.equal(allowed.statusCode, 200)
    assert.deepEqual(JSON.parse(allowed.body), { actor: 'operator' })

    const source = readFileSync(new URL('../assets/starmap_bg.mp4', import.meta.url))
    const partial = await invokeAsset('GET', 'bytes=0-9')
    assert.equal(partial.statusCode, 206)
    assert.equal(partial.headers['Content-Type'], 'video/mp4')
    assert.equal(partial.headers['Accept-Ranges'], 'bytes')
    assert.equal(partial.headers['Content-Range'], `bytes 0-9/${source.length}`)
    assert.deepEqual(partial.body, source.subarray(0, 10))

    const suffix = await invokeAsset('GET', 'bytes=-7')
    assert.equal(suffix.statusCode, 206)
    assert.deepEqual(suffix.body, source.subarray(source.length - 7))

    const head = await invokeAsset('HEAD', 'bytes=0-9')
    assert.equal(head.statusCode, 206)
    assert.equal(head.headers['Content-Length'], '10')
    assert.equal(head.body, '')

    const invalid = await invokeAsset('GET', 'bytes=3-1')
    assert.equal(invalid.statusCode, 416)
    assert.equal(invalid.headers['Content-Range'], `bytes */${source.length}`)

    const unsupported = await invokeAsset('POST')
    assert.equal(unsupported.statusCode, 405)
    assert.equal(unsupported.headers.Allow, 'GET, HEAD')

    rejection = 403
    const rejected = await invokeAsset()
    assert.equal(rejected.statusCode, 403)
    assert.equal(rejected.body, '')
  } finally {
    await cleanup?.()
    PersonalAgentService.prototype.initialize = originalInitialize
    PersonalAgentService.prototype.dispose = originalDispose
    PersonalAgentService.prototype.operate = originalOperate
    rmSync(root, { recursive: true, force: true })
  }
})

test('dashboard HTTP routes create and read top-level assistant tasks', async () => {
  const routes = new Map()
  let cleanup
  const originals = {
    initialize: PersonalAgentService.prototype.initialize,
    dispose: PersonalAgentService.prototype.dispose,
    dashboard: PersonalAgentService.prototype.dashboard,
    createAssistantTask: PersonalAgentService.prototype.createAssistantTask,
    dashboardTaskDetail: PersonalAgentService.prototype.dashboardTaskDetail,
    assistantSessionTarget: PersonalAgentService.prototype.assistantSessionTarget,
    isAssistantSession: PersonalAgentService.prototype.isAssistantSession,
  }
  PersonalAgentService.prototype.initialize = async () => ({ ok: true })
  PersonalAgentService.prototype.dispose = async () => {}
  PersonalAgentService.prototype.dashboard = () => ({ tasks: { active: [], completed: [] }, codex: { connected: false } })
  PersonalAgentService.prototype.createAssistantTask = args => ({ id: 'task-created', title: args.objective, state: 'active', sessionId: args.sessionId })
  PersonalAgentService.prototype.dashboardTaskDetail = id => ({ task: { id, title: 'Task detail', state: 'active' } })
  PersonalAgentService.prototype.assistantSessionTarget = async () => 'session-native'
  PersonalAgentService.prototype.isAssistantSession = id => id === 'session-native'
  let targetPreset = 'standard'
  const ctx = {
    effect(callback) { cleanup = collectEffect(callback) },
    appReady: { onReady(listener) { listener(); return () => {} } },
    webServer: { register(definition) { routes.set(definition.path, definition.handler); return async () => {} } },
    connection: { requestRejection: () => undefined },
    tools: { register: () => async () => {} },
    commands: { register: () => async () => {} },
    sessionPersistence: { flush: async () => {} },
    sessionController: { async resolveAgent(id) { return { agent: { session: { id } } } } },
    agentPresets: { presetForSession: () => targetPreset },
    permissionPresets: { set: async () => {} },
    timer: { interval: () => () => {} },
    logger: { warn() {}, error() {} },
  }
  const invoke = async (path, { method = 'GET', body = null, url = path } = {}) => {
    const req = { method, url, headers: {}, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)) } }
    const response = { headers: {}, setHeader(key, value) { this.headers[key] = value }, end(value = '') { this.body = value } }
    await routes.get(path)(req, response)
    return { status: response.statusCode, body: JSON.parse(response.body) }
  }
  try {
    apply(ctx, { historyRead: false })
    const created = await invoke('/api/personal-agent/dashboard', {
      method: 'POST',
      body: { action: 'create-task', sessionId: 'session-native', objective: 'Ship the dashboard' },
    })
    assert.equal(created.status, 200)
    assert.deepEqual(created.body.task, { id: 'task-created', title: 'Ship the dashboard', state: 'active', sessionId: 'session-native' })
    const rejectedControl = await invoke('/api/personal-agent/dashboard', {
      method: 'POST',
      body: { action: 'manage-memory' },
    })
    assert.equal(rejectedControl.status, 400)
    assert.match(rejectedControl.body.error, /action must be create-task/)
    const detail = await invoke('/api/personal-agent/task', { url: '/api/personal-agent/task?id=task-created' })
    assert.equal(detail.status, 200)
    assert.equal(detail.body.task.id, 'task-created')
    const target = await invoke('/api/personal-agent/session')
    assert.deepEqual(target.body, { sessionId: 'session-native', agentPreset: 'standard' })
    targetPreset = 'cordis'
    assert.deepEqual((await invoke('/api/personal-agent/session')).body, { sessionId: 'session-native', agentPreset: 'cordis' })
    const assistant = await invoke('/api/personal-agent/session', { url: '/api/personal-agent/session?id=session-native' })
    assert.deepEqual(assistant.body, { assistant: true })
  } finally {
    await cleanup?.()
    for (const [name, implementation] of Object.entries(originals)) PersonalAgentService.prototype[name] = implementation
  }
})

test('settings updates persist preferences and replace background timers after startup', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'personal-agent-settings-route-test-'))
  const routes = new Map()
  const intervals = new Map()
  const importStarted = Promise.withResolvers()
  let intervalId = 0
  let announceReady
  let cleanup
  let imports = 0
  t.mock.method(PersonalAgentService.prototype, 'importHistory', async function () {
    imports += 1
    importStarted.resolve()
    return { imported: true }
  })
  const ctx = {
    effect(callback) { cleanup = collectEffect(callback) },
    appReady: { onReady(listener) { announceReady = listener; return () => {} } },
    on: () => () => {},
    webServer: { register(definition) { routes.set(definition.path, definition.handler); return async () => {} } },
    connection: { requestRejection: () => undefined },
    tools: { register: () => async () => {} },
    commands: { register: () => async () => {} },
    sessionPersistence: {},
    agentPresets: { async list() { return [{ id: 'standard', name: '标准模式', description: '处理常见任务。' }] } },
    timer: { interval(callback, ms) { const id = ++intervalId; intervals.set(id, { callback, ms }); return () => intervals.delete(id) } },
    logger: { warn() {}, error(error) { throw error } },
  }
  const invoke = async (method, body, routePath = '/api/personal-agent/settings') => {
    const request = { method, url: routePath, headers: {}, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)) } }
    const response = { setHeader() {}, end(value = '') { this.body = value } }
    await routes.get(routePath)(request, response)
    return { status: response.statusCode, body: JSON.parse(response.body) }
  }
  try {
    apply(ctx, { dataDir: path.join(root, 'data'), codexHome: path.join(root, 'codex') })
    const initial = await invoke('GET')
    assert.equal(initial.status, 200)
    assert.equal(initial.body.settings.importIntervalMs, 15 * 60_000)
    assert.equal(initial.body.settings.codexWorkerEnabled, false)
    assert.deepEqual(initial.body.presets, [{ id: 'standard', name: '标准模式', description: '处理常见任务。' }])
    const codexEnabled = await invoke('POST', { enabled: true }, '/api/personal-agent/settings/codex')
    assert.equal(codexEnabled.status, 200)
    assert.equal(codexEnabled.body.settings.codexWorkerEnabled, true)
    assert.equal(codexEnabled.body.codexChange.enabled, true)
    const codexDisabled = await invoke('POST', { enabled: false }, '/api/personal-agent/settings/codex')
    assert.equal(codexDisabled.body.settings.codexWorkerEnabled, false)
    assert.equal(codexDisabled.body.codexChange.history.evidence, 0)
    const disabled = {
      ...initial.body.settings,
      historySyncEnabled: false,
      historyStartupSyncEnabled: false,
      historyPeriodicSyncEnabled: false,
      inboxRetryEnabled: false,
      backupEnabled: false,
      memoryExtractionEnabled: false,
      cleanupEnabled: false,
    }
    assert.equal((await invoke('PUT', disabled)).body.settings.memoryExtractionEnabled, false)
    announceReady()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(intervals.size, 1)
    assert.equal(imports, 0)

    const enabled = {
      ...disabled,
      historySyncEnabled: true,
      historyStartupSyncEnabled: true,
      historyPeriodicSyncEnabled: true,
      importIntervalMs: 60_000,
      inboxRetryEnabled: true,
      inboxRetryIntervalMs: 10_000,
      backupEnabled: true,
      backupIntervalMs: 60 * 60_000,
      memoryExtractionEnabled: true,
      memoryExtractionIntervalMs: 120_000,
      cleanupEnabled: true,
      cleanupIntervalMs: 2 * 60 * 60_000,
    }
    assert.equal((await invoke('PUT', enabled)).status, 200)
    await importStarted.promise
    assert.equal(imports, 1)
    assert.deepEqual([...intervals.values()].map(timer => timer.ms).sort((a, b) => a - b), [10_000, 30_000, 60_000, 120_000, 60 * 60_000, 2 * 60 * 60_000])

    const changed = { ...enabled, inboxRetryIntervalMs: 15_000 }
    assert.equal((await invoke('PUT', changed)).status, 200)
    assert.equal([...intervals.values()].some(timer => timer.ms === 10_000), false)
    assert.equal([...intervals.values()].filter(timer => timer.ms === 15_000).length, 1)

    assert.equal((await invoke('PUT', { ...changed, historySyncEnabled: false, historyStartupSyncEnabled: false, historyPeriodicSyncEnabled: false, inboxRetryEnabled: false, backupEnabled: false, memoryExtractionEnabled: false, cleanupEnabled: false })).status, 200)
    assert.equal(intervals.size, 1)
  } finally {
    await cleanup?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('plugin disposal before initialization never starts background timers', async () => {
  let resolveReady
  const ready = new Promise(resolve => { resolveReady = resolve })
  const originalInitialize = PersonalAgentService.prototype.initialize
  const originalDispose = PersonalAgentService.prototype.dispose
  let cleanup
  let timersStarted = 0
  PersonalAgentService.prototype.initialize = () => ready
  PersonalAgentService.prototype.dispose = async () => {}
  const ctx = {
    effect(callback) { cleanup = collectEffect(callback) },
    appReady: { onReady(listener) { listener(); return () => {} } },
    webServer: { register: () => async () => {} },
    connection: {},
    tools: { register: () => async () => {} },
    commands: { register: () => async () => {} },
    sessionPersistence: { flush: async () => {} },
    timer: { interval: () => { timersStarted += 1; return () => {} } },
    logger: { warn() {}, error() {} },
  }
  try {
    apply(ctx, { historyRead: true })
    const disposing = cleanup()
    resolveReady({ ok: true })
    await disposing
    await Promise.resolve()
    assert.equal(timersStarted, 0)
  } finally {
    PersonalAgentService.prototype.initialize = originalInitialize
    PersonalAgentService.prototype.dispose = originalDispose
  }
})

test('automatic history sync waits for launcher readiness and shares the periodic entry point', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'personal-agent-startup-test-'))
  let cleanup
  let tool
  let announceReady
  let imports = 0
  let startupListenerRemoved = false
  const started = Promise.withResolvers()
  const periodic = Promise.withResolvers()
  const intervals = new Map()
  t.mock.method(PersonalAgentService.prototype, 'importHistory', async function () {
    imports += 1
    if (imports === 1) started.resolve()
    else periodic.resolve()
  })
  const ctx = {
    effect(callback) { cleanup = collectEffect(callback) },
    appReady: { onReady(listener) { announceReady = listener; return () => { startupListenerRemoved = true } } },
    webServer: { register: () => () => {} },
    connection: {},
    tools: { register(definition) { tool = definition; return () => {} } },
    commands: { register: () => () => {} },
    timer: { interval(callback, ms) { intervals.set(ms, callback); return () => intervals.delete(ms) } },
    logger: { warn() {}, error(error) { throw error } },
  }
  try {
    apply(ctx, { dataDir: path.join(root, 'data'), codexHome: path.join(root, 'codex') })
    await tool.execute({ action: 'health' })
    assert.equal(imports, 0)
    assert.equal(intervals.size, 0)
    announceReady()
    await started.promise
    assert.equal(imports, 1)
    await new Promise(resolve => setImmediate(resolve))
    await intervals.get(15 * 60_000)()
    await periodic.promise
    assert.equal(imports, 2)
    await cleanup()
    assert.equal(startupListenerRemoved, true)
    assert.equal(intervals.size, 0)
  } finally {
    await cleanup?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('disposal before launcher readiness cancels the pending initial history sync', async t => {
  let cleanup
  let announceReady
  let removed = false
  let timers = 0
  let imports = 0
  t.mock.method(PersonalAgentService.prototype, 'initialize', async () => {})
  t.mock.method(PersonalAgentService.prototype, 'dispose', async () => {})
  t.mock.method(PersonalAgentService.prototype, 'importHistory', async () => { imports += 1 })
  const ctx = {
    effect(callback) { cleanup = collectEffect(callback) },
    appReady: { onReady(listener) { announceReady = listener; return () => { removed = true } } },
    webServer: { register: () => () => {} }, connection: {},
    tools: { register: () => () => {} }, commands: { register: () => () => {} },
    timer: { interval() { timers += 1; return () => {} } },
    logger: { warn() {}, error() {} },
  }
  apply(ctx, { historyRead: true })
  await cleanup()
  announceReady()
  await Promise.resolve()
  assert.equal(removed, true)
  assert.equal(imports, 0)
  assert.equal(timers, 0)
})
