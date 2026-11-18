import assert from 'node:assert/strict'
import test from 'node:test'
import { route } from '../lib/router.js'

const candidate = { taskId: 'task-1', sessionRefId: 'session-1', score: 0.95, objectiveCompatible: true, state: 'active', lastCompletedTurnId: 'turn-1' }
const flags = { 'routing.resume': true, 'routing.fork': true, 'control.steer': true, 'control.queue': true }

test('read-only requests never allocate executor runtime', () => {
  const result = route({ request: { mode: 'read_only' }, candidates: [candidate], flags })
  assert.equal(result.semanticAction, 'read_only')
  assert.equal(result.deliveryAction, 'none')
})

test('low confidence creates a new task and thread', () => {
  const result = route({ request: { mutates: true }, candidates: [{ ...candidate, score: 0.2 }], flags })
  assert.equal(result.semanticAction, 'new_task')
  assert.equal(result.deliveryAction, 'start_thread')
})

test('resume is gated by feature and external activity', () => {
  assert.equal(route({ request: { mutates: true }, candidates: [candidate], flags: { ...flags, 'routing.resume': false } }).deliveryAction, 'wait')
  assert.equal(route({ request: { mutates: true }, candidates: [candidate], flags, runtime: { externalWriter: true } }).deliveryAction, 'wait')
})

test('active turn correction steers only on owning connection', () => {
  const allowed = route({ request: { mutates: true, kind: 'correction' }, candidates: [candidate], flags, runtime: { turnState: 'active', sameAdapterConnection: true, activeExecutionAuthorized: true } })
  assert.equal(allowed.deliveryAction, 'steer_turn')
  const denied = route({ request: { mutates: true, kind: 'correction' }, candidates: [candidate], flags, runtime: { turnState: 'active', sameAdapterConnection: false, activeExecutionAuthorized: true } })
  assert.equal(denied.deliveryAction, 'wait')
  const noLease = route({ request: { mutates: true, kind: 'correction' }, candidates: [candidate], flags, runtime: { turnState: 'active', sameAdapterConnection: true, activeExecutionAuthorized: false } })
  assert.equal(noLease.deliveryAction, 'wait')
})

test('active turn follow-up waits until queue lease handoff exists', () => {
  const result = route({ request: { mutates: true, kind: 'follow_up' }, candidates: [candidate], flags, runtime: { turnState: 'active', experimentalApi: true, sameAdapterConnection: true, activeExecutionAuthorized: true } })
  assert.equal(result.deliveryAction, 'wait')
})

test('explicit fork requires a completed boundary', () => {
  const fork = route({ request: { mutates: true, forceFork:true }, candidates: [{ ...candidate, objectiveChange: true }], flags })
  assert.equal(fork.deliveryAction, 'fork_thread')
  const wait = route({ request: { mutates: true, forceFork:true }, candidates: [{ ...candidate, objectiveChange: true, lastCompletedTurnId: null }], flags })
  assert.equal(wait.deliveryAction, 'wait')
})

test('same input is deterministic', () => {
  const input = { request: { mutates: true }, candidates: [candidate], flags, runtime: { loaded: true } }
  assert.deepEqual(route(input), route(input))
})
