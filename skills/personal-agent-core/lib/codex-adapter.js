import { EventEmitter } from 'node:events'
import net from 'node:net'
import WebSocket from 'ws'
import { newId, sha256 } from './ids.js'

const READ_ONLY_METHODS = new Set([
  'thread/list', 'thread/read', 'thread/loaded/list', 'thread/turns/list', 'thread/items/list',
  'thread/queue/list', 'model/list', 'account/read', 'skills/list', 'config/read',
])
const MUTATION_METHODS = new Set([
  'thread/start', 'thread/resume', 'thread/fork', 'thread/archive', 'thread/unarchive', 'thread/delete', 'thread/unsubscribe',
  'turn/start', 'turn/steer', 'turn/interrupt', 'thread/queue/add', 'thread/queue/update', 'thread/queue/delete', 'thread/queue/reorder', 'thread/queue/start',
])
const isRpcId = value => typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function invalidMessage(reason) {
  return Object.assign(new Error(`Invalid Codex App Server message: ${reason}`), { code: 'CODEX_PROTOCOL_ERROR' })
}

function report(logger, level, message, details) {
  try {
    if (typeof logger?.[level] === 'function') {
      logger[level](message, details)
      return
    }
  } catch (loggerError) {
    // Fall back to the process logger when the configured logger is unavailable.
  }
  try { console[level]?.(message, details) }
  catch (consoleError) { /* No independent logger is available. */ }
}

/** Validate the inbound RPC envelope without including remote content in diagnostics. */
function parseMessage(data) {
  let message
  try { message = JSON.parse(data.toString('utf8')) }
  catch { throw invalidMessage('invalid JSON') }
  if (!isRecord(message)) throw invalidMessage('expected an object')
  const hasId = Object.hasOwn(message, 'id')
  const hasMethod = Object.hasOwn(message, 'method')
  const hasResult = Object.hasOwn(message, 'result')
  const hasError = Object.hasOwn(message, 'error')
  if (hasId && !isRpcId(message.id)) throw invalidMessage('id must be a string or finite number')
  if (hasResult || hasError) {
    if (!hasId || hasMethod || hasResult === hasError) throw invalidMessage('invalid response envelope')
    if (hasError && (!isRecord(message.error) || !Number.isInteger(message.error.code) || typeof message.error.message !== 'string')) {
      throw invalidMessage('error must contain an integer code and message')
    }
    return message
  }
  if (!hasMethod || typeof message.method !== 'string' || !message.method.trim()) throw invalidMessage('method must be a nonempty string')
  if (message.params != null && !isRecord(message.params)) throw invalidMessage('params must be an object')
  if (message.params?.eventId != null && !isRpcId(message.params.eventId)) throw invalidMessage('params.eventId must be a string or finite number')
  return message
}

export class CodexRpcError extends Error {
  constructor(method, error) {
    super(`${method}: ${error?.message ?? 'unknown RPC error'}`)
    this.name = 'CodexRpcError'
    this.method = method
    this.code = error?.code
    this.data = error?.data
  }
}

export class CodexAppServerAdapter extends EventEmitter {
  constructor(config, { ledger = null, logger = console, requestTimeoutMs = 30_000, authorizeMutation = null } = {}) {
    super()
    this.config = config
    this.ledger = ledger
    this.logger = logger
    this.requestTimeoutMs = requestTimeoutMs
    this.authorizeMutation = authorizeMutation ?? (() => false)
    this.adapterInstanceId = newId('adapter')
    this.connectionEpoch = 0
    this.nextRequestId = 1
    this.pending = new Map()
    this.ws = null
    this.initialized = false
    this.serverInfo = null
    this.connectPromise = null
    this.closePromise = null
  }

  connect() {
    if (this.connectPromise) return this.connectPromise
    if (this.closePromise) return this.closePromise.then(() => this.connect())
    if (this.ws?.readyState === WebSocket.OPEN && this.initialized) return Promise.resolve(this.serverInfo)
    const promise = this._connect()
    const tracked = promise.finally(() => {
      if (this.connectPromise === tracked) this.connectPromise = null
    })
    this.connectPromise = tracked
    return tracked
  }

