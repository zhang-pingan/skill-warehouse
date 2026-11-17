import { WECHAT_DEFAULTS, validateWechatSetting } from './wechat-config.js'
import { validateWorkerRules } from './worker-policy.js'
/** Runtime-editable preferences for background work and history import. */

export const RUNTIME_SETTING_KEYS = Object.freeze([
  ...Object.keys(WECHAT_DEFAULTS),
  'defaultLanguage',
  'hotHistoryDays',
  'candidateReviewDays',
  'archiveCapacityBytes',
  'leaseTtlMs',
  'workerHeartbeatMs',
  'workerHeartbeatEnabled',
  'routeAmbiguityGap',
  'backgroundModelPolicy',
  'workerRules',
  'modelPolicies',
  'semanticRoutingEnabled',
  'memoryExtractionEnabled',
  'memoryExtractionIntervalMs',
  'memoryExtractionBatchSize',
  'memoryExtractionRetryLimit',
  'memoryExtractionBudgetMs',
  'cleanupEnabled',
  'cleanupIntervalMs',
  'analysisBudgetMs',
  'analysisInputChars',
  'analysisOutputChars',
  'historySyncEnabled',
  'historyStartupSyncEnabled',
  'historyPeriodicSyncEnabled',
  'dshWorkerEnabled',
  'codexWorkerEnabled',
  'dshWorkerPresets',
  'defaultDshPreset',
  'workerBudgetMs',
  'routeResumeThreshold',
  'importIntervalMs',
  'inboxRetryEnabled',
  'inboxRetryIntervalMs',
  'inboxBatchSize',
  'inboxRetryLimit',
  'inboxRetryBudgetMs',
  'backupEnabled',
  'backupIntervalMs',
  'backupRetention',
  'historyRetentionDays',
  'historyBatchSize',
  'historyBatchMs',
  'historyReadBytes',
  'maxImportFileBytes',
  'maxHistoryRecordBytes',
])

const ranges = Object.freeze({
  hotHistoryDays: [1, 36500], candidateReviewDays: [1, 36500], archiveCapacityBytes: [1048576, 1099511627776],
  leaseTtlMs: [1000, 3600000], workerHeartbeatMs: [100, 1800000],
  memoryExtractionIntervalMs: [1000, 604800000], memoryExtractionBatchSize: [1, 200], memoryExtractionRetryLimit: [1, 20], memoryExtractionBudgetMs: [1, 3600000],
  cleanupIntervalMs: [60000, 31536000000], analysisBudgetMs: [1, 3600000], analysisInputChars: [1000, 1000000], analysisOutputChars: [1000, 100000],
  importIntervalMs: [60_000, 24 * 60 * 60_000],
  inboxRetryIntervalMs: [5_000, 60 * 60_000],
  inboxBatchSize: [1, 1000], inboxRetryLimit: [1, 20], inboxRetryBudgetMs: [1, 60_000],
  backupIntervalMs: [60 * 60_000, 365 * 24 * 60 * 60_000],
  backupRetention: [2, 1_000],
  historyRetentionDays: [1, 3_650],
  historyBatchSize: [1, 1_000],
  historyBatchMs: [1, 10_000],
  historyReadBytes: [1_024, 256 * 1024 * 1024],
  maxImportFileBytes: [1_048_576, 1_024 * 1024 * 1024],
  maxHistoryRecordBytes: [1_048_576, 1_024 * 1024 * 1024],
  workerBudgetMs: [1, 24 * 60 * 60_000],
})

const presetPattern = /^[a-z][a-z0-9-]{0,31}$/

/**
 * Build the first-run settings from the plugin's Cordis configuration.
 * @param config - validated plugin configuration.
 * @returns immutable runtime settings.
 */
export function defaultRuntimeSettings(config) {
  return Object.freeze({
    ...Object.fromEntries(Object.entries(WECHAT_DEFAULTS).map(([key, fallback]) => [key, config[key] ?? fallback])),
    defaultLanguage: config.defaultLanguage,
    hotHistoryDays: config.hotHistoryDays,
    candidateReviewDays: config.candidateReviewDays,
    archiveCapacityBytes: config.archiveCapacityBytes,
    leaseTtlMs: config.leaseTtlMs,
    workerHeartbeatMs: config.workerHeartbeatMs,
    workerHeartbeatEnabled: config.workerHeartbeatEnabled,
    routeAmbiguityGap: config.routeAmbiguityGap,
    backgroundModelPolicy: config.backgroundModelPolicy,
    workerRules: config.workerRules,
    modelPolicies: config.modelPolicies,
    semanticRoutingEnabled: config.semanticRoutingEnabled,
    memoryExtractionEnabled: config.memoryExtractionEnabled,
    memoryExtractionIntervalMs: config.memoryExtractionIntervalMs,
    memoryExtractionBatchSize: config.memoryExtractionBatchSize,
    memoryExtractionRetryLimit: config.memoryExtractionRetryLimit,
    memoryExtractionBudgetMs: config.memoryExtractionBudgetMs,
    cleanupEnabled: config.cleanupEnabled,
    cleanupIntervalMs: config.cleanupIntervalMs,
    analysisBudgetMs: config.analysisBudgetMs,
    analysisInputChars: config.analysisInputChars,
    analysisOutputChars: config.analysisOutputChars,

    historySyncEnabled: config.historyRead,
    historyStartupSyncEnabled: config.historyRead,
    historyPeriodicSyncEnabled: config.historyRead,
    dshWorkerEnabled: config.dshWorkerEnabled,
    codexWorkerEnabled: config.codexWorkerEnabled,
    dshWorkerPresets: [...config.dshWorkerPresets],
    defaultDshPreset: config.defaultDshPreset,
    workerBudgetMs: config.workerBudgetMs,
    routeResumeThreshold: config.routeResumeThreshold,
    importIntervalMs: config.importIntervalMs,
    inboxRetryEnabled: true,
    inboxRetryIntervalMs: config.inboxRetryIntervalMs,
    inboxBatchSize: config.inboxBatchSize,
    inboxRetryLimit: config.inboxRetryLimit,
    inboxRetryBudgetMs: config.inboxRetryBudgetMs,
    backupEnabled: true,
    backupIntervalMs: config.backupIntervalMs,
    backupRetention: config.backupRetention,
    historyRetentionDays: config.historyRetentionDays,
    historyBatchSize: config.historyBatchSize,
    historyBatchMs: config.historyBatchMs,
    historyReadBytes: config.historyReadBytes,
    maxImportFileBytes: config.maxImportFileBytes,
    maxHistoryRecordBytes: config.maxHistoryRecordBytes,
  })
}

