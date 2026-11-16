const transitions = Object.freeze({
  task: {
    candidate: ['open', 'merged', 'cancelled'],
    open: ['active', 'waiting', 'completed', 'cancelled'],
    active: ['waiting', 'completed', 'cancelled'],
    waiting: ['active', 'completed', 'cancelled'],
    completed: ['open'],
    cancelled: ['open'],
    merged: [],
  },
  execution: {
    planned: ['dispatch_pending', 'running', 'failed', 'cancelled'],
    dispatch_pending: ['running', 'waiting_approval', 'dispatch_unknown', 'failed', 'cancelled'],
    dispatch_unknown: ['reconciling', 'running', 'waiting_approval', 'failed'],
    reconciling: ['running', 'waiting_approval', 'waiting_user', 'succeeded', 'failed', 'cancelled', 'interrupted'],
    running: ['waiting_approval', 'waiting_user', 'reconciling', 'succeeded', 'failed', 'cancelled', 'interrupted'],
    waiting_approval: ['running', 'waiting_user', 'reconciling', 'succeeded', 'failed', 'cancelled', 'interrupted'],
    waiting_user: ['running', 'reconciling', 'succeeded', 'failed', 'cancelled', 'interrupted'],
    succeeded: [], failed: [], cancelled: [], interrupted: [],
  },
  lease: {
    requested: ['active', 'revoked'],
    active: ['recovery_hold', 'released', 'expired', 'revoked'],
    recovery_hold: ['released', 'revoked'],
    released: [], expired: ['recovery_hold', 'released'], revoked: [],
  },
  approval: {
    pending: ['approved', 'denied', 'expired', 'invalidated'],
    approved: [], denied: [], expired: [], invalidated: [],
  },
})

export function canTransition(machine, from, to) {
  return transitions[machine]?.[from]?.includes(to) ?? false
}

export function assertTransition(machine, from, to) {
  if (!canTransition(machine, from, to)) throw Object.assign(new Error(`Invalid ${machine} transition: ${from} -> ${to}`), { code: 'INVALID_TRANSITION', machine, from, to })
}

export { transitions }
