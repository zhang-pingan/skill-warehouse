/** Host-owned WeChat supervision, persistent dispatch and explicit local account authorization. */
import path from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import lockfile from 'proper-lockfile'
import QRCode from 'qrcode'
import { WechatApi, WechatError, parseWechatUpdates, trustedWechatOrigin } from './wechat-api.js'
import { WechatStore } from './wechat-store.js'
import { nowIso, sha256 } from './ids.js'
import { WechatInteractions } from './wechat-interactions.js'
import { wechatProjection } from './wechat-projection.js'
import { WECHAT_API_BASE } from './wechat-config.js'

export class WechatChannel {
  constructor(service, projection, { api, clock = Date.now } = {}) {
    this.service = service
    this.ctx = service.context
    this.projection = projection
    this.clock = clock
    this.store = new WechatStore(service.database, service.config)
    this.api = api ?? new WechatApi(service.config)
    this.credentialKey = `personal-agent-core/wechat-${sha256(service.config.databasePath).slice(0, 24)}`
    this.status = 'disabled'
    this.errors = new Map()
    this.statusError = null
    this.lifetime = null
    this.loginLifetime = null
    this.loginWork = null
    this.loginView = null
    this.loginUserId = null
    this.receiveWork = null
    this.work = null
    this.retryTimer = null
    this.rerun = false
    this.releaseLock = null
    this.syncWork = Promise.resolve()
    this.closed = false
    this.maintenance = false
    this.management = Promise.resolve()
    this.interactions = new WechatInteractions(this)
  }

  get config() { return this.service.config }
  async credentials() { return (await this.ctx.credentials.readRecord(this.credentialKey))?.payload ?? null }
  async saveCredentials(mutate) { return this.ctx.credentials.modifyRecord(this.credentialKey, async current => ({ kind: 'grant', payload: await mutate(current?.payload ?? null) })) }
  report(error, source = 'work') {
    this.errors.set(source, error)
    this.refreshStatus()
    this.service.logger?.warn?.(`Personal-agent WeChat: ${error.code ?? 'OPERATION_FAILED'}`)
  }
  refreshStatus() {
    const error = this.errors.get('receive') ?? this.errors.get('work')
    const head = this.store.db.prepare("SELECT state,error FROM wechat_outbox WHERE generation=? AND state NOT IN ('accepted','cancelled') ORDER BY sequence LIMIT 1").get(this.store.channel().generation)
    if (error) {
      this.status = error.code === 'LOGIN_EXPIRED' ? 'login-required' : error.code === 'ELOCKED' ? 'occupied' : 'error'
      this.statusError = error.code === 'ELOCKED' ? '微信账号正在由另一个 Host 使用，请先在该 Host 停止通道。'
        : error instanceof WechatError ? error.message : '微信通道操作失败，已暂停相关操作，请检查连接或重新登录。'
    } else if (head && ['waiting','unknown','failed'].includes(head.state)) {
      this.status = head.state === 'waiting' ? 'waiting-interaction' : 'error'
      this.statusError = head.error
    } else {
      this.status = this.store.channel().owner_id ? 'connected' : 'binding-required'
      this.statusError = null
    }
    if (this.releaseLock) this.store.update({ last_error: this.statusError })
  }
  view() {
    const binding = this.service.mainSession.binding()
    const stored = this.store.view()
    const identityStatus = stored.ownerId ? this.loginUserId === stored.ownerId ? 'verified' : 'local'
      : !stored.accountId ? 'unbound' : !this.loginUserId ? 'scan-required'
        : stored.contacts.some(contact => contact.peerId !== this.loginUserId) ? 'mismatch' : 'waiting-message'
    return { ...stored, identityStatus, status: this.status, error: this.statusError, login: this.loginView, enabled: this.config.wechatEnabled,
      syncReplies: this.config.wechatSyncRepliesEnabled, mirrorUser: this.config.wechatMirrorUserEnabled, remoteApproval: this.config.wechatRemoteApprovalEnabled,
      mainSession: binding ? { sessionId: binding.session_id, version: binding.version, state: binding.state } : null,
      interactions: this.interactions.view() }
  }

  /** Serialize enable/disable/reconfiguration, draining the preceding generation first. */
  sync() {
    const next = this.serialize(() => this.syncNow())
    this.syncWork = next
    return next
  }

