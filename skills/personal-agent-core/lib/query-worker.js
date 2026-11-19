import { parentPort, workerData } from 'node:worker_threads'
import { openQueryDatabase, querySnapshot } from './query-connection.js'
import { executeRead } from './query-engine.js'

// No schema setup, timers, account connections or agent services in this thread.
let maxBytes
const db = openQueryDatabase(workerData.databasePath, workerData.timeoutMs, () => maxBytes)
parentPort.on('message', message => {
  const { id, request } = message
  try {
    if (!Number.isSafeInteger(id) || !request || !request.args || typeof request.args !== 'object'
      || !Number.isFinite(request.now) || !Number.isSafeInteger(request.settings?.maxHistoryRecordBytes)) throw new TypeError('Invalid read request')
    maxBytes = request.settings.maxHistoryRecordBytes
    const value = querySnapshot(db, () => executeRead(db, request))
    parentPort.postMessage({ id, value })
  } catch (error) {
    parentPort.postMessage({ id, error: { name: error.name, message: error.message, code: error.code, statusCode: error.statusCode } })
  }
})
