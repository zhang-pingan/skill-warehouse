import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { CodexAppServerAdapter } from '../lib/codex-adapter.js'
import { fixture } from './helpers.js'

async function eventually(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not met')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

async function serverAt(socketPath, onRequest) {
  mkdirSync(path.dirname(socketPath), { recursive: true })
  rmSync(socketPath, { force: true })
  const httpServer = createServer()
  const wss = new WebSocketServer({ noServer: true })
  httpServer.on('upgrade', (request, socket, head) => wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request)))
  wss.on('connection', ws => ws.on('message', data => onRequest(ws, JSON.parse(data.toString()))))
  await new Promise((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(socketPath, resolve) })
  return { wss, close: async () => { for (const client of wss.clients) client.terminate(); await new Promise(resolve => httpServer.close(resolve)); rmSync(socketPath, { force: true }) } }
}

test('UDS adapter performs Codex handshake and classifies notifications', async () => {
  const f = fixture({ codexConnect: true, codexSocketPath: `/tmp/pac-${process.pid}-${Date.now()}-${Math.random()}.sock` })
  const messages = []
  let server
  try {
    let mutationAuthorized = false
    let experimentalApi = false
    server = await serverAt(f.config.codexSocketPath, (ws, request) => {
      messages.push(request)
      if (request.method === 'initialize') {
        experimentalApi = request.params.capabilities.experimentalApi
        ws.send(JSON.stringify({ id: request.id, result: { serverInfo: { name: 'fake' } } }))
      }
      if (request.method === 'thread/list') ws.send(JSON.stringify({ id: request.id, result: { data: [] } }))
      if (request.method === 'thread/start') ws.send(JSON.stringify({ id: request.id,
        ...(request.params.runtimeWorkspaceRoots && !experimentalApi
          ? { error: { code: -32600, message: 'thread/start.runtimeWorkspaceRoots requires experimentalApi capability' } }
          : { result: { thread: { id: 'created' } } }) }))
    })
    const adapter = new CodexAppServerAdapter({ ...f.config, codexMutations: false }, { ledger: f.ledger, authorizeMutation: () => mutationAuthorized })
    let notification
    let notificationCount = 0
    adapter.on('notification', value => { notification = value; notificationCount += 1 })
    const firstConnect = adapter.connect()
    const secondConnect = adapter.connect()
    assert.strictEqual(firstConnect, secondConnect)
    await firstConnect
    const client = [...server.wss.clients][0]
    client.send(JSON.stringify({ method: 'thread/started', params: { thread: { id: 't1' } } }))
    await eventually(() => messages.length >= 2 && notification)
    assert.equal(messages[0].method, 'initialize')
    assert.equal(messages[1].method, 'initialized')
    assert.equal(notification.method, 'thread/started')
    assert.ok(notification.inboxId)
    assert.equal(notificationCount, 1)
    f.ledger.completeInbox(notification.inboxId)
    adapter.onMessage(Buffer.from(JSON.stringify({ method: 'thread/started', params: { thread: { id: 't1' } } })), adapter.connectionEpoch)
    assert.equal(notificationCount, 1)
    assert.deepEqual(await adapter.request('thread/list', {}), { data: [] })
    const params = { cwd: f.root, runtimeWorkspaceRoots: [f.root] }
    await assert.rejects(adapter.request('thread/start', params), /not authorized/)
    mutationAuthorized = true
    assert.deepEqual(await adapter.request('thread/start', params), { thread: { id: 'created' } })
    await adapter.close()
  } finally { await server?.close(); f.close() }
})

test('failed initialization cleans up its captured socket', async () => {
  const f = fixture({ codexConnect: true, codexSocketPath: `/tmp/pac-${process.pid}-${Date.now()}-${Math.random()}.sock` })
  let server
  try {
    server = await serverAt(f.config.codexSocketPath, (ws, request) => {
      if (request.method === 'initialize') ws.send(JSON.stringify({ id: request.id, error: { code: -32000, message: 'initialize failed' } }))
    })
    const adapter = new CodexAppServerAdapter(f.config, { ledger: f.ledger })
    await assert.rejects(adapter.connect(), /initialize failed/)
    assert.equal(adapter.ws, null)
    assert.equal(adapter.initialized, false)
  } finally { await server?.close(); f.close() }
})

