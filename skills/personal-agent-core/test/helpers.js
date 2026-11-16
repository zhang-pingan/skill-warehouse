import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveConfig } from '../lib/config.js'
import { LedgerDatabase } from '../lib/database.js'
import { Ledger } from '../lib/ledger.js'

export function fixture(options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'personal-agent-test-'))
  const config = resolveConfig({ dataDir: path.join(root, 'data'), codexHome: path.join(root, 'codex'), ...options })
  const database = new LedgerDatabase(config).open()
  const ledger = new Ledger(database, { instanceId: 'test-instance' })
  return {
    root, config, database, ledger,
    close() { database.close(); rmSync(root, { recursive: true, force: true }) },
  }
}

export function seedTask(ledger, root) {
  const project = ledger.upsertProject({ name: 'fixture', canonicalPath: root })
  const task = ledger.createTask({ objective: 'Implement durable history', sourceKey: 'test:task', projectId: project.projectId, state: 'open' })
  const location = ledger.db.prepare('SELECT location_id FROM project_locations WHERE project_id=?').get(project.projectId)
  return { project, task, location }
}
