/** Sample Host timer gaps throughout a request, including its final synchronous continuation. */
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'

export async function observeQuery(operation, intervalMs = 5) {
  await delay(intervalMs)
  let previous = performance.now()
  const gaps = []
  const timer = setInterval(() => { const now = performance.now(); gaps.push(now - previous); previous = now }, intervalMs)
  const started = performance.now()
  try {
    const value = await operation()
    const elapsedMs = performance.now() - started
    await delay(0)
    const tail = performance.now() - previous
    const delays = [...gaps, tail].map(gap => Math.max(0, gap - intervalMs)).sort((a,b)=>a-b)
    return { value, elapsedMs, heartbeat: { intervalMs, ticks:gaps.length, maxDelayMs:Math.max(...delays),
      p95DelayMs:delays[Math.max(0,Math.ceil(delays.length*.95)-1)], maxGapMs:Math.max(...gaps,tail) } }
  } finally { clearInterval(timer) }
}
