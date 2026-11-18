/** User-confirmed main-conversation replacement with durable progress and preserved memory. */
import { randomUUID } from 'node:crypto'
import { nowIso } from './ids.js'
import { historyCheckpoint } from './history-work.js'

const JOB = 'main-session-reset'
const failure = (code, message) => Object.assign(new Error(message), { code, statusCode: 409 })

export class MainSessionReset {
  constructor(service, main) { this.service = service; this.main = main; this.operation = null }

  view() {
    const status = this.service.backgroundJobs.state(JOB)
    return { ...status, state: status.lastError ? 'failed' : status.state ?? 'idle', running: !!this.operation,
      sessionId: this.main.binding()?.session_id ?? null }
  }

  save(patch) { this.service.backgroundJobs.save({ ...this.service.backgroundJobs.state(JOB), ...patch, name: JOB }) }

  /** Repeated submissions for the same old session join one replacement, including after reconnect. */
  start({ confirmed, expectedSessionId } = {}) {
    if (confirmed !== true || typeof expectedSessionId !== 'string' || !expectedSessionId) throw new TypeError('请确认要清空的主会话。')
    this.service.assertMemoryAvailable()
    const status = this.view()
    if (this.operation) {
      if (status.oldSessionId !== expectedSessionId) throw failure('MAIN_SESSION_CHANGED', '主会话已变更，请刷新后重试。')
      return status
    }
    if (status.committed && status.oldSessionId === expectedSessionId) return status
    const binding = this.main.binding()
    if (!binding || binding.session_id !== expectedSessionId) throw failure('MAIN_SESSION_CHANGED', '主会话已变更，请刷新后重试。')
    this.assertIdle(binding.session_id)
    const retry = status.oldSessionId === expectedSessionId && status.newSessionId && !status.committed
    const archiveNumber = retry ? status.archiveNumber ?? 1 : (status.archiveNumber ?? 0) + 1
    if (!Number.isSafeInteger(archiveNumber)) throw failure('MAIN_ARCHIVE_LIMIT', '归档编号超出支持范围，请检查主会话记录。')
    const title = retry ? status.title ?? this.service.config.mainSessionTitle : this.service.config.mainSessionTitle
    this.save({ archiveNumber, title, archiveTitle: `${title}-废弃会话-${archiveNumber}`,
      oldTitle: retry ? status.oldTitle : null, renameOwned: retry ? status.renameOwned : false,
      state: 'running', phase: 'draining', running: true, lastError: null, startedAt: nowIso(), finishedAt: null,
      oldSessionId: expectedSessionId, oldVersion: binding.version,
      newSessionId: retry ? status.newSessionId : randomUUID(), newVersion: binding.version + 1,
      archiveOwned: retry ? status.archiveOwned : false, committed: false, channelError: null })
    this.operation = Promise.resolve().then(async () => {
      await this.main.pending
      await this.service.results?.pending
      const channel = this.service.wechat
      if (channel) return channel.serialize(() => this.replace(channel))
      return this.replace(null)
    }).catch(error => {
      this.save({ running: false, finishedAt: nowIso(), ...(this.view().committed
        ? { state: 'succeeded', lastError: null, channelError: '主会话已清空，但通道收尾失败，请在微信接入中检查连接状态。' }
        : { state: 'failed', lastError: String(error?.message ?? error) }) })
      this.service.logger?.warn?.('Personal-agent main session reset failed', error)
    }).finally(() => { this.operation = null })
    return this.view()
  }

  assertIdle(sessionId) {
    const agent = this.service.context.agents.get(sessionId)
    if (agent?.status === 'running') throw failure('MAIN_SESSION_BUSY', '主会话正在运行，请等待答复完成或先停止任务。')
    if (this.service.wechat?.loginLifetime) throw failure('WECHAT_LOGIN_BUSY', '正在扫码连接微信，请完成或取消扫码后重试。')
  }

  checkLifetime() {
    if (this.service.disposed) throw failure('MAIN_SESSION_RESET_STOPPED', '应用已停止，主会话清理未完成，请重新打开设置后重试。')
  }

