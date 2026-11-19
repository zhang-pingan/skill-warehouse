import { normalizeWorkspaceRoots } from './worker-workspace.js'
import { WECHAT_DEFAULTS } from './wechat-config.js'
import { defaultRuntimeSettings, resolveRuntimeSettings } from './runtime-settings.js'
import { migrateWorkerSettings } from './worker-policy.js'
import os from 'node:os'
import path from 'node:path'

const bool = (value, fallback) => {
  if (value === undefined) return fallback
  if ([true, 'true', '1'].includes(value)) return true
  if ([false, 'false', '0'].includes(value)) return false
  throw new TypeError('Boolean configuration must be true or false')
}

const positiveInteger = (input, name, fallback) => {
  const value = input[name] ?? fallback
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`)
  return value
}

const workerPresets = input => {
  const values = input ?? ['standard', 'cordis', 'ptc', 'minimal']
  if (!Array.isArray(values) || values.length === 0 || values.some(value => typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(value))) throw new TypeError('dshWorkerPresets must contain preset ids')
  return [...new Set(values)]
}

export function resolveConfig(input = {}, env = process.env) {
  const migrated = migrateWorkerSettings(input)
  input = migrated.settings
  const dataDir = path.resolve(input.dataDir ?? env.DSH_PERSONAL_AGENT_DATA_DIR
    ?? path.join(os.homedir(), '.dsh', 'personal-agent-core'))
  const codexHome = path.resolve(input.codexHome ?? env.CODEX_HOME ?? path.join(os.homedir(), '.codex'))
  const configuredRoots = input.allowedWorkspaceRoots ?? (env.DSH_PERSONAL_AGENT_ALLOWED_WORKSPACE_ROOTS ? env.DSH_PERSONAL_AGENT_ALLOWED_WORKSPACE_ROOTS.split(path.delimiter) : [])
  const operatorToken = input.operatorToken ?? env.DSH_PERSONAL_AGENT_OPERATOR_TOKEN ?? null
  if (operatorToken !== null && (typeof operatorToken !== 'string' || operatorToken.length < 32)) throw new Error('operatorToken must be null or at least 32 characters')
  const allowedWorkspaceRoots = normalizeWorkspaceRoots(configuredRoots)
  const dshWorkerPresets = workerPresets(input.dshWorkerPresets)
  const routeResumeThreshold = input.routeResumeThreshold ?? 0.86
  if (!Number.isFinite(routeResumeThreshold) || routeResumeThreshold < 0 || routeResumeThreshold > 1) throw new TypeError('routeResumeThreshold must be from 0 to 1')
  const resolved = {
    ...WECHAT_DEFAULTS,
    wechatLockDir: path.resolve(input.wechatLockDir ?? path.join(os.homedir(), '.dsh', 'locks', 'personal-agent-wechat')),
    mainSessionTitle: input.mainSessionTitle ?? '鲸鱼娘',
    defaultLanguage: input.defaultLanguage ?? 'zh-CN',
    hotHistoryDays: positiveInteger(input, 'hotHistoryDays', 90),
    candidateReviewDays: positiveInteger(input, 'candidateReviewDays', 90),
    archiveCapacityBytes: positiveInteger(input, 'archiveCapacityBytes', 10737418240),
    defaultWorkerPriority: input.defaultWorkerPriority ?? 'dsh_standard',
    workerModelPolicies: input.workerModelPolicies ?? {},
    workerCapabilities: input.workerCapabilities ?? { dsh_subagent: [], codex: [] },
    workerSettingsMigration: migrated.migration ?? input.workerSettingsMigration ?? null,
    readQueryQueueLimit: positiveInteger(input, 'readQueryQueueLimit', 32),
    readQueryTimeoutMs: positiveInteger(input, 'readQueryTimeoutMs', 30000),
    routeCandidateLimit: positiveInteger(input, 'routeCandidateLimit', 50),
    modelPolicies: input.modelPolicies ?? {},
    semanticRoutingEnabled: bool(input.semanticRoutingEnabled, true),
    routeAmbiguityGap: input.routeAmbiguityGap ?? 0.08,
    leaseTtlMs: positiveInteger(input, 'leaseTtlMs', 120000),
    workerHeartbeatMs: positiveInteger(input, 'workerHeartbeatMs', 30000),
    workerHeartbeatEnabled: bool(input.workerHeartbeatEnabled, true),
    backgroundModelPolicy: input.backgroundModelPolicy ?? null,
    memoryExtractionEnabled: bool(input.memoryExtractionEnabled, true),
    memoryExtractionIntervalMs: positiveInteger(input, 'memoryExtractionIntervalMs', 300_000),
    memoryExtractionBatchSize: positiveInteger(input, 'memoryExtractionBatchSize', 12),
    memoryExtractionBudgetMs: positiveInteger(input, 'memoryExtractionBudgetMs', 600_000),
    memoryExtractionRetryLimit: positiveInteger(input, 'memoryExtractionRetryLimit', 3),
    cleanupEnabled: bool(input.cleanupEnabled, true),
    cleanupIntervalMs: positiveInteger(input, 'cleanupIntervalMs', 86400_000),
    analysisBudgetMs: positiveInteger(input, 'analysisBudgetMs', 120_000),
    analysisInputChars: positiveInteger(input, 'analysisInputChars', 48_000),
    analysisOutputChars: positiveInteger(input, 'analysisOutputChars', 12_000),
    dataDir,
    databasePath: path.resolve(input.databasePath ?? path.join(dataDir, 'ledger.sqlite')),
    backupDir: path.resolve(input.backupDir ?? path.join(dataDir, 'backups')),
    codexHome,
    codexSocketPath: path.resolve(input.codexSocketPath ?? path.join(codexHome, 'app-server-control', 'app-server-control.sock')),
    codexBinary: input.codexBinary ?? env.CODEX_BINARY ?? 'codex',
    manageCodexDaemon: bool(input.manageCodexDaemon ?? env.DSH_PERSONAL_AGENT_MANAGE_CODEX_DAEMON, true),
    importIntervalMs: Number.isFinite(input.importIntervalMs) ? Math.max(60_000, input.importIntervalMs) : 15 * 60_000,
    historyBatchSize: positiveInteger(input, 'historyBatchSize', 32),
    historyRetentionDays: positiveInteger(input, 'historyRetentionDays', 30),
    historyBatchMs: positiveInteger(input, 'historyBatchMs', 8),
    historyReadBytes: positiveInteger(input, 'historyReadBytes', 8 * 1024 * 1024),
    inboxBatchSize: positiveInteger(input, 'inboxBatchSize', 100),
    inboxRetryLimit: positiveInteger(input, 'inboxRetryLimit', 5),
    inboxRetryBudgetMs: positiveInteger(input, 'inboxRetryBudgetMs', 100),
    inboxRetryIntervalMs: Number.isFinite(input.inboxRetryIntervalMs) ? Math.max(5_000, input.inboxRetryIntervalMs) : 30_000,
    backupIntervalMs: Number.isFinite(input.backupIntervalMs) ? Math.max(60 * 60_000, input.backupIntervalMs) : 24 * 60 * 60_000,
    backupRetention: Number.isFinite(input.backupRetention) ? Math.max(2, Math.floor(input.backupRetention)) : 14,
    maxImportFileBytes: Number.isFinite(input.maxImportFileBytes) ? Math.max(1_048_576, input.maxImportFileBytes) : 64 * 1024 * 1024,
    maxHistoryRecordBytes: Number.isFinite(input.maxHistoryRecordBytes) ? Math.max(1_048_576, input.maxHistoryRecordBytes) : 64 * 1024 * 1024,
    dshWorkerEnabled: bool(input.dshWorkerEnabled ?? env.DSH_PERSONAL_AGENT_DSH_WORKER, true),
    codexWorkerEnabled: bool(input.codexWorkerEnabled ?? env.DSH_PERSONAL_AGENT_CODEX_WORKER, false),
    dshWorkerPresets: Object.freeze(dshWorkerPresets),
    workerBudgetMs: positiveInteger(input, 'workerBudgetMs', 30 * 60_000),
    routeResumeThreshold,
    historyRead: bool(input.historyRead ?? env.DSH_PERSONAL_AGENT_HISTORY_READ, true),
    taskNative: bool(input.taskNative ?? env.DSH_PERSONAL_AGENT_TASK_NATIVE, true),
    experimentalCodexApi: bool(input.experimentalCodexApi ?? env.DSH_PERSONAL_AGENT_CODEX_EXPERIMENTAL, true),
    operatorToken,
    allowedWorkspaceRoots: Object.freeze(allowedWorkspaceRoots),
  }
  if (typeof input.wechatLockDir !== 'undefined' && (typeof input.wechatLockDir !== 'string' || !path.isAbsolute(input.wechatLockDir))) throw new TypeError('wechatLockDir must be an absolute directory')
  const settings = resolveRuntimeSettings(Object.fromEntries(Object.keys(defaultRuntimeSettings(resolved)).filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]])), defaultRuntimeSettings(resolved))
  return Object.freeze({ ...resolved, ...settings })
}

export const FEATURE_DEFAULTS = Object.freeze({
  'history.read': true,
  'task.native': true,
  'codex.daemon.connect': false,
  'codex.new_thread.execute': false,
  'routing.resume': false,
  'routing.fork': false,
  'control.steer': false,
  'control.queue': false,
  'memory.embedding': false,
})
