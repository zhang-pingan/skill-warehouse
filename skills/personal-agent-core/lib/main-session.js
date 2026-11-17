/** Host-owned identity for the single assistant conversation shared by desktop and WeChat. */
import { randomUUID } from 'node:crypto'
import { nowIso } from './ids.js'
import { assistantContextMessage, isAssistantContext } from './assistant-context.js'

const fail = (code, message, details = {}) => Object.assign(new Error(message), { code, statusCode: 409, ...details })

export class MainSession {
  constructor(service, projection) {
    this.service = service
    this.ctx = service.context
    this.db = service.database.db
    this.projection = projection
    this.pending = null
  }

  binding() { return this.db.prepare('SELECT * FROM main_session_binding WHERE singleton=1').get() ?? null }

  /** Coalesce desktop and channel acquisition without replacing a broken or archived target. */
  ensure() {
    if (this.pending) return this.pending
    this.pending = this.acquire().finally(() => { this.pending = null })
    return this.pending
  }

  async acquire() {
    let binding = this.binding()
    if (!binding) {
      this.db.prepare("INSERT OR IGNORE INTO main_session_binding VALUES(1,?,1,'creating',?)").run(randomUUID(), nowIso())
      binding = this.binding()
    }
    if (this.ctx.workspaceRegistry.archivedSessionIds.includes(binding.session_id)) throw fail('MAIN_SESSION_ARCHIVED', '主会话已归档，请在桌面恢复后重试。')
    const stored = await this.ctx.sessionPersistence.stat(binding.session_id)
    if (!stored && !this.ctx.agents.get(binding.session_id)) {
      if (binding.state !== 'creating') throw fail('MAIN_SESSION_MISSING', '主会话数据缺失，请恢复该会话数据后重试。')
      const initialized = await this.ctx.workspaceController.initializeDefault(this.service.workerLifetime.signal)
      const workspace = initialized?.workspace
      if (!workspace?.workspaceId) throw fail('MAIN_WORKSPACE_UNAVAILABLE', '无法初始化默认工作区，请先在桌面选择工作区。')
      const created = await this.ctx.sessionController.create({ sessionId: binding.session_id, workspaceId: workspace.workspaceId, agentPreset: 'standard' })
      if (created.sessionId !== binding.session_id) throw fail('MAIN_SESSION_CONFLICT', '主会话创建结果异常，已停止连接，请检查会话存储后重试。')
      await this.ctx.sessionPersistence.flush()
    }
    const resolved = await this.ctx.sessionController.resolveAgent(binding.session_id)
    if ('error' in resolved) throw fail('MAIN_SESSION_UNAVAILABLE', '无法恢复主会话，请在桌面检查该会话。')
    const agent = resolved.agent
    if (this.ctx.agentPresets.presetForSession(agent.session) !== 'standard') throw fail('MAIN_SESSION_PRESET', '主会话需要标准模式，请在桌面修正后重试。')
    const contextLoaded = this.projection.stateOf(agent.session).contextLoaded
    const pendingContext = agent.inbox.nextStep.filter(isAssistantContext)
    // Remove only redundant pending copies; committed conversation history remains intact.
    if (pendingContext.length > (contextLoaded ? 0 : 1)) {
      const retained = agent.inbox.nextStep.filter(message => !isAssistantContext(message) || !contextLoaded && message.id === pendingContext[0].id)
      agent.inbox.splice('next-step', 0, agent.inbox.nextStep.length, retained)
    }
    // A running pre-step may already have claimed the context without committing its message yet.
    if (!contextLoaded && pendingContext.length === 0 && agent.status !== 'running') agent.inject(assistantContextMessage())
    await this.ctx.sessionPersistence.flush()
    this.service.ledger.upsertSession({ system: 'dsh', externalId: binding.session_id, sourceKind: 'interaction', durability: 'durable' })
    this.db.prepare("UPDATE main_session_binding SET state='ready',updated_at=? WHERE singleton=1 AND session_id=?").run(nowIso(), binding.session_id)
    return { sessionId: binding.session_id, agentPreset: 'standard', version: binding.version, agent }
  }
}
