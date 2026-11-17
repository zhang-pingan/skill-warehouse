/** One-shot, owner-bound WeChat answers for native DSH question and approval requests. */
import { randomBytes } from 'node:crypto'
import { nowIso } from './ids.js'

const id = () => randomBytes(6).toString('hex')
const labels = Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index))
const sessionOf = request => request?.agent?.session?.id ?? request?.agent?.id ?? null

export class WechatInteractions {
  constructor(channel) { this.channel = channel; this.pending = new Map(); this.forwarded = new WeakSet(); this.operations = new Set(); this.disposed = false }
  view() {
    return [...this.pending.values()].map(card => ({ id: card.id, kind: card.kind, expiresAt: card.expiresAt, prompt: card.prompt }))
  }
  sessionId() { return this.channel.store.channel().session_id }
  offer(kind, request, next, delegate = next) {
    if (this.forwarded.has(request)) return next()
    return this.offerRequest(kind, request, next, delegate)
  }
  offerRequest(kind, request, next, delegate) {
    const sessionId = sessionOf(request)
    const channel = this.channel.store.channel()
    if (this.disposed || !this.channel.config.wechatEnabled || !this.channel.lifetime || this.channel.lifetime.signal.aborted ||
      kind === 'question' && request.questions.some(question => question.intent || (question.options?.length ?? 0) > labels.length || !question.options?.length && request.questions.length > 1) ||
      kind === 'approval' && !this.channel.config.wechatRemoteApprovalEnabled ||
      !channel.owner_id || !sessionId || sessionId !== channel.session_id || request.signal?.aborted) return next()
    const call = kind === 'approval' && request.callId ? this.channel.projection.stateOf(request.agent.session).current?.calls.find(item => item.id === request.callId && item.name === request.toolName) : null
    if (kind === 'approval' && request.callId && !call) return next()
    const cardId = id()
    const expiresAt = Date.now() + this.channel.config.wechatInteractionTtlMs
    const payload = kind === 'question'
      ? request.questions.map((question, q) => `${q + 1}. ${question.question}\n${question.detail ?? ''}\n${(question.options ?? []).map((option, i) => `${labels[i]}. ${option.label}${option.description ? `：${option.description}` : ''}`).join('\n')}`).join('\n\n') +
        `\n回复 /wx-answer ${cardId} ${request.questions.map((q, index) => q.options?.length ? `${index + 1}:A` : '-- 你的回答').join(' ')}。多选用 A,B；单题可用 -- 后接自由文本。`
      : `主会话请求一次性权限：${request.toolName ?? '操作'}\n${request.reason ?? ''}${call ? `\n工具调用参数：${call.arguments}` : ''}\n回复 /wx-approval ${cardId} allow 或 /wx-approval ${cardId} deny。`
    if (kind === 'approval' && Array.from(payload).length > this.channel.config.wechatMessageChars) return next()
    const controller = new AbortController()
    const forwarded = { ...request, signal: controller.signal }
    this.forwarded.add(forwarded)
    const card = { id: cardId, kind, sessionId, expiresAt, request: forwarded, resolve: null, prompt: payload, timer: null }
    const answer = new Promise(resolve => { card.resolve = resolve })
    try {
      this.channel.service.database.transaction(() => {
        this.channel.store.db.prepare('INSERT INTO wechat_interactions(interaction_id,generation,account_id,peer_id,session_id,kind,details_json,state,expires_at,created_at) VALUES(?,?,?,?,?,?,?,\'pending\',?,?)')
          .run(cardId, channel.generation, channel.account_id, channel.owner_id, sessionId, kind, JSON.stringify(kind === 'question' ? request.questions : { toolName: request.toolName, reason: request.reason, ...(call ? { callId: call.id, arguments: call.arguments } : {}) }), new Date(expiresAt).toISOString(), nowIso())
        this.channel.store.enqueue(`interaction-${cardId}`, payload, { kind: 'interaction' })
      })
    } catch (error) {
      this.channel.report(error)
      return next()
    }
    this.pending.set(cardId, card)
    const abort = () => this.withdrawCard(cardId, 'interrupted')
    card.timer = setTimeout(() => this.withdrawCard(cardId, 'expired'), Math.max(0, expiresAt - Date.now()))
    card.timer.unref?.()
    request.signal?.addEventListener('abort', abort, { once: true })
    if (request.signal?.aborted) abort()
    this.channel.kick()
    const operation = this.race(cardId, card, request, forwarded, controller, abort, answer, delegate, kind)
    this.operations.add(operation)
    operation.finally(() => this.operations.delete(operation)).catch(() => {})
    return operation
  }
  async race(cardId, card, request, forwarded, controller, abort, answer, delegate, kind) {
    const gui = Promise.resolve().then(() => delegate(forwarded)).then(value => ({ source: 'desktop', value }), error => ({ source: 'desktop', error }))
    void gui.then(result => {
      if (result.value !== 'unavailable' && result.error?.code !== 'NO_PROVIDER') this.settle(cardId, result, 'settled', 'desktop')
    }).catch(error => { card.resolve({ source: 'desktop', error }) })
    try {
      const winner = await answer
      if (winner.source === 'closed' && kind === 'approval') return 'cancelled'
      if (winner.error) throw winner.error
      return winner.value
    } finally {
      controller.abort(new Error('WeChat interaction settled'))
      await gui
      request.signal?.removeEventListener('abort', abort)
      this.forwarded.delete(forwarded)
    }
  }
  question(request, next, delegate) { return this.offer('question', request, next, delegate) }
  approval(request, next, delegate) { return this.offer('approval', request, next, delegate) }