  async syncNow() {
    await this.stop()
    this.errors.clear()
    this.statusError = null
    this.store.config = this.config
    this.api.config = this.config
    if (this.closed || this.maintenance) { this.status = 'disabled'; return }
    const credential = await this.credentials()
    const state = this.store.channel()
    this.loginUserId = credential?.accountId === state.account_id && typeof credential.userId === 'string' && credential.userId.length > 0 && credential.userId.length <= 500 ? credential.userId : null
    if (!this.config.wechatEnabled) { this.status = 'disabled'; return }
    if (state.restore_hold) { this.status = 'restore-hold'; return }
    if (!credential || credential.accountId !== state.account_id) { this.status = 'login-required'; return }
    if (state.owner_id && this.loginUserId && state.owner_id !== this.loginUserId) { this.report(new WechatError('IDENTITY_MISMATCH', '已绑定身份与扫码账号不一致，收发已暂停，请重新扫码连接。')); return }
    const lifetime = new AbortController()
    const signal = lifetime.signal
    try { await this.acquireAccountLock(credential.accountId) }
    catch (error) { this.report(error); lifetime.abort(); return }
    this.lifetime = lifetime
    this.store.recover()
    this.interactions.withdraw({ persisted: true })
    this.status = state.owner_id ? 'connecting' : 'binding-required'
    this.receiveWork = this.receiveLoop(credential, signal).catch(error => { if (!signal.aborted) this.report(error) })
    this.kick()
  }

  /** Keep account ownership across local reconfiguration as well as network polling. */
  async acquireAccountLock(accountId = this.store.channel().account_id) {
    if (!accountId || this.releaseLock) return
    await mkdir(this.config.wechatLockDir, { recursive: true, mode: 0o700 })
    const file = path.join(this.config.wechatLockDir, sha256(accountId))
    await writeFile(file, '', { flag: 'a', mode: 0o600 })
    this.releaseLock = await lockfile.lock(file, { realpath: false, retries: 0, stale: 30000, update: 10000,
      onCompromised: error => { this.report(error); this.lifetime?.abort(); this.interactions.withdraw({ persisted: false }) } })
  }

  async releaseAccountLock() {
    const release = this.releaseLock
    this.releaseLock = null
    if (release) await release()
  }

  async stop({ keepLock = false } = {}) {
    clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.lifetime?.abort()
    this.interactions.withdraw()
    await Promise.allSettled([this.receiveWork, this.work, ...this.interactions.operations].filter(Boolean))
    this.receiveWork = null
    this.work = null
    this.lifetime = null
    if (!keepLock) await this.releaseAccountLock()
  }

  close() {
    if (!this.closing) this.closing = this.closeChannel()
    return this.closing
  }

  async closeChannel() {
    this.closed = true
    this.lifetime?.abort()
    this.interactions.withdraw()
    this.loginLifetime?.abort()
    await this.management.catch(() => {})
    await this.loginWork?.catch(() => {})
    await this.management.catch(() => {})
    await this.syncWork.catch(() => {})
    await this.stop()
  }

  async login() {
    await this.cancelLogin()
    await this.stop({ keepLock: true })
    this.loginLifetime = new AbortController()
    const signal = this.loginLifetime.signal
    try {
      const qr = await this.api.qr(signal)
      if (typeof qr.qrcode !== 'string' || typeof qr.qrcode_img_content !== 'string' || qr.qrcode_img_content.length > 10000) throw new WechatError('PROTOCOL', '微信登录二维码无效，请重新发起登录。')
      this.loginView = { status: 'waiting', image: await QRCode.toDataURL(qr.qrcode_img_content, { width: 240, margin: 2, errorCorrectionLevel: 'M' }) }
      signal.throwIfAborted()
      this.status = 'login-pending'
      this.loginWork = this.pollLogin(qr.qrcode, signal).catch(error => {
        void this.finishLogin(signal, async () => { this.loginView = { status: 'failed' }; this.report(error) }).catch(failure => { if (!this.closed) this.report(failure) })
      }).finally(() => { this.loginWork = null })
      return this.view()
    } catch (error) {
      this.loginLifetime?.abort()
      this.loginLifetime = null
      this.loginView = { status: 'failed' }
      await this.syncNow()
      if (!this.closed) this.report(error)
      throw error
    }
  }

