import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { setImmediate as tick } from 'node:timers/promises'
import { QueryReader } from '../lib/query-reader.js'
import { resolveConfig } from '../lib/config.js'

class ControlledWorker extends EventEmitter {
  constructor() { super(); this.sent = []; this.stopped = Promise.withResolvers() }
  postMessage(message) { this.sent.push(message) }
  terminate() { this.terminating = true; return this.stopped.promise }
  reply(value) { this.emit('message', { id: this.sent.at(-1).id, value }) }
}
function fixture(options = {}) {
  const workers = []
  const reader = new QueryReader({ readQueryQueueLimit: 3, readQueryTimeoutMs: 30000, ...options }, {
    createWorker() { const worker = new ControlledWorker(); workers.push(worker); return worker },
  })
  return { reader, workers, async close() {
    const closed = reader.close()
    for (const worker of workers) worker.stopped.resolve(0)
    await closed
  } }
}

test('reader is lazy, serializes a bounded queue and cancellation removes queued work only', async () => {
  const f = fixture()
  try {
    assert.equal(f.workers.length, 0)
    const a = f.reader.run({}), abort = new AbortController()
    const b = f.reader.run({}, { signal: abort.signal }), rejected = assert.rejects(b, /queued/)
    const c = f.reader.run({})
    await assert.rejects(f.reader.run({}), { code: 'READ_QUERY_BUSY', statusCode: 429 })
    abort.abort(new Error('queued'))
    await rejected
    assert.equal(f.workers[0].sent.length, 1)
    f.workers[0].reply('first'); assert.equal(await a, 'first')
    assert.equal(f.workers[0].sent.length, 2)
    f.workers[0].reply('third'); assert.equal(await c, 'third')
    assert.equal(f.workers.length, 1)
  } finally { await f.close() }
})

test('active cancellation waits for termination, ignores late replies and preserves other queued reads', async () => {
  const f = fixture()
  try {
    const abort = new AbortController()
    const a = f.reader.run({}, { signal: abort.signal }), rejected = assert.rejects(a, /cancelled/)
    const b = f.reader.run({})
    const old = f.workers[0]
    abort.abort(new Error('cancelled'))
    await rejected
    assert.equal(old.terminating, true)
    old.reply('late')
    assert.equal(f.workers.length, 1)
    old.stopped.resolve(0); await tick()
    assert.equal(f.workers.length, 2)
    f.workers[1].reply('next'); assert.equal(await b, 'next')
  } finally { await f.close() }
})

test('close rejects outstanding reads and waits for the owned thread to terminate', async () => {
  const f = fixture()
  const a = assert.rejects(f.reader.run({}), { code: 'READ_QUERY_CLOSED' })
  const b = assert.rejects(f.reader.run({}), { code: 'READ_QUERY_CLOSED' })
  let finished = false
  const close = f.reader.close().then(() => { finished = true })
  await tick(); assert.equal(finished, false)
  await assert.rejects(f.reader.run({}), { code: 'READ_QUERY_CLOSED' })
  f.workers[0].stopped.resolve(0)
  await Promise.all([a, b, close])
  assert.equal(finished, true)
})

test('timeout covers startup and rejects rather than returning an empty result', async t => {
  const f = fixture({ readQueryTimeoutMs: 250 })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const result = assert.rejects(f.reader.run({}), { code: 'READ_QUERY_TIMEOUT', statusCode: 408 })
    t.mock.timers.tick(250)
    await result
    assert.equal(f.workers[0].terminating, true)
  } finally { await f.close() }
})

for (const event of ['error', 'exit', 'message']) test(`worker ${event} failure rejects pending reads and a later request recreates it`, async () => {
  const f = fixture()
  try {
    const a = assert.rejects(f.reader.run({}), /查询线程/), b = assert.rejects(f.reader.run({}), /查询线程/)
    f.workers[0].emit(event, event === 'error' ? new Error('failed') : event === 'exit' ? 1 : { id: -1 })
    f.workers[0].stopped.resolve(0)
    await Promise.all([a,b]); await tick()
    const c = f.reader.run({}); f.workers[1].reply('recovered'); assert.equal(await c, 'recovered')
  } finally { await f.close() }
})

test('termination failure prevents reopening and is reported by close', async () => {
  const f = fixture(), abort = new AbortController()
  const a = assert.rejects(f.reader.run({}, { signal: abort.signal }), /cancel/)
  const b = assert.rejects(f.reader.run({}), /termination failure/)
  abort.abort(new Error('cancel'))
  f.workers[0].stopped.reject(new Error('termination failure'))
  await Promise.all([a,b])
  await assert.rejects(f.reader.run({}), /termination failure/)
  await assert.rejects(f.reader.close(), /termination failure/)
  assert.equal(f.workers.length, 1)
})

test('pre-aborted reads never start a worker and invalid budgets fail at config loading', async () => {
  const f = fixture()
  try {
    await assert.rejects(f.reader.run({}, { signal: AbortSignal.abort(new Error('cancel')) }), /cancel/)
    assert.equal(f.workers.length, 0)
    for (const key of ['readQueryQueueLimit','readQueryTimeoutMs']) for (const value of [0,-1,1.5,'30']) {
      assert.throws(() => resolveConfig({ [key]: value }, {}), new RegExp(key))
    }
  } finally { await f.close() }
})