  /** Persist the winner before granting permission or returning an answer to the native caller. */
  settle(cardId, value, state, source = 'wechat') {
    const card = this.pending.get(cardId)
    try {
      this.channel.service.database.transaction(() => {
        this.channel.store.db.prepare("UPDATE wechat_interactions SET state=? WHERE interaction_id=? AND state='pending'").run(state, cardId)
        this.channel.store.db.prepare("UPDATE wechat_outbox SET state='cancelled' WHERE kind='interaction' AND id GLOB ? AND state IN ('pending','waiting','failed')").run(`*:interaction-${cardId}:*`)
      })
    } catch (error) {
      if (card) this.releaseCard(card, { source: 'failed', error })
      throw error
    }
    if (card) this.releaseCard(card, source === 'desktop' ? value : value === null
      ? { source: 'closed', error: Object.assign(new Error('微信提问已取消或超时，请在桌面重新发起。'), { name: 'UserQuestionError', code: 'ASK_ABORTED' }) }
      : { source: 'wechat', value })
  }
  releaseCard(card, result) {
    this.pending.delete(card.id)
    clearTimeout(card.timer)
    card.resolve(result)
  }
  withdrawCard(cardId, state) {
    try { this.settle(cardId, null, state) }
    catch (error) { this.channel.service.logger?.warn?.('WeChat interaction could not persist withdrawal', error) }
  }