  finishLogin(signal, action) {
    return this.serialize(async () => {
      try {
        if (!signal.aborted && !this.closed && !this.maintenance) await action()
      } finally {
        if (this.loginLifetime?.signal === signal) this.loginLifetime = null
        if (!this.lifetime && !this.loginLifetime) await this.releaseAccountLock()
      }
    })
  }

  async pollLogin(qrcode, signal) {
    const expires = this.clock() + 300000
    while (!signal.aborted && this.clock() < expires) {
      const result = await this.api.qrStatus(qrcode, signal)
      if (result.status === 'confirmed') {
        if (![result.bot_token, result.ilink_bot_id].every(value => typeof value === 'string' && value.length > 0 && value.length < 32768)) throw new WechatError('PROTOCOL', '微信登录响应缺少账号或凭证。')
        if (result.ilink_user_id !== undefined && (typeof result.ilink_user_id !== 'string' || !result.ilink_user_id || result.ilink_user_id.length > 500)) throw new WechatError('PROTOCOL', '微信登录返回的扫码身份无效，请重新扫码。')
        const baseUrl = trustedWechatOrigin(result.baseurl ?? WECHAT_API_BASE, WECHAT_API_BASE)
        signal.throwIfAborted()
        void this.finishLogin(signal, async () => {
          await this.acquireAccountLock()
          await this.stop({ keepLock: true })
          await this.saveCredentials(() => ({ accountId: result.ilink_bot_id, token: result.bot_token, baseUrl, ...(result.ilink_user_id ? { userId: result.ilink_user_id } : {}), peers: {} }))
          this.service.database.transaction(() => {
            const old = this.store.channel()
            this.store.db.prepare("UPDATE wechat_outbox SET state='cancelled',error='账号重新绑定；旧内容不发送给新身份。' WHERE state IN ('pending','waiting','failed')").run()
            this.store.db.prepare("UPDATE wechat_inbox SET state='held',error='登录身份已变更，请在桌面核对。' WHERE state IN ('pending','dispatching')").run()
            this.store.update({ account_id: result.ilink_bot_id, owner_id: null, generation: old.generation + 1, cursor: '', session_id: null, binding_version: null, start_seq: -1, observed_seq: -1, last_error: null })
          })
          this.loginView = { status: 'confirmed' }
          if (!signal.aborted) await this.syncNow()
        }).catch(error => { if (!signal.aborted) this.report(error) })
        return
      }
      if (result.status === 'expired') throw new WechatError('QR_EXPIRED', '微信二维码已过期，请重新扫码。')
      this.loginView = { ...this.loginView, status: result.status === 'scaned' || result.status === 'scanned' ? 'scanned' : 'waiting' }
      await delay(1500, undefined, { signal, ref: false })
    }
    if (!signal.aborted) throw new WechatError('QR_EXPIRED', '微信登录已超时，请重新扫码。')
  }

  async cancelLogin() { this.loginLifetime?.abort(); await this.loginWork; this.loginWork = null; this.loginLifetime = null; this.loginView = null }

  /** Bind only a sender matching the authenticated scanner, while the receive lifetime owns the account lock. */
  async bindVerifiedOwner(peerId, signal) {
    signal.throwIfAborted()
    const channel = this.store.channel()
    if (!this.releaseLock || !this.loginUserId || peerId !== this.loginUserId || channel.owner_id) throw new WechatError('IDENTITY_MISMATCH', '微信发送者与扫码账号不一致，未连接主会话。')
    const target = await this.service.mainSession.ensure()
    await this.ctx.sessionPersistence.flush()
    signal.throwIfAborted()
    this.service.database.transaction(() => {
      this.store.retireGeneration('扫码身份已验证；旧输入和输出保持原目标。')
      this.store.update({ owner_id: peerId, generation: channel.generation + 1, session_id: target.sessionId, binding_version: target.version,
        start_seq: target.agent.session.seq - 1, observed_seq: target.agent.session.seq - 1, delivery_state_json: JSON.stringify(this.projection.stateOf(target.agent.session)), last_error: null })
    })
  }

