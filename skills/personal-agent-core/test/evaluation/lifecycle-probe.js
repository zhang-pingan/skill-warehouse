/** Native compaction, process restoration and request deduplication in isolated persistence. */
import assert from 'node:assert/strict'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile, realpath, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PersonalAgentService } from '../../lib/service.js'
import { resolveConfig } from '../../lib/config.js'
import { MainSession } from '../../lib/main-session.js'
import { wechatProjection } from '../../lib/wechat-projection.js'
import { executionProjection } from '../../lib/execution-projection.js'
import { ExecutionResults } from '../../lib/execution-results.js'
import { isAssistantContext } from '../../lib/assistant-context.js'
import { TOOL } from '../../index.js'
import { runLifecycleGuards } from './lifecycle-guards.js'

export const inject = ['webServer', 'agents', 'subagents', 'agentPresets', 'agentDefaultModel', 'sessionPersistence', 'sessionProjections', 'sessionController', 'sessionQuery', 'sessionTitle', 'workspaceRegistry', 'workspaceController', 'workingDirectory', 'tools']

async function observe(ctx, sessionId) {
  await ctx.sessionPersistence.flush()
  const handle = await ctx.sessionPersistence.open(sessionId, 'read'), events = []
  try {
    while (true) { const page = await handle.read(events.length, 256); if (!page.events.length) break; events.push(...page.events) }
  } finally { await handle.close() }
  const messages = events.filter(event => event.type === 'assistant/message' && event.surfaceOp === 'append')
  const final = messages.filter(event => !event.data.message.content.some(block => block.type === 'tool-call')).at(-1)
  return { sessionId, text: final?.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? '',
    endings: events.filter(event => event.type === 'turn/end').map(event => event.data.reason), events,
    contextMessages: events.filter(event => event.type === 'user/message' && isAssistantContext(event.data)).length,
    compactions: events.filter(event => event.type.startsWith('compaction/')).map(event => ({ seq: event.seq, type: event.type, data: event.data })) }
}

function reply(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

function jsonAnswer(text) { return JSON.parse(text.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '')) }

