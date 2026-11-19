import { DatabaseSync } from 'node:sqlite'
import { registerSourceText } from './source-text.js'

/** Open an existing ledger without schema setup or write privileges. */
export function openQueryDatabase(databasePath, timeoutMs, maxBytes) {
  const db = new DatabaseSync(databasePath, { readOnly: true, timeout: timeoutMs })
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;')
    registerSourceText(db, maxBytes)
    return db
  } catch (error) { db.close(); throw error }
}

/** All statements of one response observe the same committed SQLite snapshot. */
export function querySnapshot(db, read) {
  db.exec('BEGIN')
  try { return read() } finally { db.exec('ROLLBACK') }
}
