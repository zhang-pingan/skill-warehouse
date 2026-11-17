/** Minimal text-only Tencent iLink transport. No implicit retry of a possibly submitted send. */
import { randomBytes } from 'node:crypto'
import { WECHAT_API_BASE } from './wechat-config.js'

export class WechatError extends Error {
  constructor(code, message, { effect = 'none', cause } = {}) { super(message, { cause }); this.name = 'WechatError'; this.code = code; this.effect = effect }
}

/** Allow configured origin and Tencent's iLink subdomains; never forward tokens to redirects. */
export function trustedWechatOrigin(value, configured) {
  let url
  try { url = new URL(value) } catch (cause) { throw new WechatError('INVALID_ORIGIN', '微信登录返回了无效服务地址。', { cause }) }
  const initial = new URL(configured)
  const tencent = url.protocol === 'https:' && !url.port && (url.hostname === 'ilinkai.weixin.qq.com' || url.hostname.endsWith('.ilinkai.weixin.qq.com'))
  if ((url.origin !== initial.origin && !tencent) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new WechatError('INVALID_ORIGIN', '微信服务地址不受信任，已停止发送凭证。')
  return url.origin
}

export class WechatApi {
  constructor(config, { fetchImpl = fetch, baseUrl = WECHAT_API_BASE } = {}) { this.config = config; this.fetch = fetchImpl; this.baseUrl = baseUrl }

  async call(path, { credential, body, signal, timeoutMs = this.config.wechatRequestTimeoutMs, sending = false } = {}) {
    const origin = trustedWechatOrigin(credential?.baseUrl ?? this.baseUrl, this.baseUrl)
    const headers = { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token', 'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64') }
    if (credential?.token) headers.Authorization = `Bearer ${credential.token}`
    let response, data
    try {
      response = await this.fetch(`${origin}/${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', headers,
        ...(body === undefined ? {} : { body: JSON.stringify({ ...body, base_info: { channel_version: '1.0.2' } }) }),
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]) })
      const raw = await response.text()
      if (raw.length > 4 * 1024 * 1024) throw new Error('Response exceeds protocol budget')
      // iLink emits 64-bit numeric IDs; retain their original digits for durable deduplication.
      data = JSON.parse(raw, (key, value, context) => key === 'message_id' && typeof value === 'number' && !Number.isSafeInteger(value) && /^\d+$/.test(context.source) ? context.source : value)
    } catch (cause) {
      const connectCodes = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT'])
      if (sending && !signal?.aborted && !response && connectCodes.has(cause?.cause?.code)) throw new WechatError('SEND_NOT_SUBMITTED', '微信连接未建立，消息仍在队列中，将有限重试。', { cause })
      if (signal?.aborted && !sending) throw signal.reason
      throw new WechatError(sending ? 'SEND_UNKNOWN' : 'NETWORK', sending ? '微信发送结果未知，自动重发已暂停，请核对手机后处理。' : '无法连接微信服务，将自动重连；请检查网络。', { effect: sending ? 'unknown' : 'none', cause })
    }
    if (!response.ok) throw new WechatError(sending ? 'SEND_UNKNOWN' : 'HTTP', sending ? '微信服务未确认发送结果，请核对手机后处理。' : `微信服务返回 HTTP ${response.status}，请稍后重试。`, { effect: sending ? 'unknown' : 'none' })
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new WechatError(sending ? 'SEND_UNKNOWN' : 'PROTOCOL', '微信响应格式无效，请检查连接状态。', { effect: sending ? 'unknown' : 'none' })
    if ([data.ret, data.errcode].some(code => code !== undefined && !Number.isInteger(code))) throw new WechatError(sending ? 'SEND_UNKNOWN' : 'PROTOCOL', '微信响应状态无效，请在桌面核对。', { effect: sending ? 'unknown' : 'none' })
    if (data.ret === -14 || data.errcode === -14) throw new WechatError('LOGIN_EXPIRED', '微信登录已失效，请重新扫码。')
    if ((typeof data.ret === 'number' && data.ret !== 0) || (typeof data.errcode === 'number' && data.errcode !== 0)) {
      if (sending && (data.ret === -2 || data.errcode === -2) && typeof data.errmsg === 'string' && data.errmsg.trim().toLowerCase() === 'prepare failed') throw new WechatError('WAIT_INTERACTION', '微信发送额度或回复凭证不可用，请在微信再次发消息后领取待发内容。')
      throw new WechatError('REJECTED', '微信服务拒绝了本次操作，请检查登录和消息内容。')
    }
    // iLink SendMessageResp omits default zero status fields on successful JSON responses.
    return data
  }

  qr(signal) { return this.call('ilink/bot/get_bot_qrcode?bot_type=3', { signal }) }
  qrStatus(qrcode, signal) { return this.call(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, { signal, timeoutMs: this.config.wechatPollTimeoutMs }) }
  updates(credential, cursor, signal) { return this.call('ilink/bot/getupdates', { credential, body: { get_updates_buf: cursor }, signal, timeoutMs: this.config.wechatPollTimeoutMs }) }
  send(credential, peer, contextToken, id, text, signal) {
    return this.call('ilink/bot/sendmessage', { credential, sending: true, signal, body: { msg: { from_user_id: '', to_user_id: peer, client_id: id, message_type: 2, message_state: 2,
      ...(contextToken ? { context_token: contextToken } : {}), item_list: [{ type: 1, text_item: { text } }] } } })
  }
}

/** Validate one pull batch before committing its cursor; malformed identities block the batch. */
export function parseWechatUpdates(data) {
  if (!Array.isArray(data.msgs ?? []) || typeof data.get_updates_buf !== 'string') throw new WechatError('PROTOCOL', '微信拉取游标或消息列表无效，已保留原游标。')
  const messages = []
  for (const msg of data.msgs ?? []) {
    if (!msg || typeof msg !== 'object') throw new WechatError('PROTOCOL', '微信消息格式无效，已保留原游标。')
    if (msg.message_type !== 1 || msg.group_id) continue
    if (typeof msg.from_user_id !== 'string' || !msg.from_user_id || msg.from_user_id.length > 500 || !(typeof msg.message_id === 'string' && msg.message_id || Number.isSafeInteger(msg.message_id))) throw new WechatError('MESSAGE_ID', '微信消息缺少可验证的身份，已停止派发并保留游标。')
    if (!Array.isArray(msg.item_list)) throw new WechatError('PROTOCOL', '微信消息内容无效，已保留原游标。')
    if (msg.item_list.some(item => !item || typeof item !== 'object' || !Number.isInteger(item.type) || item.type === 1 && typeof item.text_item?.text !== 'string')) throw new WechatError('PROTOCOL', '微信消息片段格式无效，已保留原游标。')
    const unsupported = msg.item_list.some(item => item.type !== 1)
    const text = msg.item_list.filter(item => item.type === 1 && typeof item.text_item?.text === 'string').map(item => item.text_item.text).join('\n')
    if (text.length > 262144) throw new WechatError('MESSAGE_SIZE', '微信消息过长，已停止接收该批次。')
    if (msg.context_token !== undefined && (typeof msg.context_token !== 'string' || msg.context_token.length > 32768)) throw new WechatError('PROTOCOL', '微信回复凭证格式无效。')
    messages.push({ peer: msg.from_user_id, externalId: String(msg.message_id), text, unsupported, contextToken: msg.context_token ?? null })
  }
  return { cursor: data.get_updates_buf, messages }
}

/** Split at Unicode code-point boundaries with stable content for retry and replay. */
export function splitWechatText(text, size) {
  const points = Array.from(text)
  const segments = []
  for (let offset = 0; offset < points.length; offset += size) segments.push(points.slice(offset, offset + size).join(''))
  return segments
}