  /** Archive admission before synchronizing messages; publish both targets in one ledger transaction. */
  async replace(channel) {
    const { service, main } = this
    const ctx = service.context
    const status = this.view()
    this.checkLifetime()
    this.assertIdle(status.oldSessionId)
    if (channel) channel.maintenance = true
    try {
      if (channel) { await channel.acquireAccountLock(); await channel.stop({ keepLock: true }) }
      this.checkLifetime()
      this.assertIdle(status.oldSessionId)
      this.save({ phase: 'syncing' })
      if (!ctx.workspaceRegistry.archivedSessionIds.includes(status.oldSessionId)) {
        this.save({ archiveOwned: true })
        await ctx.workspaceRegistry.archiveSession(status.oldSessionId)
      }
      this.assertIdle(status.oldSessionId)
      const resolved = await ctx.sessionController.resolveAgent(status.oldSessionId)
      if ('error' in resolved) throw failure('MAIN_SESSION_UNAVAILABLE', '无法恢复旧主会话，请检查会话数据后重试。')
      const oldTitle = status.oldTitle ?? ctx.sessionTitle.get(resolved.agent.session)?.title ?? status.title
      this.save({ oldTitle, renameOwned: true })
      main.renameAgent(resolved.agent, status.archiveTitle)
      await ctx.sessionPersistence.flush()
      while (service.importing) await service.importing
      const importing = (async () => {
        this.checkLifetime()
        const snapshot = await ctx.sessionPersistence.stat(status.oldSessionId)
        if (!snapshot) throw failure('MAIN_SESSION_MISSING', '旧主会话数据缺失，无法同步历史，已停止清理。')
        const result = await service.dshImporter.importStoredSession(ctx.sessionPersistence, snapshot,
          { checkpoint: historyCheckpoint(service.historyConfig, service.historyLifetime.signal) })
        if (!result || result.warning) throw failure('MAIN_HISTORY_INCOMPLETE', '旧主会话历史尚未同步完成，请检查会话数据后重试。')
        return result
      })()
      service.importing = importing
      try { await importing }
      finally { if (service.importing === importing) service.importing = null }
      this.checkLifetime()
      this.save({ phase: 'creating' })
      const target = await main.prepare({ session_id: status.newSessionId, version: status.newVersion, state: 'creating' })
      this.checkLifetime()
      const projection = main.projection.stateOf(target.agent.session)
      if (projection.current || projection.final || target.agent.status === 'running') throw failure('MAIN_SUCCESSOR_USED', '待启用的新会话已产生对话，请先在桌面检查该会话。')
      service.database.transaction(() => {
        const binding = main.binding()
        if (binding?.session_id !== status.oldSessionId || binding.version !== status.oldVersion) throw failure('MAIN_SESSION_CHANGED', '主会话已变更，已停止清理，请刷新后检查。')
        service.ledger.upsertSession({ system: 'dsh', externalId: target.sessionId, sourceKind: 'interaction', durability: 'durable' })
        main.db.prepare("UPDATE main_session_binding SET session_id=?,version=?,state='ready',updated_at=? WHERE singleton=1")
          .run(target.sessionId, target.version, nowIso())
        if (channel) {
          const old = channel.store.channel()
          channel.store.recover()
          channel.store.retireGeneration('主会话历史已清空；旧消息保留原目标，不再转入新会话。')
          channel.interactions.withdraw({ persisted: true })
          channel.store.update({ generation: old.generation + 1, session_id: old.owner_id ? target.sessionId : null,
            binding_version: old.owner_id ? target.version : null, start_seq: target.agent.session.seq - 1,
            observed_seq: target.agent.session.seq - 1, delivery_state_json: JSON.stringify(projection), last_error: null })
        }
        this.save({ state: 'succeeded', phase: 'done', committed: true, running: false, finishedAt: nowIso(), lastError: null })
      })
    } catch (error) {
      if (!this.view().committed && this.view().archiveOwned && main.binding()?.session_id === status.oldSessionId) {
        try {
          if (this.view().renameOwned) {
            const resolved = await ctx.sessionController.resolveAgent(status.oldSessionId)
            if ('error' in resolved) throw failure('MAIN_SESSION_UNAVAILABLE', '无法恢复旧主会话名称。')
            main.renameAgent(resolved.agent, this.view().oldTitle)
            await ctx.sessionPersistence.flush()
            this.save({ renameOwned: false })
          }
          await ctx.workspaceRegistry.unarchiveSession(status.oldSessionId)
          this.save({ archiveOwned: false })
        }
        catch (restoreError) { throw failure('MAIN_SESSION_RESTORE_FAILED', `${error.message} 旧主会话暂时仍处于归档状态，请在此重试。${restoreError.message}`) }
      }
      throw error
    } finally {
      if (channel) {
        channel.maintenance = false
        if (!service.disposed && !channel.closed) {
          try { await channel.syncNow() }
          catch (error) { channel.report(error); this.save({ channelError: '主会话处理已结束，但微信恢复连接失败，请在微信接入中刷新状态。' }) }
        } else await channel.releaseAccountLock()
      }
    }
  }
}
