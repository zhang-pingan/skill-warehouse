export class OutboxDispatcher {
  constructor(ledger, adapter, { logger = console } = {}) {
    this.ledger = ledger
    this.adapter = adapter
    this.logger = logger
    this.running = false
  }

  async dispatchOnce(limit = 10, { outboxId = null } = {}) {
    if (!this.adapter.initialized) return { claimed: 0, acknowledged: 0, uncertain: 0, failed: 0, outcomes: [] }
    const items = outboxId ? this.ledger.claimOutboxById(outboxId) : this.ledger.claimOutbox(limit)
    const summary = { claimed: items.length, acknowledged: 0, uncertain: 0, failed: 0, outcomes: [] }
    for (const item of items) {
      try {
        const result = await this.adapter.request(item.method, item.params)
        this.ledger.resolveOutbox(item.outbox_id, 'acknowledged', { result })
        const threadId = result?.thread?.id ?? result?.threadId ?? item.params?.threadId
        if (threadId) {
          const session = this.ledger.upsertSession({ system: 'codex', externalId: threadId, sourceKind: ['thread/start','thread/fork'].includes(item.method) ? 'app_server_thread' : null, cwd: result?.thread?.cwd ?? item.params?.cwd ?? null, durability: 'durable' })
          this.ledger.attachExecutionSession(item.execution_id, session.sessionRefId, { role: 'executor' })
        }
        if (result?.turn?.id) {
          const turn = this.ledger.upsertSession({ system: 'codex', externalId: result.turn.id, sourceKind: 'app_server_turn', cwd: result?.thread?.cwd ?? item.params?.cwd ?? null, durability: 'durable' })
          this.ledger.attachExecutionSession(item.execution_id, turn.sessionRefId, { role: 'executor' })
        }
        summary.acknowledged += 1
        summary.outcomes.push({ outboxId: item.outbox_id, executionId: item.execution_id, state: 'acknowledged', result })
      } catch (error) {
        if (error.deliveryUnknown) {
          this.ledger.resolveOutbox(item.outbox_id, 'uncertain', { error: error.message })
          summary.uncertain += 1
          summary.outcomes.push({ outboxId: item.outbox_id, executionId: item.execution_id, state: 'uncertain', error: error.message })
        } else {
          this.ledger.resolveOutbox(item.outbox_id, 'failed', { error: error.message })
          summary.failed += 1
          summary.outcomes.push({ outboxId: item.outbox_id, executionId: item.execution_id, state: 'failed', error: error.message })
        }
      }
    }
    return summary
  }
}