  async answer(inbound) {
    const parts = inbound.text.trim().split(/\s+/)
    const interactionId = parts[1]
    const card = this.pending.get(interactionId)
    const persisted = interactionId && this.channel.store.db.prepare('SELECT * FROM wechat_interactions WHERE interaction_id=?').get(interactionId)
    const channel = this.channel.store.channel()
    if (card?.request.signal?.aborted || !persisted || persisted.state !== 'pending' || persisted.expires_at <= new Date().toISOString()
      || persisted.generation !== channel.generation || persisted.account_id !== channel.account_id || persisted.peer_id !== inbound.peer || persisted.session_id !== channel.session_id) {
      this.channel.store.enqueue(`stale-${inbound.id}`, '该提问或审批已结束、过期或不属于此微信账号，请在桌面查看当前状态。', { kind: 'status' })
      this.channel.store.inbound(inbound.id, 'command')
      return
    }
    const expected = persisted.kind === 'approval' ? '/wx-approval' : '/wx-answer'
    if (parts[0] !== expected) throw new TypeError(`该请求需要使用 ${expected}。`)
    const details = JSON.parse(persisted.details_json)
    if (persisted.kind === 'approval' && details.source === 'codex') {
      if (!this.channel.config.wechatRemoteApprovalEnabled) throw new TypeError('微信远程审批已关闭，请在桌面处理当前审批。')
      if (parts.length !== 3 || !['allow', 'deny'].includes(parts[2])) throw new TypeError('请使用 allow 或 deny；远程审批可能已在桌面关闭。')
      const approval = this.channel.service.database.db.prepare("SELECT approval_state FROM approvals WHERE approval_id=?").get(details.approvalId)
      if (!approval || approval.approval_state !== 'pending') throw new Error('Codex 审批已结束或连接已变化，请在桌面查看。')
      const allowed = parts[2] === 'allow'
      let response
      if (details.method === 'item/commandExecution/requestApproval' || details.method === 'item/fileChange/requestApproval') {
        const choices = details.scope.request?.availableDecisions ?? details.scope.availableDecisions ?? ['accept', 'decline']
        const decision = allowed ? (choices?.includes('accept') ? 'accept' : null)
          : choices?.includes('decline') ? 'decline' : choices?.includes('cancel') ? 'cancel' : null
        if (!decision) throw new Error('此请求不接受该决定，请在桌面处理当前审批。')
        response = { decision }
      } else if (details.method === 'item/permissions/requestApproval') {
        if (allowed && (!details.scope.permissions || typeof details.scope.permissions !== 'object' || Array.isArray(details.scope.permissions))) throw new Error('权限范围不可验证，请在桌面处理当前审批。')
        response = { permissions: allowed ? details.scope.permissions : {}, scope: 'turn' }
      } else throw new Error('此类 Codex 请求必须在桌面处理。')
      await this.channel.service.operate({ action: 'decide_approval', approvalId: details.approvalId, decision: allowed ? 'approved' : 'denied', response }, { actor: 'wechat', approvalAuthority: true })
      this.settle(interactionId, null, 'answered')
    } else if (card?.kind === 'approval') {
      if (!this.channel.config.wechatRemoteApprovalEnabled || parts.length !== 3) throw new TypeError('微信远程审批已关闭或格式无效，请在桌面处理。')
      const outcome = parts[2] === 'allow' ? 'allowed-once' : parts[2] === 'deny' ? 'rejected' : null
      if (!outcome) throw new TypeError('请使用 allow 或 deny。')
      this.settle(card.id, outcome, 'answered')
    } else if (card?.kind === 'question') {
      const answers = []
      const separator = parts.indexOf('--')
      const answerParts = parts.slice(2, separator < 0 ? undefined : separator)
      const custom = separator < 0 ? undefined : parts.slice(separator + 1).join(' ')
      if (separator >= 0 && (!custom || card.request.questions.length !== 1)) throw new TypeError('自由文本只支持单题，请在 -- 后填写回答。')
      const byQuestion = new Map()
      for (const part of answerParts) {
        if (!/^[1-9]\d*:[A-Z](?:,[A-Z])*$/.test(part)) throw new TypeError('请按 1:A 或 1:A,B 的格式回答。')
        const [number, options] = part.split(':')
        const q = Number(number)
        if (q > card.request.questions.length || byQuestion.has(q)) throw new TypeError('题号超出范围或重复。')
        const selections = options.split(',')
        if (new Set(selections).size !== selections.length) throw new TypeError('同一选项不能重复。')
        byQuestion.set(q, selections)
      }
      for (const [index, question] of card.request.questions.entries()) {
        const selections = byQuestion.get(index + 1) ?? []
        if ((!selections.length && !custom) || selections.some(selection => !labels.slice(0, question.options?.length ?? 0).includes(selection))
          || question.multiSelect !== true && (selections.length > 1 || custom && selections.length)) throw new TypeError('请完整回答每题；单选题请在选项与自由文本中选择一种回答方式。')
        answers.push({ id: question.id, selected: selections.map(selection => question.options[labels.indexOf(selection)].label), ...(custom ? { custom } : {}) })
      }
      this.settle(card.id, { answers }, 'answered')
    } else throw new Error('提问已结束或不能在微信恢复，请在桌面查看。')
    this.channel.store.inbound(inbound.id, 'command')
    this.channel.store.enqueue(`settled-${inbound.id}`, '已提交，桌面与微信共用同一请求状态。', { kind: 'status' })
  }