  async unlink(confirmed) {
    if (confirmed !== true) throw new TypeError('解绑微信需要本地确认。')
    await this.cancelLogin()
    await this.stop({ keepLock: true })
    await this.ctx.credentials.deleteRecord(this.credentialKey)
    this.loginUserId = null
    const state = this.store.channel()
    this.service.database.transaction(() => {
      this.store.retireGeneration('微信已解绑；旧内容保持原身份，不再发送。')
      this.store.update({ generation: state.generation + 1, account_id: null, owner_id: null, cursor: '', session_id: null, binding_version: null, last_error: null })
    })
    this.status = 'login-required'
    return this.view()
  }

  async receiveLoop(credential, signal) {
    let failures = 0
    while (!signal.aborted) {
      try {
        const data = await this.api.updates(credential, this.store.channel().cursor, signal)
        signal.throwIfAborted()
        await this.acceptBatch(parseWechatUpdates(data), signal)
        failures = 0
        this.errors.delete('receive')
        this.refreshStatus()
        this.kick()
      } catch (error) {
        if (signal.aborted) return
        this.report(error, 'receive')
        if (error.code === 'QUEUE_FULL') this.kick()
        if (['LOGIN_EXPIRED','PROTOCOL','MESSAGE_ID','MESSAGE_SIZE'].includes(error.code)) return
        failures += 1
        await delay(Math.min(this.config.wechatBackoffMaxMs, 1000 * 2 ** Math.min(failures, 10)), undefined, { signal, ref: false }).catch(error => { if (!signal.aborted) throw error })
      }
    }
  }

  /** Commit accepted identities before advancing the pull cursor; replay fills any remaining slots. */
  async acceptBatch(batch, signal = this.lifetime?.signal) {
    if (!this.store.channel().owner_id && this.loginUserId && batch.messages.some(msg => msg.peer === this.loginUserId)) await this.bindVerifiedOwner(this.loginUserId, signal)
    const channel = this.store.channel()
    for (const msg of batch.messages) {
      if (!channel.owner_id) {
        const contacts = this.store.db.prepare('SELECT peer_id FROM wechat_contacts WHERE account_id=?').all(channel.account_id).map(row => row.peer_id)
        if (!contacts.includes(msg.peer) && contacts.length >= 16) continue
        this.store.db.prepare('INSERT INTO wechat_contacts VALUES(?,?,?) ON CONFLICT(account_id,peer_id) DO UPDATE SET seen_at=excluded.seen_at').run(channel.account_id, msg.peer, nowIso())
        continue
      } else if (msg.peer !== channel.owner_id || !msg.text.trim() && !msg.unsupported) continue
      if (this.store.db.prepare('SELECT 1 FROM wechat_inbox WHERE account_id=? AND peer_id=? AND external_id=?').get(channel.account_id, msg.peer, msg.externalId)) continue
      if (channel.owner_id) this.store.capacity(1, 'inbox')
      if (msg.contextToken) await this.saveCredentials(current => {
        if (current?.accountId !== channel.account_id) throw new WechatError('ACCOUNT_CHANGED', '微信账号已更换，已停止旧连接。')
        const allowed = channel.owner_id ? [channel.owner_id] : this.store.db.prepare('SELECT peer_id FROM wechat_contacts WHERE account_id=?').all(channel.account_id).map(row => row.peer_id)
        const peers = Object.fromEntries(Object.entries(current.peers ?? {}).filter(([peer]) => allowed.includes(peer)))
        if (peers[msg.peer]?.externalId !== msg.externalId) peers[msg.peer] = { contextToken: msg.contextToken, externalId: msg.externalId, at: this.clock(), sent: 0 }
        return { ...current, peers }
      })
      if (!channel.owner_id) continue
      this.service.database.transaction(() => {
        this.store.capacity(1, 'inbox')
        const id = sha256(`${channel.account_id}\0${msg.peer}\0${msg.externalId}`)
        this.store.db.prepare("INSERT INTO wechat_inbox VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?,?)").run(id, channel.generation, channel.account_id, msg.peer, msg.externalId, channel.session_id, channel.binding_version, `wx-${id}`, msg.text, msg.unsupported ? 'command' : 'pending', nowIso(), nowIso())
        if (msg.unsupported) this.store.enqueue(`unsupported-${id}`, '目前仅支持纯文字消息。本条包含暂不支持的内容，整条消息未提交给助理，请改发纯文字。', { kind: 'status' })
      })
    }
    this.service.database.transaction(() => this.store.update({ cursor: batch.cursor }))
  }

