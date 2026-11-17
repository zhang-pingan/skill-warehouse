/** Durable channel identities, atomic pull cursor and ordered send intents. Secrets live elsewhere. */
import { nowIso, sha256 } from './ids.js'
import { splitWechatText, WechatError } from './wechat-api.js'

export class WechatStore {
  constructor(database, config) { this.database = database; this.db = database.db; this.config = config; this.db.prepare("INSERT OR IGNORE INTO wechat_channel(singleton,updated_at) VALUES(1,?)").run(nowIso()) }
  channel() { return this.db.prepare('SELECT * FROM wechat_channel WHERE singleton=1').get() }
  update(patch) {
    const fields = new Set(['generation','account_id','owner_id','cursor','session_id','binding_version','start_seq','observed_seq','delivery_state_json','restore_hold','last_error'])
    for (const key of Object.keys(patch)) if (!fields.has(key)) throw new Error(`Invalid channel field: ${key}`)
    this.db.prepare(`UPDATE wechat_channel SET ${Object.keys(patch).map(key => `${key}=?`).join(',')},updated_at=? WHERE singleton=1`).run(...Object.values(patch), nowIso())
  }
  recover() { this.db.prepare("UPDATE wechat_outbox SET state='unknown',error=?,updated_at=? WHERE state='sending'").run('发送时 Host 中断，结果未知；请核对手机后处理。', nowIso()) }
  available(direction = 'outbox') {
    const states = direction === 'inbox' ? "('pending','dispatching','held','failed')" : "('pending','sending','unknown','waiting','failed')"
    const table = direction === 'inbox' ? 'wechat_inbox' : 'wechat_outbox'
    const count = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE generation=? AND state IN ${states}`).get(this.channel().generation).n
    return Math.max(0, this.config.wechatQueueCapacity - count)
  }
  capacity(extra = 1, direction = 'outbox') {
    if (extra > this.available(direction)) throw new WechatError('QUEUE_FULL', '微信队列已满，新增内容正在等待空位；请处理待发或失败记录。')
  }
  /** Replayable Session output may fill available slots without advancing its event checkpoint. */
  enqueue(key, text, { seq = -1, kind = 'notice', channel = this.channel(), partial = false, segmentChars = this.config.wechatMessageChars } = {}) {
    if (!channel.owner_id || !text) return true
    return this.database.transaction(() => {
      if (!partial && this.db.prepare('SELECT 1 FROM wechat_outbox WHERE id=?').get(`${channel.generation}:${key}:0`)) return true
      const segments = splitWechatText(text, segmentChars)
      const missing = segments.map((part, segment) => ({ part, segment, id: `${channel.generation}:${key}:${segment}` }))
        .filter(row => !this.db.prepare('SELECT 1 FROM wechat_outbox WHERE id=?').get(row.id))
      if (!partial) this.capacity(missing.length)
      const available = this.available()
      for (const { id, segment, part } of missing.slice(0, available)) this.db.prepare(`INSERT INTO wechat_outbox(id,generation,account_id,peer_id,session_id,binding_version,source_seq,kind,segment,text,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,?)`)
        .run(id, channel.generation, channel.account_id, channel.owner_id, channel.session_id, channel.binding_version, seq, kind, segment, part, nowIso(), nowIso())
      return missing.length <= available
    })
  }
  /** Retain identities and uncertain sends while retiring work under the previous authorization. */
  retireGeneration(reason) {
    const generation = this.channel().generation
    this.db.prepare("UPDATE wechat_outbox SET state='cancelled',error=?,updated_at=? WHERE generation=? AND state IN ('pending','waiting','failed')").run(reason, nowIso(), generation)
    this.db.prepare("UPDATE wechat_inbox SET state='held',error=?,updated_at=? WHERE generation=? AND state IN ('pending','dispatching')").run(reason, nowIso(), generation)
  }
  inbound(id, state, error = null) { this.db.prepare('UPDATE wechat_inbox SET state=?,error=?,updated_at=? WHERE id=?').run(state, error, nowIso(), id) }
  outbound(id, state, error = null, nextAt = 0) { this.db.prepare('UPDATE wechat_outbox SET state=?,error=?,next_attempt_at=?,updated_at=? WHERE id=?').run(state, error, nextAt, nowIso(), id) }
  view() {
    const c = this.channel()
    return { accountId: c.account_id, ownerId: c.owner_id, generation: c.generation, restoreHold: !!c.restore_hold, error: c.last_error,
      contacts: this.db.prepare('SELECT peer_id AS peerId,seen_at AS seenAt FROM wechat_contacts WHERE account_id=? ORDER BY seen_at DESC').all(c.account_id ?? ''),
      inboxCounts: this.db.prepare('SELECT state,COUNT(*) AS count FROM wechat_inbox WHERE generation=? GROUP BY state').all(c.generation),
      outboxCounts: this.db.prepare('SELECT state,COUNT(*) AS count FROM wechat_outbox WHERE generation=? GROUP BY state').all(c.generation),
      outbox: this.db.prepare("SELECT id,generation,state,text,error,created_at AS createdAt FROM wechat_outbox WHERE state NOT IN ('accepted','cancelled') ORDER BY sequence LIMIT 50").all(),
      inbox: this.db.prepare("SELECT id,generation,session_id AS sessionId,text,state,error,received_at AS receivedAt FROM wechat_inbox WHERE state IN ('held','failed','dispatching') ORDER BY received_at LIMIT 50").all() }
  }
  prune() {
    const cutoff = new Date(Date.now() - this.config.wechatRetentionDays * 86400000).toISOString()
    this.db.prepare("UPDATE wechat_outbox SET text='' WHERE state IN ('accepted','cancelled') AND updated_at<?").run(cutoff)
    // Identity tombstones prevent old upstream replays from executing again.
    this.db.prepare("UPDATE wechat_inbox SET text='' WHERE state IN ('accepted','completed','command') AND updated_at<?").run(cutoff)
  }
}