export async function apply(ctx) {
  const root = await realpath(process.env.DSH_EVALUATION_ROOT)
  if (await realpath(process.env.DSH_HOME) !== path.join(root, 'harness-home') || await realpath(process.env.CODEX_HOME) !== path.join(root, 'codex-home')) throw new Error('Lifecycle evaluation requires isolated homes')
  const selection = JSON.parse(process.env.DSH_EVALUATION_SELECTION), token = Buffer.from(`Bearer ${process.env.DSH_EVALUATION_TOKEN}`)
  const lifetime = new AbortController(), pending = new Set()
  await ctx.workspaceRegistry.initializeDefault(async () => path.join(root, 'workspace'))
  const mainProjection = await ctx.sessionProjections.register(wechatProjection), workerProjection = await ctx.sessionProjections.register(executionProjection)
  const service = new PersonalAgentService(resolveConfig({ dataDir: path.join(root, 'lifecycle-ledger'), codexHome: path.join(root, 'codex-home'),
    allowedWorkspaceRoots: [path.join(root, 'workspace')], historyRead: false, semanticRoutingEnabled: false, historySyncOnStart: false,
    inboxRetryEnabled: false, memoryExtractionEnabled: false, cleanupEnabled: false, codexWorkerEnabled: false, analysisInputChars: 100000 }), { context: ctx })
  await service.initialize()
  service.results = new ExecutionResults(service, workerProjection)
  const mainSession = new MainSession(service, mainProjection)
  service.mainSession = mainSession
  const tool = ctx.tools.register({ ...TOOL, execute: async (args, execution) => service.operate({ ...args,
    ...(args.action === 'execute' && !args.requestId ? { requestId: execution.callId } : {}) },
  { actor: 'assistant', codexMutationAuthority: false, featureAuthority: false, approvalAuthority: false, agent: execution.agent, signal: execution.signal }) })
  const eventDispose = ctx.on('session/event', (session, event) => { if (service.database.db && event.type === 'turn/end') service.results.captureTerminal(session) })
  const run = async options => {
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(options.budgetMs)]), started = performance.now(), evidence = []
    let target
    const cancel = () => target?.agent.cancel({ kind: 'user' })
    signal.addEventListener('abort', cancel, { once: true })
    const ask = async text => {
      const requestId = randomUUID()
      await ctx.sessionController.prompt({ sessionId: target.sessionId, requestId, mode: 'queue', clientTimeZone: 'UTC', content: [{ type: 'text', text }] }, signal)
      await target.agent.whenIdle()
      const observation = await observe(ctx, target.sessionId)
      evidence.push({ requestId, prompt: text, observation })
      assert.equal(observation.endings.at(-1)?.kind, 'completed')
      return observation
    }
    try {
      target = await mainSession.ensure()
      target.agent.model.select(selection)
      if (options.purpose === 'lifecycle-prepare') {
        const seed = options.input.seed
        assert.match(seed, /^lifecycle-\d+$/u)
        const facts = Array.from({ length: 26 }, (_, index) => `归档批次 ${index + 1}：记录编号 ${seed}-${index + 1}；这些是只读演示条目，状态为未部署，联系人为合成占位符，无需操作。`).join('\n')
        await ask(`以下是当前对话的合成资料，只需要在本对话理解，不要写入持久记忆、创建任务或调用工具。项目 ${seed} 的服务端口为 4100，健康检查路径为 /health，环境为 staging，禁止部署 production。\n${facts}\n本轮只回复“已读”。`)
        await ask(`更正刚才项目 ${seed} 的当前要求：端口改为 4201，健康检查路径改为 /ready，环境仍为 staging，禁止部署 production。旧端口 4100 和旧路径 /health 已失效。这里只更新当前对话，不需要任何外部操作或工具。本轮只回复“已更新”。`)
        const before = await observe(ctx, target.sessionId)
        const surfaceBefore = [...target.agent.session.surface.nodes]
        const compaction = ctx.agentPresets.serviceFor(target.agent, 'compaction')
        assert.ok(compaction, 'The standard preset must provide native compaction')
        const compactStarted = performance.now(), compacted = await compaction.compactNow(target.agent, signal)
        const compactElapsedMs = performance.now() - compactStarted
        assert.ok(compacted, 'Native manual compaction must select a useful span')
        const after = await observe(ctx, target.sessionId), surfaceAfter = [...target.agent.session.surface.nodes]
        assert.ok(after.compactions.some(event => event.type === 'compaction/end'))
        assert.ok(surfaceAfter.length < surfaceBefore.length, 'Compaction must reduce the effective surface')
        const verifyPrompt = `仅依据当前对话，返回项目 ${seed} 的最新配置。不要使用工具、持久记忆或文件。仅返回 JSON，字段为 port（数字）、health（路径字符串）、environment（字符串）、productionAllowed（布尔值）。`
        const checked = await ask(verifyPrompt)
        assert.deepEqual(jsonAnswer(checked.text), { port: 4201, health: '/ready', environment: 'staging', productionAllowed: false })
        const contextCount = checked.contextMessages
        for (let index = 0; index < 8; index++) await mainSession.ensure()
        assert.equal((await observe(ctx, target.sessionId)).contextMessages, contextCount)
        const guards = await runLifecycleGuards(path.join(root, 'lifecycle-guards'))
        // This probe measures direct request identity; main-session reporting is covered by the autonomy probe.
        service.mainSession = null
        const workerRequest = { objective: `Synthetic ${seed} request: reply with exactly {"duplicate":"once"}. Do not use tools or modify files.`, intent: 'new',
          requestId: `duplicate-${seed}`, workspacePath: path.join(root, 'workspace'), mutatesWorkspace: false,
          modelProvider: selection.provider, model: selection.model, acceptance: ['Return the specified JSON without modifying files.'] }
        const first = await service.executeObjective(workerRequest, { agent: target.agent, signal })
        evidence.push({ workerRequest, first })
        assert.ok(first.executionId && first.childId, JSON.stringify(first))
        assert.equal(first.stopReason, 'completed')
        const second = await service.executeObjective(workerRequest, { agent: target.agent, signal })
        assert.equal(second.repeated, true); assert.equal(second.executionId, first.executionId)
        const worker = await observe(ctx, first.childId)
        assert.deepEqual(jsonAnswer(worker.text), { duplicate: 'once' })
        assert.equal(worker.endings.length, 1)
        const state = { sessionId: target.sessionId, seed, contextCount, verifyPrompt, workerRequest, first,
          mainVersion: mainSession.binding().version, compactions: checked.compactions.length,
          executionCount: service.database.db.prepare('SELECT COUNT(*) AS n FROM executions').get().n }
        await writeFile(path.join(root, 'lifecycle-state.json'), JSON.stringify(state, null, 2) + '\n', { flag: 'wx' })
        return { ok: true, purpose: options.purpose, elapsedMs: performance.now() - started, processId: process.pid,
          evidence, guards, compaction: { compacted, compactElapsedMs, surfaceBefore, surfaceAfter, before, after }, duplicate: { first, second, worker }, state }
      }
      if (options.purpose !== 'lifecycle-restored') throw new Error('Unknown lifecycle phase')
      const state = JSON.parse(await readFile(path.join(root, 'lifecycle-state.json'), 'utf8'))
      assert.equal(target.sessionId, state.sessionId)
      assert.equal(mainSession.binding().version, state.mainVersion)
      const before = await observe(ctx, target.sessionId)
      assert.equal(before.contextMessages, state.contextCount)
      assert.equal(before.compactions.length, state.compactions)
      const checked = await ask(state.verifyPrompt)
      assert.deepEqual(jsonAnswer(checked.text), { port: 4201, health: '/ready', environment: 'staging', productionAllowed: false })
      service.mainSession = null
      const repeated = await service.executeObjective(state.workerRequest, { agent: target.agent, signal })
      assert.equal(repeated.repeated, true); assert.equal(repeated.executionId, state.first.executionId)
      assert.equal(service.database.db.prepare('SELECT COUNT(*) AS n FROM executions').get().n, state.executionCount)
      const worker = await observe(ctx, state.first.childId)
      assert.equal(worker.endings.length, 1)
      return { ok: true, purpose: options.purpose, elapsedMs: performance.now() - started, processId: process.pid,
        sameSession: true, evidence, before, repeated, worker, contextNotDuplicated: checked.contextMessages === state.contextCount }
    } catch (error) {
      return { ok: false, purpose: options.purpose, elapsedMs: performance.now() - started, evidence,
        observation: target ? await observe(ctx, target.sessionId) : null, error: { name: error.name, message: error.message, stack: error.stack } }
    } finally {
      signal.removeEventListener('abort', cancel)
      if (target?.agent.status === 'running') { cancel(); await target.agent.whenIdle() }
    }
  }
  const route = ctx.webServer.register({ kind: 'exact', path: '/api/evaluation/infer', handler: async (req, res) => {
    const actual = Buffer.from(String(req.headers.authorization ?? ''))
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || actual.length !== token.length || !timingSafeEqual(actual, token)) return reply(res, 403, { error: 'Unauthorized' })
    if (req.method !== 'POST' || lifetime.signal.aborted || pending.size) return reply(res, 409, { error: 'Lifecycle phases must run sequentially' })
    const operation = (async () => {
      try {
        const chunks = []; let bytes = 0
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 65536) throw new Error('Request too large'); chunks.push(chunk) }
        const options = JSON.parse(Buffer.concat(chunks).toString())
        if (!Number.isInteger(options.budgetMs) || options.budgetMs < 1000 || options.budgetMs > 600000) throw new Error('Invalid request budget')
        reply(res, 200, await run(options))
      } catch (error) { reply(res, 500, { ok: false, error: { name: error.name, message: error.message } }) }
    })()
    pending.add(operation)
    try { await operation } finally { pending.delete(operation) }
  } })
  ctx.effect(() => async () => {
    route(); lifetime.abort(); await Promise.allSettled([...pending]); await service.dispose(); tool(); eventDispose();
    await mainProjection.dispose(); await workerProjection.dispose()
  })
  const ready = path.join(root, 'ready.json')
  await writeFile(ready + '.tmp', JSON.stringify({ endpoint: `http://127.0.0.1:${ctx.webServer.port}/api/evaluation/infer`, model: selection }) + '\n', { mode: 0o600, flag: 'wx' })
  await rename(ready + '.tmp', ready)
}
