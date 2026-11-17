/** Validated first-run preferences and transport limits for the private WeChat channel. */
export const WECHAT_API_BASE = 'https://ilinkai.weixin.qq.com'
export const WECHAT_DEFAULTS = Object.freeze({
  wechatEnabled: false,
  wechatSyncRepliesEnabled: true,
  wechatMirrorUserEnabled: false,
  wechatRemoteApprovalEnabled: false,
  wechatRequestTimeoutMs: 15000,
  wechatPollTimeoutMs: 38000,
  wechatBackoffMaxMs: 60000,
  wechatMessageChars: 1800,
  wechatQueueCapacity: 2000,
  wechatRetentionDays: 90,
  wechatInteractionTtlMs: 600000,
  wechatContextTtlMs: 600000,
  wechatSendBudget: 8,
  wechatSendRetryLimit: 3,
})
const limits = {
  wechatSendRetryLimit: [0, 10],
  wechatRequestTimeoutMs: [1000, 120000], wechatPollTimeoutMs: [1000, 120000],
  wechatBackoffMaxMs: [1000, 3600000], wechatMessageChars: [100, 4000],
  wechatQueueCapacity: [10, 100000], wechatRetentionDays: [1, 3650],
  wechatInteractionTtlMs: [1000, 3600000], wechatContextTtlMs: [1000, 86400000], wechatSendBudget: [1, 10],
}

/** Validate runtime toggles and bounded channel limits. */
export function validateWechatSetting(key, value) {
  if (!(key in WECHAT_DEFAULTS)) return false
  if (typeof WECHAT_DEFAULTS[key] === 'boolean') {
    if (typeof value !== 'boolean') throw new TypeError(`${key} must be a boolean`)
  } else {
    const [min, max] = limits[key]
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`${key} must be an integer from ${min} to ${max}`)
  }
  return true
}