  async _connect() {
    this.connectionEpoch += 1
    const epoch = this.connectionEpoch
    this.initialized = false
    const ws = new WebSocket('ws://localhost/', {
      createConnection: () => net.connect({ path: this.config.codexSocketPath }),
      perMessageDeflate: false,
      maxPayload: 64 * 1024 * 1024,
      handshakeTimeout: 10_000,
    })
    this.ws = ws
    ws.on('message', data => this.onMessage(data, epoch))
    ws.on('close', (code, reason) => this.onClose(epoch, code, reason))
    ws.on('error', error => this.emit('transportError', error))
    try {
      await new Promise((resolve, reject) => {
        const cleanup = () => { ws.off('open', onOpen); ws.off('error', onError) }
        const onOpen = () => { cleanup(); resolve() }
        const onError = error => { cleanup(); reject(error) }
        ws.once('open', onOpen)
        ws.once('error', onError)
      })
      const result = await this.request('initialize', {
        clientInfo: { name: 'dsh-personal-agent-core', title: 'DSH Personal Agent', version: '0.1.0' },
        capabilities: {
          experimentalApi: !!this.config.experimentalCodexApi,
          requestAttestation: false,
          optOutNotificationMethods: [],
          extensions: {},
        },
      }, { allowBeforeInitialize: true, socket: ws, epoch })
      if (this.ws !== ws || this.connectionEpoch !== epoch || this.closePromise) throw new Error('Codex connection was superseded')
      this.notify('initialized', undefined, { socket: ws, epoch })
      this.initialized = true
      this.serverInfo = result
      this.emit('ready', { ...result, adapterInstanceId: this.adapterInstanceId, connectionEpoch: epoch })
      return result
    } catch (error) {
      if (this.ws === ws && this.connectionEpoch === epoch) {
        this.ws = null
        this.initialized = false
      }
      try { if (ws.readyState !== WebSocket.CLOSED) ws.terminate() } catch {}
      throw error
    }
  }

