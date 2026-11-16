import { sha256 } from './ids.js'

const decision = (input, semanticAction, deliveryAction, reasonCodes, explanation, target = null) => ({
  semanticAction,
  deliveryAction,
  targetTaskId: target?.taskId ?? null,
  targetSessionRefId: target?.sessionRefId ?? null,
  reasonCodes,
  explanation,
  inputSnapshotHash: sha256(JSON.stringify(input)),
  snapshot: {
    request: input.request,
    candidates: input.candidates ?? [],
    runtime: input.runtime ?? {},
    flags: input.flags ?? {},
  },
})

export function route(input) {
  const request = input.request ?? {}
  const candidates = [...(input.candidates ?? [])].sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || String(a.taskId).localeCompare(String(b.taskId)))
  const flags = input.flags ?? {}
  const runtime = input.runtime ?? {}

  if (request.mode === 'read_only' || request.mutates === false) {
    return decision(input, 'read_only', 'none', ['REQUEST_READ_ONLY'], 'The request only reads history or task state.')
  }

  const explicit = request.explicitTaskId && candidates.find(item => item.taskId === request.explicitTaskId)
  const best = explicit ?? candidates[0]
  const qualifies = explicit || (best && best.score >= (input.resumeThreshold ?? 0.86) && best.objectiveCompatible === true)

  if (request.forceNew || !qualifies) {
    if (flags['codex.new_thread.execute'] === false) return decision(input, 'new_task', 'wait', ['NEW_THREAD_FLAG_DISABLED'], 'A new task is required, but Codex thread creation is disabled.')
    return decision(input, 'new_task', 'start_thread', [request.forceNew ? 'EXPLICIT_NEW' : 'NO_SAFE_RESUME_CANDIDATE'], 'No candidate passed the deterministic resume gate.')
  }

  if (request.forceFork || best.objectiveChange === true || best.state === 'completed') {
    if (!flags['routing.fork']) return decision(input, 'fork_task', 'wait', ['FORK_FLAG_DISABLED'], 'A fork is required but the fork feature is disabled.', best)
    if (!best.lastCompletedTurnId) return decision(input, 'fork_task', 'wait', ['NO_COMPLETED_FORK_BOUNDARY'], 'Forking requires a completed turn boundary.', best)
    return decision(input, 'fork_task', 'fork_thread', ['OBJECTIVE_DIVERGED', 'COMPLETED_BOUNDARY_PRESENT'], 'The objective diverges and a completed fork boundary is available.', best)
  }

  if (!flags['routing.resume']) return decision(input, 'resume_task', 'wait', ['RESUME_FLAG_DISABLED'], 'The task matches, but automatic resume is disabled.', best)
  if (runtime.externalWriter === true) return decision(input, 'resume_task', 'wait', ['EXTERNAL_WRITER_OR_ACTIVITY'], 'External activity prevents mutation of this runtime.', best)
  if (runtime.turnState === 'active') {
    if (request.kind === 'correction' && flags['control.steer'] && runtime.sameAdapterConnection && runtime.activeExecutionAuthorized) {
      return decision(input, 'resume_task', 'steer_turn', ['ACTIVE_TURN_CORRECTION'], 'The active turn can be steered on its owning connection and workspace lease.', best)
    }
    return decision(input, 'resume_task', 'wait', ['ACTIVE_TURN_NOT_MUTABLE'], 'The current active turn cannot be safely modified.', best)
  }
  if (!best.sessionRefId) {
    if (flags['codex.new_thread.execute'] === false) return decision(input, 'resume_task', 'wait', ['NO_EXECUTOR_THREAD','NEW_THREAD_FLAG_DISABLED'], 'The matching task has no owned executor thread, and Codex thread creation is disabled.', best)
    return decision(input, 'resume_task', 'start_thread', ['NO_EXECUTOR_THREAD'], 'The existing task needs a new executor thread.', best)
  }
  if (runtime.loaded === false) return decision(input, 'resume_task', 'resume_thread', ['DURABLE_THREAD_UNLOADED'], 'The durable thread must be resumed before a turn starts.', best)
  return decision(input, 'resume_task', 'start_turn', ['OWNED_IDLE_THREAD'], 'The owned thread is idle and ready for a new turn.', best)
}
