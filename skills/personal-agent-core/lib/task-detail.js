import { parseJson } from './ids.js'

const ASSISTANT_TASK_SOURCE = `(source_key LIKE 'assistant-session:%' OR source_key LIKE 'native-request:%' OR source_key LIKE 'native:%')`
const dashboardTask = row => ({
  id: row.task_id,
  title: row.objective,
  state: row.task_state,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at,
  workerCount: Number(row.worker_count ?? 0),
  ...(row.acceptance_json === undefined ? {} : { acceptance: parseJson(row.acceptance_json, []) }),
})

/** Read an assistant task and native worker references from one connection. */
export function dashboardTaskDetail(service, taskId) {
    const root = service.database.db.prepare(`SELECT task_id,project_id,objective,task_state,created_at,updated_at,completed_at,acceptance_json
      FROM tasks WHERE task_id=? AND parent_task_id IS NULL AND ${ASSISTANT_TASK_SOURCE}`).get(taskId)
    if (!root) {
      const error = new Error('Top-level assistant task does not exist')
      error.code = 'ASSISTANT_TASK_NOT_FOUND'
      error.statusCode = 404
      throw error
    }
    const rows = service.database.db.prepare(`WITH RECURSIVE task_tree(task_id) AS (
        SELECT task_id FROM tasks WHERE task_id=?
        UNION ALL SELECT child.task_id FROM tasks child JOIN task_tree ON child.parent_task_id=task_tree.task_id
      ) SELECT session.session_ref_id,session.system,session.external_id,session.native_status,
        execution.execution_state,execution.attempt_no,route.semantic_action,route.delivery_action,outbox.params_json
      FROM task_tree
      JOIN executions execution ON execution.task_id=task_tree.task_id
      JOIN execution_sessions mapping ON mapping.execution_id=execution.execution_id
      JOIN session_refs session ON session.session_ref_id=mapping.session_ref_id
      LEFT JOIN route_decisions route ON route.route_decision_id=execution.route_decision_id
      LEFT JOIN outbox ON outbox.execution_id=execution.execution_id
      WHERE mapping.role IN ('executor','fork_source')
      ORDER BY session.session_ref_id,execution.attempt_no DESC,COALESCE(execution.started_at,execution.finished_at) DESC`).all(taskId)
    const workers = new Map()
    for (const row of rows) {
      const params = parseJson(row.params_json, {})
      const route = row.semantic_action && row.delivery_action ? `${row.semantic_action}:${row.delivery_action}` : null
      let worker = workers.get(row.session_ref_id)
      if (!worker) {
        worker = {
          sessionId: row.external_id,
          system: row.system,
          status: row.native_status || row.execution_state || null,
          model: params.model ?? null,
          route,
        }
        workers.set(row.session_ref_id, worker)
        continue
      }
      worker.model ??= params.model ?? null
      worker.route ??= route
    }
    return {
      task: { ...dashboardTask(root), workerCount: workers.size, verification: service.ledger.acceptanceStatus(taskId), steps: service.ledger.listTaskSteps(taskId) },
      workers: [...workers.values()],
    }
  }