  /** Queue pressure cannot prevent accepted output from draining; each pump has one owner. */
  kick() {
    if (this.closed || !this.lifetime || this.lifetime.signal.aborted) return this.work
    if (this.work) { this.rerun = true; return this.work }
    const signal = this.lifetime.signal
    this.work = Promise.resolve().then(async () => {
      do {
        this.rerun = false
        const errors = []
        for (const operation of [() => this.dispatch(signal), () => this.reconcile(signal)]) {
          try { await operation() }
          catch (error) {
            if (signal.aborted || error.code === 'BINDING_CHANGED' || error.code?.startsWith('MAIN_')) throw error
            errors.push(error)
          }
        }
        const sent = await this.sendPending(signal)
        this.store.prune()
        if (errors.length) this.report(errors[0])
        else if (!signal.aborted) { this.errors.delete('work'); this.refreshStatus() }
        if (sent > 0 && errors.some(error => error.code === 'QUEUE_FULL')) this.rerun = true
      } while (this.rerun && !signal.aborted)
    }).catch(error => { if (!signal.aborted) this.report(error) }).finally(() => {
      this.work = null
      if (this.rerun && !signal.aborted) { this.rerun = false; this.kick() }
    })
    return this.work
  }

  /** Validate the shared destination without waking or restoring an idle Agent. */
  boundSession() {
    const channel = this.store.channel()
    if (!channel.owner_id) return null
    const binding = this.service.mainSession.binding()
    if (!binding || binding.state !== 'ready' || binding.session_id !== channel.session_id || binding.version !== channel.binding_version) throw new WechatError('BINDING_CHANGED', '主会话绑定不一致，已暂停微信收发，请在桌面检查。')
    if (this.ctx.workspaceRegistry.archivedSessionIds.includes(binding.session_id)) throw new WechatError('MAIN_SESSION_ARCHIVED', '主会话已归档，请在桌面恢复后重试。')
    return { sessionId: binding.session_id, version: binding.version }
  }

  async target() {
    const binding = this.boundSession()
    if (!binding) return null
    const target = await this.service.mainSession.ensure()
    if (target.sessionId !== binding.sessionId || target.version !== binding.version) throw new WechatError('BINDING_CHANGED', '主会话绑定不一致，已暂停微信收发，请在桌面检查。')
    return target
  }

  async dispatch(signal) {
    const channel = this.store.channel()
    if (!channel.owner_id) return
    const rows = this.store.db.prepare("SELECT * FROM wechat_inbox WHERE generation=? AND state IN ('pending','dispatching') ORDER BY rowid").all(channel.generation)
    if (!rows.length) return
    const target = await this.target()
    if (!target) return
    for (const row of rows) {
      signal.throwIfAborted()
      if (row.session_id !== target.sessionId || row.binding_version !== target.version) { this.store.inbound(row.id, 'held', '主会话绑定已变化。'); continue }
      if (row.text.trim().startsWith('/wx-')) { await this.command({ ...row, text: row.text.trim(), peer: row.peer_id }, target); continue }
      this.store.inbound(row.id, 'dispatching')
      try {
        await this.ctx.sessionController.prompt({ sessionId: row.session_id, requestId: row.request_id, mode: 'queue', content: [{ type: 'text', text: row.text }] }, signal)
        await this.ctx.sessionPersistence.flush()
        this.store.inbound(row.id, 'accepted')
      } catch (error) {
        // A successful admission with a failed flush is reconciled using the same native request id.
        this.store.inbound(row.id, 'dispatching', '原生输入接受结果待核对，将沿用原请求身份恢复。')
        throw error
      }
    }
  }

