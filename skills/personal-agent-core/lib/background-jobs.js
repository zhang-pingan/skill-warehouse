import { parseJson } from './ids.js'

/** Persist scheduled work outcomes while joining overlapping ticks for the same job. */
export class BackgroundJobs {
  constructor(db, clock = Date.now) {
    this.db = db
    this.clock = clock
    this.running = new Map()
    for (const state of this.list()) {
      if (state.running) state.lastError = 'Host stopped before this run settled; inspect backlog and retry'
      this.save({ ...state, running: false, nextRunAt: null })
    }
  }

  list() { return this.db.prepare('SELECT status_json FROM background_job_status ORDER BY job_name').all().map(row => parseJson(row.status_json, {})) }
  state(name) { return parseJson(this.db.prepare('SELECT status_json FROM background_job_status WHERE job_name=?').get(name)?.status_json, { name }) }
  save(state) { this.db.prepare('INSERT OR REPLACE INTO background_job_status VALUES(?,?)').run(state.name, JSON.stringify(state)) }

  configure(name, enabled, intervalMs) {
    this.save({ ...this.state(name), name, enabled, intervalMs, nextRunAt: enabled ? new Date(this.clock() + intervalMs).toISOString() : null })
  }

  tick(name, operation) {
    const state = this.state(name)
    this.save({ ...state, nextRunAt: state.enabled ? new Date(this.clock() + state.intervalMs).toISOString() : null })
    return this.run(name, operation)
  }

  run(name, operation) {
    if (this.running.has(name)) return this.running.get(name)
    const start = this.clock()
    const state = this.state(name)
    this.save({ ...state, running: true, lastStartedAt: new Date(start).toISOString() })
    const pending = Promise.resolve().then(operation).then(result => {
      const warnings = []
      const collect = value => {
        if (!value || typeof value !== 'object') return
        for (const [key,item] of Object.entries(value)) {
          if (['warnings','errors'].includes(key) && Array.isArray(item)) warnings.push(...item)
          else if (item && typeof item === 'object' && !Array.isArray(item)) collect(item)
        }
      }
      collect(result)
      const failure = result?.lastError ?? (warnings.length ? JSON.stringify(warnings).slice(0,1000) : null)
      this.save({ ...this.state(name), running: false, lastFinishedAt: new Date(this.clock()).toISOString(), ...(failure ? { lastFailedAt: new Date(this.clock()).toISOString(), lastError: failure } : { lastSuccessfulAt: new Date(this.clock()).toISOString(), lastError: null }) })
      return result
    }, error => {
      this.save({ ...this.state(name), running: false, lastFinishedAt: new Date(this.clock()).toISOString(), lastFailedAt: new Date(this.clock()).toISOString(), lastError: String(error?.message ?? error).slice(0, 1000) })
      throw error
    }).finally(() => this.running.delete(name))
    this.running.set(name, pending)
    return pending
  }
}
