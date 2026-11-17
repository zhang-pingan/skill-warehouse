import { newId, json, nowIso, encodeRpcId, decodeRpcId } from './ids.js'

const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
  'item/tool/call',
  'account/chatgptAuthTokens/refresh',
  'attestation/generate',
  'currentTime/read',
])

export class ApprovalService {
  constructor(ledger, adapter, { clock = Date.now } = {}) {
    this.ledger = ledger
    this.db = ledger.db
    this.adapter = adapter
    this.clock = clock
    this.decisions = new Map()
  }

  capture({ executionId, handle, method, params, expiresAt = null }) {
    if (!APPROVAL_METHODS.has(method)) throw new Error(`Unsupported server request: ${method}`)
    const externalRequestId = encodeRpcId(handle.externalRequestId)
    const existing = this.db.prepare(`SELECT approval_id,execution_id,kind,scope_json,approval_state
      FROM approvals WHERE adapter_instance_id=? AND connection_epoch=? AND external_request_id=?`)
      .get(handle.adapterInstanceId, handle.connectionEpoch, externalRequestId)
    if (existing) {
      if (existing.execution_id !== executionId || existing.kind !== method) throw new Error('Server request identity conflicts with an existing approval')
      return { approvalId: existing.approval_id, state: existing.approval_state, scope: JSON.parse(existing.scope_json), requestHandle: handle, inserted: false }
    }
    const approvalId = newId('approval')
    const scope = {
      ...(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(method) ? { request: params } : {}),
      threadId: params.threadId ?? null,
      turnId: params.turnId ?? null,
      itemId: params.itemId ?? null,
      cwd: params.cwd ?? null,
      grantRoot: params.grantRoot ?? null,
      permissions: params.permissions ?? null,
      command: params.command ?? null,
      availableDecisions: Array.isArray(params.availableDecisions) ? params.availableDecisions : null,
    }
    this.db.prepare(`INSERT INTO approvals(approval_id,execution_id,adapter_instance_id,connection_epoch,external_request_id,kind,scope_json,risk_summary,approval_state,requested_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(approvalId, executionId, handle.adapterInstanceId, handle.connectionEpoch, externalRequestId, method, json(scope), this.riskSummary(method, params), 'pending', nowIso(this.clock), expiresAt)
    return { approvalId, state: 'pending', scope, requestHandle: handle, inserted: true }
  }

  async decide(approvalId, decision, { decidedBy = 'user', evidenceId = null } = {}) {
    const prior = this.decisions.get(approvalId)
    if (prior) {
      if (prior.state !== decision.state || JSON.stringify(prior.response ?? null) !== JSON.stringify(decision.response ?? null)) throw new Error('Conflicting approval decision is already in progress')
      return prior.promise
    }
    const operation = this._decide(approvalId, decision, { decidedBy, evidenceId })
    this.decisions.set(approvalId, { state: decision.state, response: decision.response, promise: operation })
    try { return await operation } finally {
      if (this.decisions.get(approvalId)?.promise === operation) this.decisions.delete(approvalId)
    }
  }

  async _decide(approvalId, decision, { decidedBy, evidenceId }) {
    if (!['approved','denied'].includes(decision.state)) throw new Error('Approval decision must be approved or denied')
    const row = this.db.prepare('SELECT * FROM approvals WHERE approval_id=?').get(approvalId)
    if (!row || row.approval_state !== 'pending') throw new Error('Approval is not pending')
    const handle = { adapterInstanceId: row.adapter_instance_id, connectionEpoch: row.connection_epoch, externalRequestId: decodeRpcId(row.external_request_id) }
    let response = decision.response
    if (response === undefined && (row.kind === 'item/commandExecution/requestApproval' || row.kind === 'item/fileChange/requestApproval')) response = { decision: decision.state === 'approved' ? 'accept' : 'decline' }
    if (response === undefined && decision.state === 'denied') response = { error: { code: -32002, message: 'Request denied by user' } }
    if (response === undefined) throw new Error(`Approval response payload is required for ${row.kind}`)
    await this.adapter.replyToServerRequest(handle, response)
    const changed = this.db.prepare(`UPDATE approvals SET approval_state=?,decided_at=?,decided_by=?,decision_evidence_id=? WHERE approval_id=? AND approval_state='pending'`)
      .run(decision.state, nowIso(this.clock), decidedBy, evidenceId, approvalId)
    if (!changed.changes) throw new Error('Approval state changed while decision was being recorded')
    return { approvalId, state: decision.state }
  }

  riskSummary(method, params) {
    if (method.includes('commandExecution')) return `Command execution requested in ${params.cwd ?? 'unknown cwd'}`
    if (method.includes('fileChange')) return `File changes requested${params.grantRoot ? ` under ${params.grantRoot}` : ''}`
    if (method.includes('permissions')) return 'Additional execution permissions requested'
    return `Interactive Codex request: ${method}`
  }
}

export { APPROVAL_METHODS }