  async reconcile(signal) {
    const target = this.boundSession()
    if (!target) return
    await this.ctx.sessionPersistence.flush()
    signal.throwIfAborted()
    if (!await this.ctx.sessionPersistence.stat(target.sessionId)) throw new WechatError('MAIN_SESSION_MISSING', '主会话数据缺失，请恢复该会话数据后重试。')
    const handle = await this.ctx.sessionPersistence.open(target.sessionId, 'read')
    try {
      while (!signal.aborted) {
        const channel = this.store.channel()
        const page = await handle.read(channel.observed_seq + 1, 500, { signal })
        if (page.events.length === 0) break
        const { pendingOutput, ...checkpoint } = JSON.parse(channel.delivery_state_json)
        let state = { ...wechatProjection.init(), ...checkpoint }
        for (const event of page.events) {
          const complete = this.service.database.transaction(() => {
            const enqueue = (key, text, kind) => {
              const segmentChars = pendingOutput?.key === key ? pendingOutput.segmentChars : this.config.wechatMessageChars
              if (!Number.isInteger(segmentChars) || segmentChars < 100 || segmentChars > 4000) throw new WechatError('DELIVERY_CHECKPOINT', '微信分段记录无效，已暂停续传，请在桌面检查。')
              const done = this.store.enqueue(key, text, { seq: event.seq, kind, partial: true, segmentChars })
              if (!done) this.store.update({ delivery_state_json: JSON.stringify({ ...state, pendingOutput: { key, segmentChars } }) })
              return done
            }
            const next = wechatProjection.apply(state, event)
            if (event.type === 'user/message' && event.surfaceOp === 'append' && event.data.source.kind === 'user') {
              const requestId = event.data.source.rpcId
              const inbound = requestId && this.store.db.prepare('SELECT 1 FROM wechat_inbox WHERE request_id=?').get(requestId)
              const text = event.data.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
              if (this.config.wechatMirrorUserEnabled && !inbound && text && !enqueue(`user-${event.seq}`, text, 'user')) return false
            }
            if (event.type === 'turn/end' && next.final?.seq === event.seq) {
              const current = next.final
              const ours = current.requestIds.some(id => this.store.db.prepare('SELECT 1 FROM wechat_inbox WHERE request_id=? AND generation=?').get(id, channel.generation))
              if (current.reason === 'completed' && this.config.wechatSyncRepliesEnabled && current.text) {
                if (!enqueue(`reply-${event.seq}`, current.text, 'reply')) return false
              } else if (ours && (current.reason !== 'completed' || !current.text)) {
                if (!enqueue(`status-${event.seq}`, `主会话本轮已结束（${current.reason}）。请在桌面查看记录；不会自动重新执行。`, 'status')) return false
              }
              for (const requestId of current.requestIds) this.store.db.prepare("UPDATE wechat_inbox SET state='completed',updated_at=? WHERE request_id=? AND state='accepted'").run(nowIso(), requestId)
            }
            state = next
            this.store.update({ observed_seq: event.seq, delivery_state_json: JSON.stringify(state) })
            return true
          })
          if (!complete) throw new WechatError('QUEUE_FULL', '微信待发队列已满，剩余内容将随队列空位继续入队。')
        }
        signal.throwIfAborted()
        if (page.events.length < 500) break
      }
    } finally { await handle.close() }
    await this.interactions.captureCodex(target)
  }

