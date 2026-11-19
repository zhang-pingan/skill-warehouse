import { Worker } from 'node:worker_threads'

const failure = (code, message, statusCode = 503) => Object.assign(new Error(message), { code, statusCode })

/** Own one lazy read thread. Cancellation stops active work before queued reads can start. */
export class QueryReader {
  constructor(config, { createWorker = () => new Worker(new URL('./query-worker.js', import.meta.url), { workerData: { databasePath: config.databasePath, timeoutMs: config.readQueryTimeoutMs }, execArgv: [] }) } = {}) {
    this.config = config
    this.createWorker = createWorker
    this.queue = []
    this.active = null
    this.worker = null
    this.stopping = null
    this.closed = false
    this.sequence = 0
    this.stopError = null
  }

  run(request, { signal } = {}) {
    if (this.stopError) return Promise.reject(this.stopError)
    if (this.closed) return Promise.reject(failure('READ_QUERY_CLOSED', '查询服务已停止，请重新打开插件后重试。'))
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (this.queue.length + Number(!!this.active) >= this.config.readQueryQueueLimit) return Promise.reject(failure('READ_QUERY_BUSY', '查询请求过多，请等待当前查询完成后重试。', 429))
    return new Promise((resolve, reject) => {
      const item = { id: ++this.sequence, request, resolve, reject, signal }
      item.cancel = () => this.cancel(item, signal.reason ?? failure('READ_QUERY_CANCELLED', '查询已取消。', 499))
      item.timer = setTimeout(() => this.cancel(item, failure('READ_QUERY_TIMEOUT', '查询超时，请缩小筛选范围，或调整 readQueryTimeoutMs 后重试。', 408)), this.config.readQueryTimeoutMs)
      signal?.addEventListener('abort', item.cancel, { once: true })
      this.queue.push(item)
      this.pump()
    })
  }

  settle(item, error, value) {
    clearTimeout(item.timer)
    item.signal?.removeEventListener('abort', item.cancel)
    if (arguments.length === 2) item.reject(error)
    else item.resolve(value)
  }

  cancel(item, error) {
    const index = this.queue.indexOf(item)
    if (index >= 0) { this.queue.splice(index, 1); this.settle(item, error); return }
    if (this.active !== item) return
    this.active = null
    this.settle(item, error)
    this.stopWorker()
  }

  stopWorker() {
    if (this.stopping) return this.stopping
    const worker = this.worker
    this.worker = null
    if (!worker) return Promise.resolve()
    this.stopping = Promise.resolve().then(() => worker.terminate()).then(() => {
      this.stopping = null
      this.pump()
    }, error => {
      // Failed termination leaves ownership uncertain; never open another connection.
      this.stopError = error
      this.stopping = null
      for (const item of this.queue.splice(0)) this.settle(item, error)
      throw error
    })
    // Observe callback-triggered failures; close still reports the same failure.
    void this.stopping.catch(error => { this.stopError = error })
    return this.stopping
  }

  pump() {
    if (this.closed || this.stopError || this.stopping || this.active || !this.queue.length) return
    try {
      if (!this.worker) {
        const worker = this.createWorker()
        this.worker = worker
        worker.on('message', message => {
          if (this.worker !== worker) return
          const item = this.active
          const validError = message?.error && typeof message.error === 'object'
            && typeof message.error.name === 'string' && typeof message.error.message === 'string'
          if (!item || message?.id !== item.id || !Object.hasOwn(message, 'value') && !validError) {
            this.failWorker(worker, failure('READ_QUERY_PROTOCOL', '查询线程返回无效结果，请重试。'))
            return
          }
          this.active = null
          const error = message.error ? Object.assign(new Error(message.error.message), {
            name: message.error.name,
            ...(typeof message.error.code === 'string' ? { code: message.error.code } : {}),
            ...(Number.isInteger(message.error.statusCode) ? { statusCode: message.error.statusCode } : {}),
          }) : null
          if (error) this.settle(item, error)
          else this.settle(item, null, message.value)
          this.pump()
        })
        worker.on('error', error => this.failWorker(worker, failure('READ_QUERY_FAILED', `查询线程异常，请重试：${error.message}`)))
        worker.on('exit', code => {
          if (this.worker === worker) this.failWorker(worker, failure('READ_QUERY_EXITED', `查询线程已退出（${code}），请重试。`))
        })
      }
      this.active = this.queue.shift()
      this.worker.postMessage({ id: this.active.id, request: this.active.request })
    } catch (error) {
      if (this.active) { this.settle(this.active, error); this.active = null }
      else if (this.queue.length) this.settle(this.queue.shift(), error)
      for (const item of this.queue.splice(0)) this.settle(item, error)
      this.stopWorker()
    }
  }

  failWorker(worker, error) {
    if (this.worker !== worker) return
    if (this.active) { this.settle(this.active, error); this.active = null }
    for (const item of this.queue.splice(0)) this.settle(item, error)
    this.stopWorker()
  }

  async close() {
    this.closed = true
    const error = failure('READ_QUERY_CLOSED', '查询已取消：插件正在关闭或初始化记忆。')
    if (this.active) { this.settle(this.active, error); this.active = null }
    for (const item of this.queue.splice(0)) this.settle(item, error)
    await this.stopWorker()
    if (this.stopError) throw this.stopError
  }
}