test('malformed Codex envelopes are reported without persisting or dispatching them', t => {
  const f = fixture()
  t.after(() => f.close())
  const warnings = [], errors = [], notifications = [], requests = []
  const adapter = new CodexAppServerAdapter(f.config, { ledger: f.ledger, logger: { warn: (...args) => warnings.push(args) } })
  adapter.on('protocolError', error => errors.push(error))
  adapter.on('notification', message => notifications.push(message))
  adapter.on('serverRequest', message => requests.push(message))
  const invalid = [null, [], true, 1, 'text', {}, { method: 42 }, { method: '' },
    { id: {}, method: 'request' }, { id: null, result: null }, { id: 1, result: null, error: { code: -1, message: 'bad' } },
    { id: 1, result: null, method: 'request' }, { id: 1, error: null }, { id: 1, error: { code: 'bad', message: 2 } },
    { result: {} }, { method: 'turn/completed', params: [] }, { method: 'turn/completed', params: 'text' },
    { method: 'turn/completed', params: { eventId: {} } }]
  for (const value of invalid) assert.doesNotThrow(() => adapter.onMessage(Buffer.from(JSON.stringify(value)), adapter.connectionEpoch))
  assert.doesNotThrow(() => adapter.onMessage(Buffer.from('{"secret":"DO_NOT_LOG_THIS",'), adapter.connectionEpoch))
  assert.equal(errors.length, invalid.length + 1)
  assert.ok(errors.every(error => error.code === 'CODEX_PROTOCOL_ERROR'))
  assert.equal(warnings.length, errors.length)
  assert.equal(JSON.stringify(warnings).includes('DO_NOT_LOG_THIS'), false)
  assert.deepEqual(notifications, [])
  assert.deepEqual(requests, [])
  assert.equal(f.database.db.prepare('SELECT count(*) AS count FROM inbox').get().count, 0)
  adapter.onMessage(Buffer.from('{"method":"thread/started","params":{"thread":{"id":"valid"}}}'), adapter.connectionEpoch)
  assert.equal(notifications.length, 1)
  assert.equal(f.database.db.prepare('SELECT count(*) AS count FROM inbox').get().count, 1)
})

test('remote method names cannot emit local adapter lifecycle or approval events', t => {
  const f = fixture()
  t.after(() => f.close())
  const adapter = new CodexAppServerAdapter(f.config, { ledger: f.ledger })
  const notifications = [], requests = [], ready = []
  adapter.on('notification', message => notifications.push(message))
  adapter.on('serverRequest', message => requests.push(message))
  adapter.on('ready', message => ready.push(message))
  for (const method of ['error', 'notification', 'serverRequest', 'ready']) {
    assert.doesNotThrow(() => adapter.onMessage(Buffer.from(JSON.stringify({ method, params: {} })), adapter.connectionEpoch))
  }
  assert.equal(notifications.length, 4)
  assert.deepEqual(requests, [])
  assert.deepEqual(ready, [])
})

test('invalid WebSocket replies leave the request pending for a valid null result', { timeout: 10_000 }, async t => {
  const f = fixture({ codexSocketPath: `/tmp/pac-${process.pid}-${Date.now()}-${Math.random()}.sock` })
  let server, adapter
  t.after(async () => { await adapter?.close(); await server?.close(); f.close() })
  server = await serverAt(f.config.codexSocketPath, (ws, request) => {
    if (request.method === 'initialize') ws.send(JSON.stringify({ id: request.id, result: {} }))
    if (request.method === 'thread/list') {
      ws.send('null')
      ws.send(JSON.stringify({ id: request.id, result: 'invalid', error: { code: -1, message: 'conflicting fields' } }))
      ws.send(JSON.stringify({ id: request.id, result: null }))
    }
  })
  const errors = []
  adapter = new CodexAppServerAdapter(f.config, { ledger: f.ledger, logger: { warn() {} } })
  adapter.on('protocolError', error => errors.push(error))
  await adapter.connect()
  assert.equal(await adapter.request('thread/list', {}), null)
  assert.equal(errors.length, 2)
  assert.equal(adapter.pending.size, 0)
  assert.equal(adapter.initialized, true)
})

test('inbox write failures prevent dispatch and remain observable before a later delivery', t => {
  const f = fixture()
  t.after(() => f.close())
  const logs = [], errors = [], notifications = [], requests = []
  const adapter = new CodexAppServerAdapter(f.config, { ledger: f.ledger, logger: { error: (...args) => logs.push(args) } })
  adapter.on('inboxPersistenceError', error => errors.push(error))
  adapter.on('notification', message => notifications.push(message))
  adapter.on('serverRequest', message => requests.push(message))
  const write = t.mock.method(f.ledger, 'recordInbox', () => { throw new Error('fixture storage unavailable') })
  const frames = [
    { method: 'thread/started', params: { eventId: 0, thread: { id: 't1' } } },
    { id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 't1' } },
  ]
  for (const frame of frames) assert.doesNotThrow(() => adapter.onMessage(Buffer.from(JSON.stringify(frame)), adapter.connectionEpoch))
  assert.equal(errors.length, 2)
  assert.equal(logs.length, 2)
  assert.ok(errors.every(error => error.code === 'CODEX_INBOX_PERSISTENCE_FAILED'))
  assert.equal(notifications.length, 0)
  assert.equal(requests.length, 0)
  assert.equal(f.database.db.prepare('SELECT count(*) AS count FROM inbox').get().count, 0)
  write.mock.restore()
  for (const frame of frames) adapter.onMessage(Buffer.from(JSON.stringify(frame)), adapter.connectionEpoch)
  assert.equal(notifications.length, 1)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].handle.externalRequestId, 'approval-1')
  assert.equal(f.database.db.prepare('SELECT count(*) AS count FROM inbox').get().count, 2)
})

