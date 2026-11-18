import { execFile } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export class CodexDaemonManager {
  constructor(config, { logger = console, execute = exec } = {}) {
    this.config = config
    this.logger = logger
    this.execute = execute
  }

  defaultSocketPath() {
    return path.join(this.config.codexHome, 'app-server-control', 'app-server-control.sock')
  }

  assertDefaultSocket() {
    if (path.resolve(this.config.codexSocketPath) !== path.resolve(this.defaultSocketPath())) throw new Error('Codex daemon lifecycle only supports the default CODEX_HOME control socket')
  }

  async socketExists() {
    try {
      const metadata = await lstat(this.config.codexSocketPath)
      if (!metadata.isSocket()) throw new Error(`Codex App Server path is not a Unix socket: ${this.config.codexSocketPath}`)
      return true
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw error
    }
  }

  async version() {
    try {
      const { stdout } = await this.execute(this.config.codexBinary, ['app-server', 'daemon', 'version'], { encoding: 'utf8', timeout: 10_000 })
      return { available: true, output: stdout.trim() }
    } catch (error) {
      return { available: false, error: error.stderr?.trim() || error.message, code: error.code }
    }
  }

  async ensureStarted({ signal } = {}) {
    signal?.throwIfAborted()
    this.assertDefaultSocket()
    if (await this.socketExists()) return { started: false, mode: 'existing', socketPath: this.config.codexSocketPath }
    if (!this.config.manageCodexDaemon) throw new Error(`Codex App Server socket not found: ${this.config.codexSocketPath}`)
    await this.execute(this.config.codexBinary, ['app-server', 'daemon', 'start'], { encoding: 'utf8', timeout: 20_000, signal, env: { ...process.env, CODEX_HOME: this.config.codexHome } })
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await this.socketExists()) return { started: true, mode: 'daemon-cli', socketPath: this.config.codexSocketPath }
      await setTimeout(50, undefined, { signal })
    }
    throw new Error(`Codex daemon start returned without creating its control socket: ${this.config.codexSocketPath}`)
  }
}
