/** Observe the actual plugin tool after the supported Web profile publishes app readiness. */
import assert from 'node:assert/strict'
import { realpath, writeFile, rename, readFile } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { observeQuery } from './query-heartbeat.js'

export const inject = ['appReady', 'tools']

/** Register a bounded readiness measurement and drain its write before plugin disposal. */
export async function apply(ctx) {
  const root = await realpath(process.env.DSH_SCALE_PROFILE_ROOT)
  assert.equal(await realpath(process.env.DSH_HOME), path.join(root, 'harness-home'))
  assert.equal(await realpath(process.env.CODEX_HOME), path.join(root, 'codex-home'))
  ctx.effect(() => {
    let pending
    const stop = ctx.appReady.onReady(() => {
      pending = (async () => {
        const applicationReadyAt = performance.now()
        const tool = ctx.tools.get('personal_agent')
        assert(tool, 'Production personal_agent tool must be registered')
        const started = performance.now()
        const health = await tool.execute({ action: 'health' }, { signal: AbortSignal.timeout(30000) })
        assert.equal(health.ok, true)
        assert.equal(health.database.evidence, Number(process.env.DSH_SCALE_PROFILE_MESSAGES))
        assert.equal(health.workers.dsh.available, true)
        const value = { ok: true, healthReadyAtEpochMs: Date.now(), applicationReadyAt, toolHealthMs: performance.now() - started,
          processUptimeMs: process.uptime() * 1000, memory: process.memoryUsage(), resourceUsage: process.resourceUsage(),
          database: health.database, memoryStatus: health.memory,
          workers: { dshAvailable: health.workers.dsh.available, codexEnabled: health.workers.codex.enabled } }
        let queries = null
        try { queries = JSON.parse(await readFile(path.join(root, 'profile-queries.json'), 'utf8')) }
        catch (error) { if (error.code !== 'ENOENT') throw error }
        if (queries) {
          value.queries = []
          for (const request of queries) {
            const { value:response, elapsedMs, heartbeat } = await observeQuery(() => tool.execute(request, { signal: AbortSignal.timeout(30000) }))
            assert.equal(response.results?.[0]?.id ?? response.sessionTasks?.[0]?.id, 'scale-task-0')
            value.queries.push({ request, elapsedMs, heartbeat, response })
          }
        }
        await writeFile(path.join(root, 'profile-ready.tmp'), JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 })
        await rename(path.join(root, 'profile-ready.tmp'), path.join(root, 'profile-ready.json'))
      })().catch(async error => {
        await writeFile(path.join(root, 'profile-failure.json'), JSON.stringify({ name: error.name, message: error.message, stack: error.stack }) + '\n', { flag: 'wx', mode: 0o600 })
      })
    })
    return async () => { stop(); await pending }
  })
}
