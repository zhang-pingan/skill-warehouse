/** Validate native identities before an accepted reply can select the next execution target. */
function receiptFor(item,result) {
  const returned=result?.thread?.id ?? result?.threadId
  const expected=item.params?.threadId
  const id=value=>typeof value==='string' && value.trim().length>0
  const invalid=message=>{throw Object.assign(new Error(message),{deliveryUnknown:true})}
  if (result?.thread?.id!==undefined && result?.threadId!==undefined && result.thread.id!==result.threadId) invalid('Codex returned conflicting thread identities')
  if (['thread/start','thread/fork','thread/resume'].includes(item.method) && !id(returned)) invalid('Codex thread reply has no usable thread identity')
  if (returned!==undefined && !id(returned)) invalid('Codex returned an invalid thread identity')
  if (expected && returned && item.method!=='thread/fork' && returned!==expected) invalid('Codex reply does not match the requested thread')
  if (item.method==='thread/fork' && returned===expected) invalid('Codex fork returned the source thread instead of a new thread')
  if (item.method==='thread/fork' && Object.hasOwn(result?.thread ?? {},'forkedFromId') && result.thread.forkedFromId!==expected) invalid('Codex fork returned a different source thread')
  const turnId=item.method==='turn/start' ? result?.turn?.id : null
  if (item.method==='turn/start' && !id(turnId)) invalid('Codex turn reply has no usable turn identity')
  return {threadId:returned ?? expected,turnId}
}

export class OutboxDispatcher {
  constructor(ledger, adapter, { logger = console } = {}) {
    this.ledger = ledger
    this.adapter = adapter
    this.logger = logger
  }

  async dispatchOnce(limit = 10, { outboxId = null } = {}) {
    if (!this.adapter.initialized) return { claimed: 0, acknowledged: 0, uncertain: 0, failed: 0, outcomes: [] }
    const items = outboxId ? this.ledger.claimOutboxById(outboxId) : this.ledger.claimOutbox(limit)
    const summary = { claimed: items.length, acknowledged: 0, uncertain: 0, failed: 0, outcomes: [] }
    for (const item of items) {
      let received=false,result=null
      try {
        result = await this.adapter.request(item.method, item.params)
        received=true
        const {threadId,turnId}=receiptFor(item,result)
        this.ledger.database.transaction(()=>{
          this.ledger.resolveOutbox(item.outbox_id, 'acknowledged', { result })
          if (threadId) {
            const session = this.ledger.upsertSession({ system: 'codex', externalId: threadId, sourceKind: ['thread/start','thread/fork','thread/resume'].includes(item.method) ? 'app_server_thread' : null, cwd: result?.cwd ?? result?.thread?.cwd ?? item.params?.cwd ?? null, durability: 'durable' })
            this.ledger.attachExecutionSession(item.execution_id, session.sessionRefId, { role: 'executor' })
          }
          if (turnId) {
            const turn = this.ledger.upsertSession({ system: 'codex', externalId: turnId, sourceKind: 'app_server_turn', cwd: result?.cwd ?? result?.thread?.cwd ?? item.params?.cwd ?? null, durability: 'durable' })
            this.ledger.attachExecutionSession(item.execution_id, turn.sessionRefId, { role: 'executor' })
          }
        })
        summary.acknowledged += 1
        summary.outcomes.push({ outboxId: item.outbox_id, executionId: item.execution_id, state: 'acknowledged', result })
      } catch (error) {
        const uncertain=received || error.deliveryUnknown
        this.ledger.database.transaction(()=>{
          this.ledger.resolveOutbox(item.outbox_id,uncertain?'uncertain':'failed',{result,error:error.message})
          const execution=this.ledger.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(item.execution_id)
          if (uncertain && ['running','waiting_approval','waiting_user'].includes(execution.execution_state)) this.ledger.transitionExecution(item.execution_id,'reconciling',{expectedState:execution.execution_state})
        })
        const state=uncertain?'uncertain':'failed'
        summary[state] += 1
        summary.outcomes.push({ outboxId: item.outbox_id, executionId: item.execution_id, state, error: error.message })
      }
    }
    return summary
  }
}
