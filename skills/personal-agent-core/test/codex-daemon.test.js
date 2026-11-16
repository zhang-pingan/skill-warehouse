import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import test from 'node:test'
import { CodexDaemonManager } from '../lib/codex-daemon.js'

function fixture(overrides = {}) {
  const root = mkdtempSync(path.join('/tmp', 'pacd-'))
  const codexHome = path.join(root, 'codex')
  const socketPath = path.join(codexHome, 'app-server-control', 'app-server-control.sock')
  return {
    root,
    config: { codexHome, codexSocketPath: socketPath, codexBinary: 'codex', manageCodexDaemon: true, ...overrides },
    close: () => rmSync(root, { recursive: true, force: true }),
  }
}

test('daemon lifecycle rejects a custom socket even when it exists', async () => {
  const f = fixture()
  let server
  try {
    const custom = path.join(f.root, 'custom.sock')
    server = net.createServer()
    await new Promise((resolve, reject) => server.listen(custom, resolve).once('error', reject))
    const manager = new CodexDaemonManager({ ...f.config, codexSocketPath: custom })
    await assert.rejects(() => manager.ensureStarted(), /default CODEX_HOME control socket/)
  } finally {
    if (server) await new Promise(resolve => server.close(resolve))
    f.close()
  }
})

test('daemon lifecycle rejects a regular file at the socket path', async () => {
  const f = fixture()
  try {
    mkdirSync(path.dirname(f.config.codexSocketPath), { recursive: true })
    writeFileSync(f.config.codexSocketPath, 'not a socket')
    const manager = new CodexDaemonManager(f.config)
    await assert.rejects(() => manager.ensureStarted(), /not a Unix socket/)
  } finally { f.close() }
})

test('daemon lifecycle starts through the CLI and waits for the default socket', async () => {
  const f = fixture()
  let server
  const calls = []
  try {
    mkdirSync(path.dirname(f.config.codexSocketPath), { recursive: true })
    const execute = async (binary, args, options) => {
      calls.push({ binary, args, options })
      server = net.createServer()
      await new Promise((resolve, reject) => server.listen(f.config.codexSocketPath, resolve).once('error', reject))
      return { stdout: '', stderr: '' }
    }
    const manager = new CodexDaemonManager(f.config, { execute })
    const result = await manager.ensureStarted()
    assert.equal(result.mode, 'daemon-cli')
    assert.deepEqual(calls[0].args, ['app-server','daemon','start'])
    assert.equal(calls[0].options.env.CODEX_HOME, f.config.codexHome)
  } finally {
    if (server) await new Promise(resolve => server.close(resolve))
    f.close()
  }
})
