/** Cooperative work budget shared by one history synchronization. */
import { performance } from 'node:perf_hooks'
import { setImmediate } from 'node:timers/promises'

/**
 * Bound synchronous work between event-loop yields; cancellation rejects at the next checkpoint.
 * @param config - Validated history batch settings.
 * @param signal - Plugin lifetime cancellation, when owned by a running service.
 * @returns Checkpoint callback; pass true to yield before starting a synchronization.
 */
export function historyCheckpoint(config, signal) {
  let remaining = config.historyBatchSize
  let deadline = performance.now() + config.historyBatchMs
  return async (force = false) => {
    signal?.throwIfAborted()
    if (!force && --remaining > 0 && performance.now() < deadline) return
    await setImmediate(undefined, { signal })
    remaining = config.historyBatchSize
    deadline = performance.now() + config.historyBatchMs
  }
}