  isCommand(text) { return /^\/wx-(?:answer|approval)\s/.test(text.trim()) }
  /** Check live approval state immediately before external send admission. */
  canSend(row) {
    if (row.kind !== 'interaction') return true
    const interactionId = row.id.split(':')[1]?.replace(/^interaction-/, '')
    const card = this.channel.store.db.prepare('SELECT * FROM wechat_interactions WHERE interaction_id=?').get(interactionId ?? '')
    if (!card || card.state !== 'pending') return false
    const details = JSON.parse(card.details_json)
    let valid = card.expires_at > new Date().toISOString()
    if (details.source === 'codex') {
      const adapter = this.channel.service.approvals.adapter
      const approval = this.channel.store.db.prepare('SELECT * FROM approvals WHERE approval_id=?').get(details.approvalId)
      valid &&= !!adapter?.initialized && approval?.approval_state === 'pending' && approval.adapter_instance_id === adapter.adapterInstanceId && approval.connection_epoch === adapter.connectionEpoch
    } else valid &&= this.pending.has(card.interaction_id)
    if (!valid) this.settle(card.interaction_id, null, 'expired')
    return valid
  }
  async captureCodex(target) {
    const channel = this.channel.store.channel()
    if (!this.channel.config.wechatRemoteApprovalEnabled || !channel.owner_id || target.sessionId !== channel.session_id) return []
    const adapter = this.channel.service.approvals.adapter
    const active = this.channel.store.db.prepare("SELECT * FROM wechat_interactions WHERE state='pending' AND json_extract(details_json,'$.source')='codex'").all()
    for (const card of active) {
      const details = JSON.parse(card.details_json)
      const row = this.channel.store.db.prepare('SELECT * FROM approvals WHERE approval_id=?').get(details.approvalId)
      if (!adapter.initialized || !row || row.approval_state !== 'pending' || row.adapter_instance_id !== adapter.adapterInstanceId || row.connection_epoch !== adapter.connectionEpoch || card.expires_at <= new Date().toISOString()) this.settle(card.interaction_id, null, 'expired')
    }
    if (!adapter.initialized) return []
    const rows = this.channel.store.db.prepare(`SELECT DISTINCT a.approval_id AS approvalId,a.kind,a.scope_json AS scopeJson,
      a.risk_summary AS riskSummary,a.requested_at AS requestedAt,a.expires_at AS expiresAt
      FROM approvals a JOIN executions e USING(execution_id)
      WHERE a.approval_state='pending' AND a.adapter_instance_id=? AND a.connection_epoch=?
      AND a.kind IN ('item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval')
      AND EXISTS(SELECT 1 FROM task_sessions ts JOIN session_refs sr USING(session_ref_id)
        WHERE ts.task_id=e.task_id AND sr.system='dsh' AND sr.external_id=?) ORDER BY a.requested_at`).all(adapter.adapterInstanceId, adapter.connectionEpoch, target.sessionId)
    const offered = []
    for (const row of rows) {
      const scope = JSON.parse(row.scopeJson)
      if (!scope.request || scope.request.availableDecisions != null && !Array.isArray(scope.request.availableDecisions)) continue
      if (row.kind === 'item/fileChange/requestApproval' && (!Array.isArray(scope.request.changes) || scope.request.changes.length === 0)) continue
      // Remote decisions must display the complete offered scope, including working directory.
      if (Array.from(row.scopeJson).length > this.channel.config.wechatMessageChars) continue
      const expiresAt = row.expiresAt ?? new Date(new Date(row.requestedAt).getTime() + this.channel.config.wechatInteractionTtlMs).toISOString()
      const current = this.channel.store.db.prepare("SELECT interaction_id,state FROM wechat_interactions WHERE generation=? AND json_extract(details_json,'$.approvalId')=? ORDER BY rowid DESC LIMIT 1").get(channel.generation, row.approvalId)
      if (current && current.state !== 'interrupted') continue
      const interactionId = id()
      if (new Date(expiresAt).getTime() <= Date.now()) {
        if (current) this.settle(current.interaction_id, null, 'expired')
        continue
      }
      const request = `${row.riskSummary}\n完整请求范围：${row.scopeJson}`
      const prompt = `Codex 一次性审批 ${interactionId}\n${request}\n回复 /wx-approval ${interactionId} allow 或 /wx-approval ${interactionId} deny。`
      if (Array.from(prompt).length > this.channel.config.wechatMessageChars) continue
      this.channel.service.database.transaction(() => {
        this.channel.store.enqueue(`interaction-${interactionId}`, prompt, { seq: -1, kind: 'interaction' })
        this.channel.store.db.prepare(`INSERT INTO wechat_interactions(interaction_id,generation,account_id,peer_id,session_id,kind,details_json,state,expires_at,created_at)
          VALUES(?,?,?,?,?,'approval',?,'pending',?,?) ON CONFLICT(interaction_id) DO NOTHING`)
          .run(interactionId, channel.generation, channel.account_id, channel.owner_id, channel.session_id,
            JSON.stringify({ source: 'codex', approvalId: row.approvalId, method: row.kind, scope, riskSummary: row.riskSummary }), expiresAt, nowIso())
      })
      offered.push(interactionId)
    }
    return offered
  }
  withdraw({ persisted = !!this.channel.releaseLock } = {}) {
    for (const [cardId] of this.pending) this.withdrawCard(cardId, 'interrupted')
    if (persisted) {
      this.channel.store.db.prepare("UPDATE wechat_interactions SET state='interrupted' WHERE state='pending'").run()
      this.channel.store.db.prepare("UPDATE wechat_outbox SET state='cancelled' WHERE kind='interaction' AND state IN ('pending','waiting','failed')").run()
    }
  }
  async dispose() { this.disposed = true; this.withdraw(); await Promise.allSettled(this.operations) }
}

/** Register scoped native answerers; copied requests have an independently cancellable desktop lifetime. */
export function registerWechatInteractions(ctx, ready, interactions) {
  return [['user-questions/request', 'question'], ['approval/request', 'approval']].map(([event, kind]) =>
    ctx.on(event, function (request, next) {
      const receiver = this
      return ready.then(() => interactions().offer(kind, request, next, forwarded =>
        ctx.waterfall(receiver, event, forwarded, () => {
          if (kind === 'approval') return Promise.resolve('unavailable')
          return Promise.reject(Object.assign(new Error('No desktop question provider accepted the request'), { name: 'UserQuestionError', code: 'NO_PROVIDER' }))
        })))
    }, { prepend: true }))
}
