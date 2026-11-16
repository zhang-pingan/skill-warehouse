import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

async function git(cwd, args) {
  try {
    const { stdout } = await exec('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 15_000 })
    return stdout
  } catch (error) {
    if (error.code === 128 || error.code === 'ENOENT') return null
    throw error
  }
}

function dirtyPaths(status) {
  const paths = []
  const entries = status.split('\0').filter(Boolean)
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]
    if (entry.startsWith('# ')) continue
    const fields = entry.split(' ')
    if (entry.startsWith('1 ')) paths.push(fields.slice(8).join(' '))
    else if (entry.startsWith('2 ')) { paths.push(fields.slice(9).join(' ')); i += 1 }
    else if (entry.startsWith('? ') || entry.startsWith('! ')) paths.push(entry.slice(2))
    else if (entry.startsWith('u ')) paths.push(fields.slice(10).join(' '))
  }
  return [...new Set(paths)].sort()
}

async function hashRegularFile(rootReal, relativePath, byteBudget) {
  const target = path.resolve(rootReal, relativePath)
  if (target !== rootReal && !target.startsWith(`${rootReal}${path.sep}`)) return { state: 'outside_root' }
  let info
  try { info = await lstat(target) } catch (error) { return { state: error.code === 'ENOENT' ? 'missing' : 'unreadable', code: error.code } }
  if (info.isSymbolicLink()) return { state: 'symlink', size: info.size }
  if (!info.isFile()) return { state: info.isDirectory() ? 'directory' : 'special', size: info.size }
  if (info.size > byteBudget) return { state: 'budget_exceeded', size: info.size }
  const handle = await open(target, 'r')
  try {
    const afterOpen = await handle.stat()
    if (afterOpen.dev !== info.dev || afterOpen.ino !== info.ino) return { state: 'changed_during_open' }
    const hash = createHash('sha256')
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk)
    return { state: 'hashed', size: afterOpen.size, sha256: hash.digest('hex') }
  } finally { await handle.close() }
}

export async function captureWorkspaceBaseline(workspacePath, { relevantPaths = [], maxHashBytes = 64 * 1024 * 1024 } = {}) {
  if (!path.isAbsolute(workspacePath)) throw new Error('Workspace path must be absolute')
  const rootReal = await realpath(workspacePath)
  const capturedAt = new Date().toISOString()
  const gitHead = (await git(rootReal, ['rev-parse', '--verify', 'HEAD']))?.trim() || null
  const indexListing = await git(rootReal, ['ls-files', '-s', '-z'])
  const gitIndexTree = indexListing === null ? null : createHash('sha256').update(indexListing).digest('hex')
  const statusPorcelain = await git(rootReal, ['status', '--porcelain=v2', '-z', '--untracked-files=all']) ?? ''
  const paths = [...new Set([...dirtyPaths(statusPorcelain), ...relevantPaths])].sort()
  const pathHashes = {}
  let remaining = maxHashBytes
  let captureComplete = true
  for (const relativePath of paths) {
    const result = await hashRegularFile(rootReal, relativePath, remaining)
    pathHashes[relativePath] = result
    if (result.state === 'hashed') remaining -= result.size
    else if (!['missing','directory','symlink'].includes(result.state)) captureComplete = false
  }
  return { capturedAt, rootReal, gitHead, gitIndexTree, statusPorcelain, dirtyPaths: dirtyPaths(statusPorcelain), pathHashes, captureComplete }
}
