/** Fixed synthetic history distributions for service-scale baselines; no personal records. */
export const scaleProtocol = Object.freeze({
  version: 'b0-service-scale-v1', scales: [1000, 10000, 50000], repetitions: 3,
  asOf: '2026-11-18T00:00:00.000Z', messagesPerSession: 20, messagesPerTask: 10,
  lengths: { short: { characters: 256, percent: 70 }, medium: { characters: 2048, percent: 25 }, long: { characters: 8192, percent: 5 } },
  bodies: { hotPercent: 60, gzipArchivedPercent: 40 }, memoriesPerTask: 1,
  memoryStates: { confirmedPercent: 80, candidatePercent: 20 }, sourceSystems: ['dsh', 'codex'],
  roles: ['user', 'assistant', 'tool', 'assistant'], projects: 8, limit: 20,
  passes: ['first', 'repeat'], childTimeoutMs: 600000,
  clock: 'New plain-Node process per sample; ready means production service initialize, health and worker-capability calls completed. Parent wall time includes process bootstrap and modules; initializeMs excludes modules. No GUI endpoint.',
  cache: 'SQLite database copied before each sample; OS filesystem caches not flushed. First is first traversal of the fixed query list, not independently cold queries. History precedes memory for each query, so memory may reuse pages warmed by history; repeat traverses the same order in the same process.',
  memory: 'resourceUsage.maxRSS in KiB includes modules and service; memoryUsage after explicit GC with service and last API response reachable. GC is outside timed requests.',
  verdict: 'Threshold-free baseline; retain all successes, errors and timeouts. Quantiles use linear interpolation; startup p95 from three processes is descriptive only.',
  excluded: ['desktop first paint', 'native DSH session replay', 'worker activation', 'model/network latency', 'background import/extraction/backup/cleanup', 'incremental ingestion throughput', 'segmentation/extraction quality'],
})

const topics = [
  ['reconnect', '恢复队列'], ['rendering', '界面布局'], ['scheduler', '任务调度'], ['storage', '数据归档'],
  ['permissions', '权限检查'], ['routing', '会话续接'], ['observability', '运行监测'], ['packaging', '构建发布'],
]

export const taskToken = task => `scaleitem${String(task).padStart(6, '0')}`
export const taskId = task => `scale-task-${task}`

/** Generate varied prose, code/log fragments and lengths without retaining the corpus. */
export function scaleMessage(index) {
  const task = Math.floor(index / 10), session = Math.floor(index / 20)
  const topic = topics[task % topics.length]
  const bucket = index % 20
  const length = bucket < 14 ? 256 : bucket < 19 ? 2048 : 8192
  const prefix = `${taskToken(task)} ${topic[0]} ${topic[1]} record${index} checkpoint${index % 97}. `
  let text = prefix
  for (let part = 0; text.length < length; part++) {
    const value = ((index + 1) * 2654435761 + part * 2246822519) >>> 0
    text += part % 3 === 0
      ? `步骤${part}：验证${topic[1]}，保留来源、重试次数与最终状态。 request_${value.toString(36)} `
      : part % 3 === 1 ? `const checkpoint${part} = { status: "ready", count: ${value % 10000}, revision: "${value.toString(16)}" }; `
        : `trace=${value.toString(16)} elapsed=${value % 1000}ms; ${topic[0]} completed; no pending operation. `
  }
  return { index, task, session, topic: topic[0], topicLabel: topic[1], text: text.slice(0, length),
    quote: prefix.trim(), role: scaleProtocol.roles[index % 4], archived: (index + session) % 5 < 2,
    system: session % 2 === 0 ? 'dsh' : 'codex',
    occurredAt: new Date(Date.parse('2026-10-01T00:00:00.000Z') + index * 60000).toISOString() }
}

/** Query order and expectations are fixed before any benchmark response is observed. */
export function scaleQueries(messages) {
  const tasks = messages / 10
  return [0, Math.floor(tasks / 4), Math.floor(tasks / 2), tasks - 1].map((task, i) => ({
    id: `exact-${i}`, kind: 'exact', query: taskToken(task), taskId: taskId(task),
  })).concat([
    { id: 'broad-en', kind: 'broad', query: 'reconnect' },
    { id: 'broad-zh', kind: 'broad', query: '恢复队列' },
    { id: 'negative', kind: 'absent', query: 'nonexistentquasarpayload' },
  ])
}