  async sendPending(signal) {
    const channel = this.store.channel()
    let sent = 0
    if (!channel.owner_id) return sent
    while (!signal.aborted) {
      const row = this.store.db.prepare("SELECT * FROM wechat_outbox WHERE generation=? AND state NOT IN ('accepted','cancelled') ORDER BY sequence LIMIT 1").get(channel.generation)
      if (!row || row.state !== 'pending') return sent
      if (row.next_attempt_at > this.clock()) { this.scheduleSend(row.next_attempt_at); return sent }
      let credential, peer
      await this.saveCredentials(current => {
        if (current?.accountId !== channel.account_id) throw new WechatError('ACCOUNT_CHANGED', '微信账号已变更，发送已暂停。')
        if (this.store.db.prepare('SELECT state FROM wechat_outbox WHERE id=?').get(row.id)?.state !== 'pending') return current
        const previous = current.peers?.[channel.owner_id]
        if (!previous || this.clock() - previous.at >= this.config.wechatContextTtlMs || previous.sent >= this.config.wechatSendBudget) return current
        credential = current
        peer = previous
        return { ...current, peers: { ...current.peers, [channel.owner_id]: { ...previous, sent: previous.sent + 1 } } }
      })
      signal.throwIfAborted()
      if (!peer) {
        this.store.db.prepare("UPDATE wechat_outbox SET state='waiting',error=?,updated_at=? WHERE id=? AND state='pending'").run('请在微信发送 /wx-pending 刷新互动后领取内容。', nowIso(), row.id)
        this.refreshStatus()
        return sent
      }
      // Desktop settlement and local discard can occur while credentials are being persisted.
      if (!this.interactions.canSend(row)) {
        this.store.db.prepare("UPDATE wechat_outbox SET state='cancelled',updated_at=? WHERE id=? AND state='pending'").run(nowIso(), row.id)
        await this.refundSendBudget(channel, peer)
        continue
      }
      const claimed = this.store.db.prepare("UPDATE wechat_outbox SET state='sending',attempts=attempts+1,updated_at=? WHERE id=? AND state='pending'").run(nowIso(), row.id)
      if (!claimed.changes) { await this.refundSendBudget(channel, peer); continue }
      try {
        await this.api.send(credential, channel.owner_id, peer.contextToken, `pac-${sha256(row.id).slice(0, 40)}`, row.text, signal)
      } catch (error) {
        if (error.code === 'SEND_NOT_SUBMITTED') {
          try { await this.refundSendBudget(channel, peer) }
          catch (refundError) {
            this.store.outbound(row.id, 'failed', '消息尚未提交，但无法恢复互动额度，请在桌面检查凭证存储后重试。')
            this.report(refundError)
            return sent
          }
        }
        if (!signal.aborted && error.code === 'SEND_NOT_SUBMITTED' && row.attempts < this.config.wechatSendRetryLimit) {
          const nextAt = this.clock() + Math.min(this.config.wechatBackoffMaxMs, 1000 * 2 ** Math.min(row.attempts, 10))
          this.store.outbound(row.id, 'pending', error.message, nextAt)
          this.scheduleSend(nextAt)
          return sent
        }
        const state = error.effect === 'unknown' ? 'unknown' : error.code === 'WAIT_INTERACTION' ? 'waiting' : 'failed'
        this.store.outbound(row.id, state, error instanceof WechatError ? error.message : '发送失败，请在桌面核对。')
        if (error.code === 'LOGIN_EXPIRED') this.lifetime?.abort()
        this.report(error)
        return sent
      }
      this.store.outbound(row.id, 'accepted')
      sent += 1
    }
    return sent
  }

  /** Refund only the same interaction token; a new inbound interaction owns a separate budget. */
  async refundSendBudget(channel, peer) {
    await this.saveCredentials(current => {
      if (current?.accountId !== channel.account_id) throw new WechatError('ACCOUNT_CHANGED', '微信账号已变更，请在桌面核对发送状态。')
      const latest = current.peers?.[channel.owner_id]
      if (!latest || latest.contextToken !== peer.contextToken || latest.externalId !== peer.externalId || latest.at !== peer.at) return current
      return { ...current, peers: { ...current.peers, [channel.owner_id]: { ...latest, sent: Math.max(0, latest.sent - 1) } } }
    })
  }

