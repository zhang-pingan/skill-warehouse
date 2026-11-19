import { Ledger } from './ledger.js'
import { MemorySystem } from './memory-system.js'
import { discoverExecutionTargets } from './execution-discovery.js'
import { dashboardTaskDetail } from './task-detail.js'

/** Read-only business views shared by the worker and deterministic equivalence checks. */
export function executeRead(db, request) {
  const { kind, args, now, settings, extractionRunning, historyRead } = request
  const database = { db, config: settings }
  const service = { database, config: settings, ledger: new Ledger(database, { clock: () => now, instanceId: 'reader' }),
    flags: { enabled: key => key === 'history.read' && historyRead } }
  service.dashboardTaskDetail = id => dashboardTaskDetail(service, id)
  service.memory = new MemorySystem(service)
  service.memory.running = extractionRunning
  const { memory, ledger } = service
  switch (kind) {
    case 'history': return ledger.history.list(args)
    case 'search': return memory.search(args.query, args)
    case 'list': return memory.list(args)
    case 'discover': return discoverExecutionTargets(service, args)
    case 'get': {
      if (args.historyMessageId) return ledger.history.message(args.historyMessageId)
      if (args.sessionTaskId) return ledger.history.get(args.sessionTaskId, { offset: args.offset ?? 0, limit: args.limit ?? 30, version: args.version })
      for (const [id, read] of [[args.memoryId, 'get'], [args.entityId, 'getEntity'], [args.evidenceId, 'getExperience'], [args.edgeId, 'getRelation']]) {
        const value = id ? memory[read](id) : null
        if (value) return value
      }
      if (!args.taskId) return null
      const detail = service.dashboardTaskDetail(args.taskId)
      return detail ? { type: 'task', id: detail.task.id, objective: detail.task.title, state: detail.task.state,
        createdAt: detail.task.createdAt, updatedAt: detail.task.updatedAt, task: detail.task, workers: detail.workers } : null
    }
    default: throw new TypeError('Unsupported read operation')
  }
}
