/** Validate deployment rules without inventing a DSH preset for Codex. */
export function validateWorkerRules(rules) {
  if (!Array.isArray(rules) || !rules.length || rules.length > 32) throw new TypeError('workerRules requires 1–32 rules')
  for (const rule of rules) {
    if (!rule || !['dsh_subagent','codex'].includes(rule.worker) || typeof rule.id !== 'string' || !rule.id.trim() || !Array.isArray(rule.keywords) || rule.keywords.some(word => typeof word !== 'string') || !Array.isArray(rule.capabilities) || rule.capabilities.some(capability => typeof capability !== 'string' || !capability.trim())) throw new TypeError('Invalid worker rule')
    if (rule.worker === 'dsh_subagent' && rule.agentPreset !== undefined && (typeof rule.agentPreset !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(rule.agentPreset))) throw new TypeError('Invalid DSH preset in worker rule')
    if (rule.worker === 'codex' && Object.hasOwn(rule, 'agentPreset')) throw new TypeError('Codex rules cannot contain agentPreset')
    if (rule.modelPolicy && typeof rule.modelPolicy !== 'string') throw new TypeError('Invalid model policy reference')
  }
  if (new Set(rules.map(rule => rule.id)).size !== rules.length) throw new TypeError('Worker rule ids must be unique')
  return rules
}

export const DEFAULT_WORKER_RULES = Object.freeze([
  { id: 'harness-plugin', keywords: ['插件','harness','cordis','bundle','preset'], capabilities: [], worker: 'dsh_subagent', agentPreset: 'cordis' },
  { id: 'ptc', keywords: ['ptc'], capabilities: [], worker: 'dsh_subagent', agentPreset: 'ptc' },
  { id: 'general-dsh', keywords: [], capabilities: [], worker: 'dsh_subagent', agentPreset: 'standard' },
  { id: 'general-codex', keywords: [], capabilities: [], worker: 'codex' },
])

/** Resolve backend, then DSH preset, then the backend-specific model policy. */
export function resolveWorkerPolicy(config, args, availability) {
  const text = String(args.objective ?? '').toLocaleLowerCase()
  const required = args.requestedCapabilities ?? []
  const candidates = config.workerRules.filter(rule => (!args.worker || rule.worker === args.worker)
    && (!rule.keywords.length || rule.keywords.some(word => text.includes(word.toLocaleLowerCase())))
    && required.every(capability => rule.capabilities.includes(capability)))
  const rejected = []
  for (const rule of candidates) {
    if (!availability[rule.worker]) { rejected.push({ rule: rule.id, reason: 'unavailable-or-disabled' }); continue }
    if (rule.worker === 'codex' && Object.hasOwn(args, 'agentPreset')) throw new Error('agentPreset is only valid for a DSH worker')
    const agentPreset = rule.worker === 'dsh_subagent' ? args.agentPreset ?? rule.agentPreset ?? config.defaultDshPreset : undefined
    if (agentPreset && !config.dshWorkerPresets.includes(agentPreset)) { rejected.push({ rule: rule.id, reason: 'preset-not-allowed' }); continue }
    const policy = rule.modelPolicy ? config.modelPolicies[rule.modelPolicy] : null
    if (rule.modelPolicy && (!policy || policy.worker !== rule.worker)) throw new Error(`Invalid model policy: ${rule.modelPolicy}`)
    return { worker: rule.worker, ...(agentPreset ? { agentPreset } : {}), ruleId: rule.id, model: policy ?? null, rejected }
  }
  throw Object.assign(new Error('No enabled worker satisfies the configured task policy'), { code: 'WORKER_UNAVAILABLE', rejected })
}
