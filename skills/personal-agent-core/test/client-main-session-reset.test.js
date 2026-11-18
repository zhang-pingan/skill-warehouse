import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const source = client.slice(client.indexOf('    function createMainSessionResetController('), client.indexOf('    function MainSessionControls('))

function fixture(t) {
  let confirm = false, pauses = 0, resumes = 0, nextTimer = 0
  const requests = [], timers = new Map()
  const make = runInNewContext(`${source}\ncreateMainSessionResetController`, {
    AbortController, responseJson: async response => response,
    window: { confirm: () => confirm },
    fetch: async (_url, options) => { const result = Promise.withResolvers(); requests.push({ ...result, options }); return result.promise },
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id }, clearTimeout: id => timers.delete(id),
  })
  const store = make({ suspend() { pauses++ }, async resume() { resumes++ } }, key => key)
  t.after(() => store.dispose())
  return { store, requests, timers, approve() { confirm = true }, get pauses() { return pauses }, get resumes() { return resumes },
    async settle() { for (let i = 0; i < 12; i++) await Promise.resolve() },
    async load(view) { const work = store.load(); await this.settle(); requests.at(-1).resolve(view); await work },
  }
}

test('clear requires confirmation, ignores duplicate clicks and keeps polling after the page closes', async t => {
  const f = fixture(t)
  await f.load({ state: 'idle', running: false, sessionId: 'old' })
  f.store.start(); assert.equal(f.requests.length, 1)
  f.approve()
  const work = f.store.start()
  f.store.start(); await f.settle()
  assert.equal(f.requests.length, 2)
  assert.deepEqual(JSON.parse(f.requests[1].options.body), { confirmed: true, expectedSessionId: 'old' })
  const unsubscribe = f.store.subscribe(() => {}); unsubscribe()
  f.requests[1].resolve({ state: 'running', running: true, sessionId: 'old', phase: 'syncing' }); await work
  assert.equal(f.timers.size, 1)
  const poll = [...f.timers.values()][0]()
  await f.settle()
  f.requests.at(-1).resolve({ state: 'succeeded', running: false, sessionId: 'new' }); await poll
  assert.equal(f.store.getSnapshot().view.sessionId, 'new')
  assert.equal(f.resumes, 1)
  assert.equal(f.timers.size, 0)
})

test('lost reset response reads durable status instead of resubmitting the operation', async t => {
  const f = fixture(t)
  await f.load({ state: 'idle', running: false, sessionId: 'old' })
  f.approve(); const work = f.store.start(); await f.settle()
  f.requests.at(-1).reject(new Error('connection lost')); await f.settle()
  assert.equal(f.requests.at(-1).options.method, 'GET')
  f.requests.at(-1).resolve({ state: 'succeeded', running: false, sessionId: 'new', oldSessionId: 'old' }); await work
  assert.equal(f.requests.filter(row => row.options.method === 'POST').length, 1)
  assert.equal(f.store.getSnapshot().error, '')
  assert.equal(f.resumes, 1)
})

test('failed status lookup keeps the conversation paused until a successful refresh', async t => {
  const f = fixture(t)
  await f.load({ state: 'idle', running: false, sessionId: 'old' })
  f.approve(); const work = f.store.start(); await f.settle()
  f.requests.at(-1).reject(new Error('lost POST')); await f.settle()
  f.requests.at(-1).reject(new Error('lost status')); await work
  assert.equal(f.resumes, 0)
  assert.equal(f.store.getSnapshot().error, 'lost status')
  const calls = f.requests.length; f.store.start(); assert.equal(f.requests.length, calls)
  await f.load({ state: 'failed', running: false, sessionId: 'old', lastError: 'sync failed' })
  assert.equal(f.resumes, 1)
  assert.equal(f.store.getSnapshot().view.lastError, 'sync failed')
})

test('controller disposal aborts the request and prevents late conversation replacement', async t => {
  const f = fixture(t)
  const work = f.store.load(); await f.settle()
  f.store.dispose()
  assert.equal(f.requests[0].options.signal.aborted, true)
  f.requests[0].resolve({ state: 'running', running: true, sessionId: 'old' }); await work
  assert.equal(f.pauses, 0)
  assert.equal(f.resumes, 0)
  assert.equal(f.timers.size, 0)
})

test('a rejected second reset cannot be mistaken for an earlier successful operation', async t => {
  const f = fixture(t)
  const previous = { state: 'succeeded', running: false, oldSessionId: 'older', sessionId: 'current' }
  await f.load(previous)
  f.approve(); const work = f.store.start(); await f.settle()
  f.requests.at(-1).reject(new Error('main is busy')); await f.settle()
  f.requests.at(-1).resolve(previous); await work
  assert.equal(f.store.getSnapshot().error, 'main is busy')
  assert.equal(f.resumes, 1)
})
