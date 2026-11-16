import { readFileSync, readdirSync, mkdirSync, copyFileSync, statSync, lstatSync, writeFileSync, existsSync, rmSync, chmodSync, openSync, closeSync, constants } from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { sha256, nowIso } from './ids.js'
import { FEATURE_DEFAULTS } from './config.js'

const terminalExecutionStates = new Set(['succeeded', 'failed', 'cancelled', 'interrupted'])

const readRegularFile = file => {
  const metadata = lstatSync(file)
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Expected a regular file: ${file}`)
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try { return readFileSync(fd) } finally { closeSync(fd) }
}

export class LedgerDatabase {
  constructor(config, { clock = Date.now } = {}) {
    this.config = config
    this.clock = clock
    this.db = null
    this.closed = false
    this.savepointCounter = 0
  }

  open() {
    if (this.db) return this
    mkdirSync(path.dirname(this.config.databasePath), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(this.config.databasePath, { timeout: 5_000 })
    this.closed = false
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF;')
      this.db.function('source_text', { deterministic: true }, (content, compressed, hash) => {
        if (content !== null) return Buffer.from(content).toString('utf8')
        if (compressed === null) throw new Error('Source body is unavailable; retry after restoring the archive')
        const body=gunzipSync(compressed, { maxOutputLength: this.config.maxHistoryRecordBytes })
        if (sha256(body)!==hash) throw new Error('Archived source hash mismatch; restore a verified backup and retry')
        return body.toString('utf8')
      })
      this.ensureSchema()
      this.seedFeatures()
      return this
    } catch (error) {
      const database = this.db
      this.db = null
      this.closed = true
      try { database?.close() } catch (closeError) {
        throw new AggregateError([error, closeError], 'Personal-agent database initialization and cleanup failed')
      }
      throw error
    }
  }

  ensureSchema() {
    const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')
    const version = this.db.prepare('PRAGMA user_version').get().user_version
    if (this.hasTable('evidence') && version !== 1) throw new Error('Memory schema requires explicit initialization before installing this version')
    this.db.exec(schema)
  }

  /** Replace a retired database with the current empty schema. */
  recreateCurrentSchema(schema) {
    this.clearManagedBackups()
    this.db.exec('PRAGMA defer_foreign_keys=ON')
    const objects = this.db.prepare("SELECT name,type FROM sqlite_master WHERE type IN ('table','view') AND name=tbl_name AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts_%'").all()
    for (const { name, type } of objects) {
      this.db.exec(`DROP ${type === 'view' ? 'VIEW' : 'TABLE'} IF EXISTS "${name.replaceAll('"', '""')}"`)
    }
    this.db.exec(schema)
  }

  /** Remove managed database snapshots that contain the retired local records. */
  clearManagedBackups() {
    if (!existsSync(this.config.backupDir)) return
    const names = readdirSync(this.config.backupDir).filter(name => /^ledger-[0-9TZ.-]+\.sqlite(?:\.manifest\.json)?$/.test(name))
    for (const name of names) {
      const file = path.join(this.config.backupDir, name)
      let metadata
      try { metadata = lstatSync(file) } catch (error) {
        if (error?.code === 'ENOENT') continue
        throw error
      }
      if (metadata.isFile() && !metadata.isSymbolicLink()) rmSync(file)
    }
  }

  hasTable(name) {
    return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
  }

  /** Empty memory and dependent operational records without changing table definitions or preferences. */
  clearMemoryData() {
    const retained = new Set(['runtime_settings', 'feature_flags'])
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=tbl_name AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts_%'").all()
      .map(row => row.name).filter(name => !retained.has(name))
    return this.transaction(() => {
      this.db.exec('PRAGMA defer_foreign_keys=ON')
      const counts = {}
      for (const name of tables) {
        const quoted = `"${name.replaceAll('"', '""')}"`
        counts[name] = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM ${quoted}`).get().count)
        this.db.exec(`DELETE FROM ${quoted}`)
      }
      return counts
    })
  }

  seedFeatures() {
    const statement = this.db.prepare('INSERT OR IGNORE INTO feature_flags(flag_name, enabled, source, updated_at) VALUES(?,?,?,?)')
    const at = nowIso(this.clock)
    this.transaction(() => {
      for (const [name, enabled] of Object.entries(FEATURE_DEFAULTS)) statement.run(name, enabled ? 1 : 0, 'default', at)
    })
  }

  transaction(callback) {
    this.assertOpen()
    if (this.db.isTransaction) {
      const savepoint = `dsh_sp_${++this.savepointCounter}`
      this.db.exec(`SAVEPOINT ${savepoint}`)
      try {
        const result = callback()
        this.db.exec(`RELEASE SAVEPOINT ${savepoint}`)
        return result
      } catch (error) {
        try {
          this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`)
          this.db.exec(`RELEASE SAVEPOINT ${savepoint}`)
        } catch {}
        throw error
      }
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = callback()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch {}
      throw error
    }
  }

  integrityCheck() {
    this.assertOpen()
    const rows = this.db.prepare('PRAGMA integrity_check').all()
    return { ok: rows.length === 1 && rows[0].integrity_check === 'ok', rows }
  }

  backup(destination) {
    this.assertOpen()
    const target = path.resolve(destination)
    if (target === path.resolve(this.config.databasePath)) throw new Error('Backup destination must differ from the live ledger')
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    this.db.exec('PRAGMA wal_checkpoint(FULL)')
    copyFileSync(this.config.databasePath, target, constants.COPYFILE_EXCL)
    chmodSync(target, 0o600)
    const manifest = {
      databaseFile: path.basename(target),
      bytes: statSync(target).size,
      sha256: sha256(readRegularFile(target)),
      createdAt: nowIso(this.clock),
    }
    const manifestPath = `${target}.manifest.json`
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    return { path: target, manifestPath, ...manifest }
  }

  backupPath(name) {
    if (typeof name !== 'string' || !/^ledger-[0-9TZ.-]+\.sqlite$/.test(name) || path.basename(name) !== name) throw new Error('Backup name is invalid')
    return path.join(this.config.backupDir, name)
  }

  validateManagedBackup(name) {
    return this.validateBackup(this.backupPath(name))
  }

  listManagedBackups() {
    if (!existsSync(this.config.backupDir)) return []
    return readdirSync(this.config.backupDir)
      .filter(name => /^ledger-[0-9TZ.-]+\.sqlite$/.test(name))
      .map(name => {
        const file = this.backupPath(name)
        const metadata = lstatSync(file)
        return metadata.isFile() && !metadata.isSymbolicLink() ? { name, path: file, mtimeMs: metadata.mtimeMs, bytes: metadata.size } : null
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))
  }

  pruneManagedBackups(retain = this.config.backupRetention) {
    const removed = []
    for (const backup of this.listManagedBackups().slice(Math.max(2, retain))) {
      rmSync(backup.path, { force: true })
      rmSync(`${backup.path}.manifest.json`, { force: true })
      removed.push(backup.name)
    }
    return removed
  }

  validateBackup(source) {
    const candidate = path.resolve(source)
    if (!existsSync(candidate)) throw new Error(`Backup does not exist: ${candidate}`)
    const manifestPath = `${candidate}.manifest.json`
    const manifest = existsSync(manifestPath) ? JSON.parse(readRegularFile(manifestPath).toString('utf8')) : null
    const bytes = lstatSync(candidate).size
    const digest = sha256(readRegularFile(candidate))
    if (manifest) {
      if (manifest.databaseFile !== path.basename(candidate)) throw new Error('Backup manifest filename mismatch')
      if (manifest.bytes !== bytes) throw new Error('Backup manifest size mismatch')
      if (manifest.sha256 !== digest) throw new Error('Backup manifest hash mismatch')
    }
    const restored = new DatabaseSync(candidate, { readOnly: true })
    try {
      restored.exec('PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;')
      const rows = restored.prepare('PRAGMA integrity_check').all()
      const integrityOk = rows.length === 1 && rows[0].integrity_check === 'ok'
      if (!integrityOk) throw new Error(`Backup integrity check failed: ${JSON.stringify(rows)}`)
      if (restored.prepare('PRAGMA user_version').get().user_version !== 1) throw new Error('Backup uses an unsupported memory schema')
      for (const row of restored.prepare('SELECT content_hash,byte_size,compressed FROM source_blobs WHERE content IS NULL').all()) {
        const body=gunzipSync(row.compressed,{maxOutputLength:this.config.maxHistoryRecordBytes})
        if(body.length!==row.byte_size||sha256(body)!==row.content_hash)throw new Error('Backup archive verification failed')
      }
      const counts = Object.fromEntries(['projects','tasks','session_refs','evidence','executions','events'].map(table => [table, Number(restored.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count)]))
      return { ok: true, path: candidate, manifestPath: manifest ? manifestPath : null, bytes, sha256: digest, counts }
    } finally {
      restored.close()
    }
  }

  restoreToNewPath(source, destination) {
    const target = path.resolve(destination)
    if (existsSync(target) || existsSync(`${target}.manifest.json`)) throw new Error(`Restore destination already exists: ${target}`)
    const validatedSource = this.validateBackup(source)
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    try {
      copyFileSync(validatedSource.path, target)
      chmodSync(target, 0o600)
      const manifest = {
        databaseFile: path.basename(target),
        bytes: validatedSource.bytes,
        sha256: validatedSource.sha256,
        createdAt: nowIso(this.clock),
        restoredFrom: validatedSource.path,
      }
      writeFileSync(`${target}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
      return { ...this.validateBackup(target), restoredFrom: validatedSource.path }
    } catch (error) {
      rmSync(target, { force: true })
      rmSync(`${target}.manifest.json`, { force: true })
      throw error
    }
  }

  featureFlags() {
    return Object.fromEntries(this.db.prepare('SELECT flag_name, enabled FROM feature_flags ORDER BY flag_name').all()
      .map(row => [row.flag_name, !!row.enabled]))
  }

  setFeature(name, enabled, source = 'user') {
    if (!(name in FEATURE_DEFAULTS)) throw new Error(`Unknown feature flag: ${name}`)
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be boolean')
    const mutationFlags = new Set(['codex.new_thread.execute', 'routing.resume', 'routing.fork', 'control.steer', 'control.queue'])
    if (enabled && mutationFlags.has(name) && !this.featureFlags()['codex.daemon.connect']) {
      throw new Error(`${name} requires codex.daemon.connect`)
    }
    this.db.prepare('INSERT INTO feature_flags(flag_name,enabled,source,updated_at) VALUES(?,?,?,?) ON CONFLICT(flag_name) DO UPDATE SET enabled=excluded.enabled,source=excluded.source,updated_at=excluded.updated_at')
      .run(name, enabled ? 1 : 0, source, nowIso(this.clock))
    return this.featureFlags()
  }

  health() {
    this.assertOpen()
    const scalar = sql => Number(Object.values(this.db.prepare(sql).get())[0])
    return {
      projects: scalar('SELECT COUNT(*) FROM projects'),
      tasks: scalar('SELECT COUNT(*) FROM tasks'),
      sessions: scalar('SELECT COUNT(*) FROM session_refs'),
      evidence: scalar('SELECT COUNT(*) FROM evidence'),
      executionsOpen: scalar(`SELECT COUNT(*) FROM executions WHERE execution_state NOT IN ('succeeded','failed','cancelled','interrupted')`),
      outboxUncertain: scalar(`SELECT COUNT(*) FROM outbox WHERE outbox_state='uncertain'`),
      recoveryHolds: scalar(`SELECT COUNT(*) FROM leases WHERE lease_state='recovery_hold'`),
      attentionOpen: scalar(`SELECT COUNT(*) FROM attention_items WHERE state='open'`),
      flags: this.featureFlags(),
    }
  }

  recoverLocalState() {
    const at = nowIso(this.clock)
    return this.transaction(() => {
      const uncertain = this.db.prepare(`UPDATE outbox SET outbox_state='uncertain', last_error=COALESCE(last_error,'process restarted while sending') WHERE outbox_state='sending'`).run()
      const reconciling = this.db.prepare(`UPDATE executions SET execution_state='reconciling' WHERE execution_state IN ('running','dispatch_unknown') OR (execution_state='dispatch_pending' AND execution_id IN (SELECT execution_id FROM outbox WHERE outbox_state='uncertain'))`).run()
      const holds = this.db.prepare(`UPDATE leases SET lease_state='recovery_hold', heartbeat_at=? WHERE mode='write' AND lease_state='active' AND execution_id IN (SELECT execution_id FROM executions WHERE execution_state='reconciling')`).run(at)
      const staleApprovalExecutions = this.db.prepare(`SELECT DISTINCT execution_id FROM approvals WHERE approval_state='pending'`).all()
      const invalidatedApprovals = this.db.prepare(`UPDATE approvals SET approval_state='invalidated', decided_at=? WHERE approval_state='pending'`).run(at)
      const approvalReconciliation = staleApprovalExecutions.length
        ? this.db.prepare(`UPDATE executions SET execution_state='reconciling'
          WHERE execution_state='waiting_approval' AND execution_id IN (${staleApprovalExecutions.map(() => '?').join(',')})`).run(...staleApprovalExecutions.map(row => row.execution_id))
        : { changes: 0 }
      const approvalHolds = staleApprovalExecutions.length
        ? this.db.prepare(`UPDATE leases SET lease_state='recovery_hold', heartbeat_at=?, release_reason=COALESCE(release_reason,'approval connection lost')
          WHERE mode='write' AND lease_state='active' AND execution_id IN (${staleApprovalExecutions.map(() => '?').join(',')})`).run(at, ...staleApprovalExecutions.map(row => row.execution_id))
        : { changes: 0 }
      if (staleApprovalExecutions.length) this.db.prepare(`UPDATE attention_items SET state='resolved',updated_at=?
        WHERE state='open' AND kind='approval_required' AND execution_id IN (${staleApprovalExecutions.map(() => '?').join(',')})`).run(at, ...staleApprovalExecutions.map(row => row.execution_id))
      return {
        uncertainOutbox: Number(uncertain.changes),
        reconcilingExecutions: Number(reconciling.changes) + Number(approvalReconciliation.changes),
        recoveryHolds: Number(holds.changes) + Number(approvalHolds.changes),
        invalidatedApprovals: Number(invalidatedApprovals.changes),
      }
    })
  }

  close() {
    if (!this.db || this.closed) return
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    this.db.close()
    this.closed = true
    this.db = null
  }

  assertOpen() {
    if (!this.db || this.closed) throw new Error('Ledger database is not open')
  }
}

export { terminalExecutionStates }
