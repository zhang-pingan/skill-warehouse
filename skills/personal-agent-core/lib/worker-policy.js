/** Default backend selection is configuration-owned; task classification belongs to the main model. */
export const WORKER_PRIORITIES = Object.freeze({
  dsh_standard: { worker: 'dsh_subagent', agentPreset: 'standard' },
  dsh_cordis: { worker: 'dsh_subagent', agentPreset: 'cordis' },
  codex: { worker: 'codex' },
})

/** Convert retired settings without retaining keyword dispatch. Unrepresentable rules remain in the migration record. */
export function migrateWorkerSettings(input) {
  const value = { ...input }
  const legacy = Object.hasOwn(value, 'workerRules') || Object.hasOwn(value, 'defaultDshPreset')
  if (!legacy) return { settings: value, migration: null }
  const prior = { workerRules: value.workerRules, defaultDshPreset: value.defaultDshPreset }
  const warnings = []
  const rules = value.workerRules ?? []
  const policies = { ...value.workerModelPolicies }
  for (const rule of rules) {
    const key = rule.worker === 'codex' ? 'codex' : rule.agentPreset === 'cordis' ? 'dsh_cordis' : 'dsh_standard'
    const supported = rule.worker === 'codex' || ['standard','cordis',undefined].includes(rule.agentPreset)
    if (rule.modelPolicy && supported && !policies[key]) policies[key] = rule.modelPolicy
    const builtIn = rule.id==='harness-plugin' && rule.worker==='dsh_subagent' && rule.agentPreset==='cordis' && JSON.stringify(rule.keywords)===JSON.stringify(['插件','harness','cordis','bundle','preset']) || rule.id==='ptc' && rule.worker==='dsh_subagent' && rule.agentPreset==='ptc' && JSON.stringify(rule.keywords)===JSON.stringify(['ptc'])
    if (rule.modelPolicy && (!supported || policies[key] !== rule.modelPolicy) || rule.capabilities?.length || rule.keywords?.length && !builtIn) warnings.push(rule.id)
  }
  const general = rules.find(rule => !rule.keywords?.length && !rule.capabilities?.length)
  value.defaultWorkerPriority ??= value.defaultDshPreset === 'cordis' || general?.agentPreset === 'cordis' ? 'dsh_cordis' : general?.worker === 'codex' && value.codexWorkerEnabled ? 'codex' : 'dsh_standard'
  if (value.defaultDshPreset && !['standard','cordis'].includes(value.defaultDshPreset)) warnings.push(`defaultDshPreset:${value.defaultDshPreset}`)
  if (general?.agentPreset && value.defaultDshPreset && general.agentPreset!==value.defaultDshPreset) warnings.push(`default-conflict:${general.id}`)
  value.workerModelPolicies = policies
  delete value.workerRules
  delete value.defaultDshPreset
  return { settings: value, migration: { previous: prior, warnings, defaultWorkerPriority: value.defaultWorkerPriority } }
}

/** Resolve the model's plugin-maintenance override or the user's default, without reading objective text. */
export function resolveWorkerPolicy(config, args, availability) {
  const specified = args.worker !== undefined || args.agentPreset !== undefined
  if (specified && (args.worker !== 'dsh_subagent' || args.agentPreset !== 'cordis')) {
    throw Object.assign(new Error('新建 worker 仅允许 DSH 插件开发或维护时同时指定 dsh_subagent 和 cordis；其他任务请省略 worker 和 agentPreset，使用默认优先级。'), { code: 'WORKER_SELECTION_INVALID' })
  }
  const priority = specified ? 'dsh_cordis' : config.defaultWorkerPriority
  const selected = WORKER_PRIORITIES[priority]
  if (!selected) throw new TypeError('Invalid defaultWorkerPriority')
  if (!availability[selected.worker]) throw Object.assign(new Error(`所选 worker 尚未启用或未就绪：${priority}。请检查设置后重试。`), { code: 'WORKER_UNAVAILABLE', priority })
  if (selected.agentPreset && !config.dshWorkerPresets.includes(selected.agentPreset)) throw Object.assign(new Error(`DSH 模式不在允许列表内：${selected.agentPreset}`), { code: 'WORKER_PRESET_UNAVAILABLE' })
  const capabilities = config.workerCapabilities[selected.worker] ?? []
  if ((args.requestedCapabilities ?? []).some(item => !capabilities.includes(item))) throw Object.assign(new Error('所选 worker 未配置请求的能力，请检查 worker 能力设置。'), { code: 'WORKER_CAPABILITY_UNAVAILABLE' })
  const policyName = config.workerModelPolicies[priority]
  const model = policyName ? config.modelPolicies[policyName] : null
  if (policyName && model?.worker !== selected.worker) throw new TypeError(`Invalid worker model policy: ${policyName}`)
  return { ...selected, priority, selection: specified ? 'model-dsh-plugin' : 'configured-default', model, rejected: [] }
}