/**
 * Merge and validate a complete persisted or submitted settings document.
 * @param input - settings values to apply.
 * @param base - current validated settings used for omitted fields.
 * @returns immutable validated settings.
 */
export function resolveRuntimeSettings(input, base) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Settings must be a JSON object')
  const keys = new Set(RUNTIME_SETTING_KEYS)
  for (const key of Object.keys(input)) if (!keys.has(key)) throw new TypeError(`Unknown setting: ${key}`)
  const value = { ...base }
  for (const key of RUNTIME_SETTING_KEYS) {
    if (Object.hasOwn(input, key)) value[key] = input[key]
    if (validateWechatSetting(key, value[key])) continue
    if (key === 'defaultLanguage') {
      if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 100) throw new TypeError('defaultLanguage must be a language name or locale')
      continue
    }
    if (key === 'backgroundModelPolicy') {
      if (value[key] !== null && typeof value[key] !== 'string') throw new TypeError('backgroundModelPolicy must be a model policy name or null')
      continue
    }
    if (key === 'workerRules') { value[key] = validateWorkerRules(value[key]); continue }
    if (key === 'modelPolicies') {
      if (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key])) throw new TypeError('modelPolicies must be an object')
      for (const policy of Object.values(value[key])) {
        if (!policy || !['codex','dsh_subagent'].includes(policy.worker) || typeof policy.model !== 'string' || !policy.model) throw new TypeError('Invalid model policy')
        if (policy.effort !== undefined && (typeof policy.effort !== 'string' || !policy.effort.trim())) throw new TypeError('Model policy effort must be a nonempty string')
        if (policy.worker === 'dsh_subagent' && (typeof policy.provider !== 'string' || !policy.provider.trim())) throw new TypeError('DSH model policy requires provider')
        if (Object.hasOwn(policy, 'agentPreset')) throw new TypeError('Model policies do not select presets')
      }
      continue
    }
    if (key === 'dshWorkerPresets') {
      if (!Array.isArray(value[key]) || value[key].length === 0 || value[key].some(item => typeof item !== 'string' || !presetPattern.test(item))) throw new TypeError('dshWorkerPresets must contain preset ids')
      value[key] = [...new Set(value[key])]
      continue
    }
    if (key === 'defaultDshPreset') {
      if (typeof value[key] !== 'string' || !presetPattern.test(value[key])) throw new TypeError('defaultDshPreset must be a preset id')
      continue
    }
    if (key === 'routeResumeThreshold' || key === 'routeAmbiguityGap') {
      if (!Number.isFinite(value[key]) || value[key] < 0 || value[key] > 1) throw new TypeError(`${key} must be from 0 to 1`)
      continue
    }
    if (key.endsWith('Enabled')) {
      if (typeof value[key] !== 'boolean') throw new TypeError(`${key} must be a boolean`)
      continue
    }
    const range = ranges[key]
    if (!Number.isSafeInteger(value[key]) || value[key] < range[0] || value[key] > range[1]) {
      throw new TypeError(`${key} must be an integer from ${range[0]} to ${range[1]}`)
    }
  }
  if (!value.dshWorkerPresets.includes(value.defaultDshPreset)) throw new TypeError('defaultDshPreset must be included in dshWorkerPresets')
  if (value.workerHeartbeatMs * 2 >= value.leaseTtlMs) throw new TypeError('workerHeartbeatMs must be less than half of leaseTtlMs')
  if (value.backgroundModelPolicy && value.modelPolicies[value.backgroundModelPolicy]?.worker !== 'dsh_subagent') throw new TypeError('Background analysis requires a configured DSH model policy')
  for (const rule of value.workerRules) {
    if (rule.modelPolicy && (!value.modelPolicies[rule.modelPolicy] || value.modelPolicies[rule.modelPolicy].worker !== rule.worker)) throw new TypeError('Worker rule refers to a missing or incompatible model policy')
  }
  return Object.freeze(value)
}
