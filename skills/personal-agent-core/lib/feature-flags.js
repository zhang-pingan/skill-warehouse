export class FeatureFlags {
  constructor(database) { this.database = database }
  list() { return this.database.featureFlags() }
  enabled(key) { return !!this.database.featureFlags()[key] }
  set(key, enabled, { actor = 'user' } = {}) { return this.database.setFeature(key, enabled, actor) }
  assert(key) { if (!this.enabled(key)) throw new Error(`Feature is disabled: ${key}`) }
}