  request(method, params, { timeoutMs = this.requestTimeoutMs, allowBeforeInitialize = false, socket = this.ws, epoch = this.connectionEpoch } = {}) {
    if (socket?.readyState !== WebSocket.OPEN || socket !== this.ws || epoch !== this.connectionEpoch) return Promise.reject(new Error('Codex App Server is not connected'))
    if (!allowBeforeInitialize && !this.initialized) return Promise.reject(new Error('Codex App Server is not initialized'))
    if (!READ_ONLY_METHODS.has(method) && !MUTATION_METHODS.has(method) && method !== 'initialize') return Promise.reject(new Error(`Method is not in the adapter allowlist: ${method}`))
    if (MUTATION_METHODS.has(method) && method !== 'thread/unsubscribe' && !this.authorizeMutation(method)) return Promise.reject(new Error(`Codex mutation is not authorized: ${method}`))
    if ((method.startsWith('thread/queue/') || method === 'thread/turns/list' || method === 'thread/items/list') && !this.config.experimentalCodexApi) return Promise.reject(new Error(`Experimental Codex API is disabled: ${method}`))
    const id = this.nextRequestId++
    const envelope = params === undefined ? { id, method } : { id, method, params }
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, timer: null, method, epoch }
      const fail = error => {
        if (this.pending.get(id) !== pending) return
        clearTimeout(pending.timer)
        this.pending.delete(id)
        error.deliveryUnknown = MUTATION_METHODS.has(method)
        reject(error)
      }
      pending.timer = setTimeout(() => {
        if (this.pending.get(id) !== pending) return
        this.pending.delete(id)
        const error = new Error(`Codex request timed out: ${method}`)
        error.code = 'RPC_TIMEOUT'
        error.deliveryUnknown = MUTATION_METHODS.has(method)
        reject(error)
      }, timeoutMs)
      pending.timer.unref?.()
      this.pending.set(id, pending)
      try {
        socket.send(JSON.stringify(envelope), error => {
          if (error) fail(error)
        })
      } catch (error) {
        fail(error)
      }
    })
  }

  notify(method, params, { socket = this.ws, epoch = this.connectionEpoch } = {}) {
    if (socket?.readyState !== WebSocket.OPEN || socket !== this.ws || epoch !== this.connectionEpoch) throw new Error('Codex App Server is not connected')
    socket.send(JSON.stringify(params === undefined ? { method } : { method, params }))
  }

  replyToServerRequest(requestHandle, decision) {
    if (!requestHandle || requestHandle.adapterInstanceId !== this.adapterInstanceId || requestHandle.connectionEpoch !== this.connectionEpoch) {
      return Promise.reject(new Error('Server request belongs to another adapter connection'))
    }
    const socket = this.ws
    if (socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Original server request connection is closed'))
    const response = decision?.error
      ? { id: requestHandle.externalRequestId, error: decision.error }
      : { id: requestHandle.externalRequestId, result: decision?.result ?? decision }
    return new Promise((resolve, reject) => {
      try {
        socket.send(JSON.stringify(response), error => error ? reject(error) : resolve())
      } catch (error) {
        reject(error)
      }
    })
  }

  /** Reject malformed frames and unrecorded input before dispatch; failed RPC replies remain pending. */
  onMessage(data, epoch) {
    if (epoch !== this.connectionEpoch) return
    let message
    try { message = parseMessage(data) }
    catch (error) {
      report(this.logger, 'warn', 'Codex message rejected; no input was dispatched. Check App Server compatibility if this persists.', { code: error.code, error: error.message })
      this.emit('protocolError', error)
      return
    }
    if (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')) {
      const pending = this.pending.get(message.id)
      if (!pending || pending.epoch !== epoch) { this.emit('orphanResponse', message); return }
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error) pending.reject(new CodexRpcError(pending.method, message.error))
      else pending.resolve(message.result)
      return
    }
    const handle = Object.hasOwn(message, 'id')
      ? { adapterInstanceId: this.adapterInstanceId, connectionEpoch: epoch, externalRequestId: message.id, method: message.method }
      : null
    let inbox
    try { inbox = this.persistInbound(message, handle) }
    catch (cause) {
      const error = Object.assign(new Error('Unable to record Codex App Server input', { cause }), { code: 'CODEX_INBOX_PERSISTENCE_FAILED' })
      report(this.logger, 'error', 'Codex input was not dispatched or acknowledged. Check ledger storage and reconcile active work before retrying.', { code: error.code, error: cause?.message ?? error.message })
      this.emit('inboxPersistenceError', error)
      return
    }
    if (!inbox.pending) return
    const input = { method: message.method, params: message.params ?? {}, inboxId: inbox.inboxId }
    if (handle) this.emit('serverRequest', { ...input, handle })
    else this.emit('notification', input)
  }

  persistInbound(message, handle = null) {
    if (!this.ledger) return { inboxId: null, inserted: true, pending: true, processError: null }
    const eventId = handle?.externalRequestId ?? message.params?.eventId ?? null
    const dedupeKey = sha256(JSON.stringify([this.adapterInstanceId, this.connectionEpoch, eventId, message.method, message.params]))
    return this.ledger.recordInbox({ adapterInstanceId: this.adapterInstanceId, connectionEpoch: this.connectionEpoch, externalEventId: eventId, method: message.method, payload: message.params ?? {}, dedupeKey })
  }

  rejectPending(epoch, error) {
    for (const [id, pending] of this.pending) {
      if (pending.epoch !== epoch) continue
      clearTimeout(pending.timer)
      pending.reject(error(pending.method))
      this.pending.delete(id)
    }
  }

  onClose(epoch, code, reason) {
    this.rejectPending(epoch, method => {
      const error = new Error(`Codex connection closed during ${method}: ${code} ${reason}`)
      error.code = 'RPC_CONNECTION_CLOSED'
      error.deliveryUnknown = MUTATION_METHODS.has(method)
      return error
    })
    if (epoch !== this.connectionEpoch) return
    this.initialized = false
    this.emit('disconnected', { code, reason: reason.toString(), connectionEpoch: epoch })
  }

  close({ unsubscribeThreadIds = [] } = {}) {
    if (this.closePromise) return this.closePromise
    const socket = this.ws
    const epoch = this.connectionEpoch
    if (!socket) {
      this.initialized = false
      return Promise.resolve()
    }
    const promise = (async () => {
      for (const threadId of unsubscribeThreadIds) {
        try {
          await this.request('thread/unsubscribe', { threadId }, { timeoutMs: 5_000, socket, epoch })
        } catch (error) {
          this.logger.warn?.('Codex unsubscribe failed', { threadId, error: error.message })
        }
      }
      this.initialized = false
      await new Promise(resolve => {
        let settled = false
        let timer = null
        const done = () => {
          if (settled) return
          settled = true
          if (timer) clearTimeout(timer)
          socket.off('close', done)
          resolve()
        }
        if (socket.readyState === WebSocket.CLOSED) {
          this.rejectPending(epoch, method => {
            const error = new Error(`Codex connection was already closed during ${method}`)
            error.code = 'RPC_CONNECTION_CLOSED'
            error.deliveryUnknown = MUTATION_METHODS.has(method)
            return error
          })
          return done()
        }
        socket.once('close', done)
        timer = setTimeout(() => {
          this.rejectPending(epoch, method => {
            const error = new Error(`Codex connection terminated during ${method}`)
            error.code = 'RPC_CONNECTION_CLOSED'
            error.deliveryUnknown = MUTATION_METHODS.has(method)
            return error
          })
          try { if (socket.readyState !== WebSocket.CLOSED) socket.terminate() } catch {}
          done()
        }, 2_000)
        timer.unref?.()
        try {
          socket.close(1000, 'DSH personal agent shutdown')
        } catch {
          this.rejectPending(epoch, method => {
            const error = new Error(`Codex connection closed during ${method}`)
            error.code = 'RPC_CONNECTION_CLOSED'
            error.deliveryUnknown = MUTATION_METHODS.has(method)
            return error
          })
          try { socket.terminate() } catch {}
          done()
        }
      })
      if (this.ws === socket && this.connectionEpoch === epoch) {
        this.ws = null
        this.initialized = false
      }
    })()
    const tracked = promise.finally(() => {
      if (this.closePromise === tracked) this.closePromise = null
    })
    this.closePromise = tracked
    return tracked
  }
}

export { READ_ONLY_METHODS, MUTATION_METHODS }