  scheduleSend(at) {
    clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.kick() }, Math.max(0, at - this.clock()))
    this.retryTimer.unref?.()
  }

  async command(row, target) {
    if (this.interactions.isCommand(row.text)) {
      try { await this.interactions.answer(row) }
      catch (error) { this.store.enqueue(`invalid-command-${row.id}`, error.message || '无法处理该微信应答，请在桌面查看当前请求。', { kind: 'status' }) }
      this.store.inbound(row.id, 'command')
      return
    }
    let text, stopTurn = false
    if (row.text === '/wx-pending') {
      this.store.db.prepare("UPDATE wechat_outbox SET state='pending',error=NULL WHERE generation=? AND state='waiting'").run(row.generation)
      text = '已领取待发内容，将按顺序继续发送。'
    } else if (row.text === '/wx-stop') {
      const current = this.projection.stateOf(target.agent.session).current
      const owned = current && !current.unidentifiedUserInput && current.requestIds.length && current.requestIds.every(id => this.store.db.prepare('SELECT 1 FROM wechat_inbox WHERE request_id=? AND generation=?').get(id, row.generation))
      if (owned && target.agent.status === 'running') { stopTurn = true; text = '停止指令已记录，将尝试停止当前微信轮次；结果请在桌面核对。' }
      else text = '无法确认当前轮次由微信发起，请在桌面处理。'
    } else if (row.text === '/wx-status' || row.text === '/wx-session') {
      text = `微信通道：${this.status}\n主会话：${target.sessionId}\n状态：${target.agent.status}\n待发：${this.store.db.prepare("SELECT COUNT(*) AS n FROM wechat_outbox WHERE generation=? AND state NOT IN ('accepted','cancelled')").get(row.generation).n}`
    } else text = '微信指令：/wx-status 查看状态；/wx-session 查看主会话；/wx-pending 领取待发；/wx-stop 停止当前微信轮次。提问和审批请按对应编号作答。'
    this.service.database.transaction(() => { this.store.enqueue(`command-${row.id}`, text, { kind: 'status', seq: -1 }); this.store.inbound(row.id, 'command') })
    if (stopTurn) await this.ctx.sessionController.cancel({ sessionId: target.sessionId })
  }

  serialize(action) {
    const work = this.management.catch(() => {}).then(action)
    this.management = work
    return work
  }

  manage(input) {
    return this.serialize(async () => {
      if (this.closed || this.maintenance) throw new Error('微信通道正在停止或维护，请稍后重试。')
      try {
        if (input?.action !== 'refresh') await this.acquireAccountLock()
        return await this.manageAction(input)
      } catch (error) {
        if (error.code === 'ELOCKED') this.report(error)
        throw error
      } finally {
        if (!this.lifetime && !this.loginLifetime) await this.releaseAccountLock()
      }
    })
  }

  async manageAction(input) {
    if (!input || typeof input !== 'object') throw new TypeError('需要微信操作。')
    switch (input.action) {
      case 'resume-restored': {
        if (input.confirmed !== true) throw new TypeError('恢复后的微信同步需要本地确认。')
        await this.stop({ keepLock: true })
        const previous = this.store.channel()
        const target = await this.service.mainSession.ensure()
        await this.ctx.sessionPersistence.flush()
        this.service.database.transaction(() => {
          this.store.db.prepare("UPDATE wechat_inbox SET state='held',error='来自备份的输入需要在桌面核对，不会自动重新执行。' WHERE state IN ('pending','dispatching')").run()
          this.store.db.prepare("UPDATE wechat_outbox SET state='cancelled',error='恢复后隔离旧投递；请从主会话核对内容。' WHERE state IN ('pending','waiting','failed')").run()
          this.store.db.prepare("UPDATE wechat_outbox SET state='unknown' WHERE state='sending'").run()
          this.store.update({ restore_hold: 0, generation: previous.generation + 1, session_id: target.sessionId, binding_version: target.version,
            start_seq: target.agent.session.seq - 1, observed_seq: target.agent.session.seq - 1, delivery_state_json: JSON.stringify(this.projection.stateOf(target.agent.session)), last_error: null })
        })
        await this.syncNow()
        break
      }
      case 'refresh': await this.syncNow(); break
      case 'login': return this.login()
      case 'cancel-login': await this.cancelLogin(); await this.syncNow(); break
      case 'unlink': return this.unlink(input.confirmed)
      case 'retry-send': {
        const row = this.store.db.prepare('SELECT * FROM wechat_outbox WHERE id=?').get(input.id)
        if (!row || row.generation !== this.store.channel().generation || !['failed','unknown','waiting'].includes(row.state)) throw new TypeError('该消息不可重试。')
        if (row.state === 'unknown' && input.confirmed !== true) throw new TypeError('发送结果未知，重发可能重复，需要本地确认。')
        this.store.outbound(row.id, 'pending')
        await this.kick()
        break
      }
      case 'retry-input': {
        const row = this.store.db.prepare('SELECT * FROM wechat_inbox WHERE id=?').get(input.id)
        if (!row || row.generation !== this.store.channel().generation || !['failed','dispatching'].includes(row.state)) throw new TypeError('该微信输入不可重试。')
        this.store.inbound(row.id, 'pending')
        await this.kick()
        break
      }
      case 'discard-send': {
        const row = this.store.db.prepare('SELECT * FROM wechat_outbox WHERE id=?').get(input.id)
        if (!row || row.generation !== this.store.channel().generation || row.state === 'sending') throw new TypeError('不能处理这条发送记录。')
        this.store.outbound(row.id, 'cancelled')
        await this.kick()
        break
      }
      default: throw new TypeError('不支持的微信操作。')
    }
    return this.view()
  }
}