test('server request response is bound to adapter instance and epoch', async () => {
  const f = fixture({ codexConnect: true, codexSocketPath: `/tmp/pac-${process.pid}-${Date.now()}-${Math.random()}.sock` })
  let server
  try {
    server = await serverAt(f.config.codexSocketPath, (ws, request) => {
      if (request.method === 'initialize') ws.send(JSON.stringify({ id: request.id, result: {} }))
    })
    const adapter = new CodexAppServerAdapter(f.config, { ledger: f.ledger })
    const requestPromise = new Promise(resolve => adapter.once('serverRequest', resolve))
    await adapter.connect()
    ;[...server.wss.clients][0].send(JSON.stringify({ id: 77, method: 'item/commandExecution/requestApproval', params: { command: ['echo','x'] } }))
    const request = await requestPromise
    assert.ok(request.inboxId)
    await assert.rejects(adapter.replyToServerRequest({ ...request.handle, connectionEpoch: request.handle.connectionEpoch + 1 }, { result: { decision: 'decline' } }), /another adapter connection/)
    await adapter.replyToServerRequest(request.handle, { result: { decision: 'decline' } })
    await adapter.close()
  } finally { await server?.close(); f.close() }
})

test('response from a mismatched pending epoch remains orphaned', async () => {
  const f = fixture()
  try {
    const adapter = new CodexAppServerAdapter(f.config, { ledger: f.ledger })
    adapter.connectionEpoch = 2
    let settled = false
    let orphan
    const timer = setTimeout(() => {}, 10_000)
    adapter.pending.set(19, {
      resolve: () => { settled = true },
      reject: () => { settled = true },
      timer,
      method: 'thread/list',
      epoch: 1,
    })
    adapter.once('orphanResponse', message => { orphan = message })

    adapter.onMessage(Buffer.from(JSON.stringify({ id: 19, result: { data: ['stale'] } })), 2)

    assert.deepEqual(orphan, { id: 19, result: { data: ['stale'] } })
    assert.equal(settled, false)
    assert.equal(adapter.pending.has(19), true)
    clearTimeout(timer)
    adapter.pending.delete(19)
  } finally { f.close() }
})

test('server request reply waits for socket callback and rejects send failures', async () => {
  const f = fixture()
  try {
    const adapter = new CodexAppServerAdapter(f.config, { ledger: f.ledger })
    adapter.connectionEpoch = 4
    const handle = { adapterInstanceId: adapter.adapterInstanceId, connectionEpoch: 4, externalRequestId: 21 }
    const socket = new EventEmitter()
    socket.readyState = 3
    adapter.ws = socket
    await assert.rejects(adapter.replyToServerRequest(handle, { result: { decision: 'decline' } }), /connection is closed/)

    socket.readyState = 1
    socket.send = (_payload, callback) => callback(new Error('async send failure'))
    await assert.rejects(adapter.replyToServerRequest(handle, { result: { decision: 'decline' } }), /async send failure/)

    socket.send = () => { throw new Error('sync send failure') }
    await assert.rejects(adapter.replyToServerRequest(handle, { result: { decision: 'decline' } }), /sync send failure/)

    let sent
    socket.send = (payload, callback) => { sent = JSON.parse(payload); callback() }
    await adapter.replyToServerRequest(handle, { result: { decision: 'accept' } })
    assert.deepEqual(sent, { id: 21, result: { decision: 'accept' } })
  } finally { f.close() }
})

test('close operates on its captured socket after replacement', async () => {
  const f = fixture()
  try {
    const adapter = new CodexAppServerAdapter(f.config, { ledger: f.ledger })
    const oldSocket = new EventEmitter()
    oldSocket.readyState = 1
    let terminated = false
    oldSocket.close = () => {
      oldSocket.readyState = 3
      oldSocket.emit('close', 1000, Buffer.from('closed'))
    }
    oldSocket.terminate = () => { terminated = true }
    adapter.ws = oldSocket
    adapter.connectionEpoch = 7
    adapter.initialized = true
    const newerSocket = { readyState: 1 }
    const closing = adapter.close()
    adapter.ws = newerSocket
    await closing
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(terminated, false)
    assert.equal(adapter.ws, newerSocket)
  } finally { f.close() }
})
