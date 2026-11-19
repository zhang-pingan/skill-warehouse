/** Shared worker directory admission and Codex desktop-compatible default directories. */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * Validate configured roots without requiring mounted directories to be online at settings load.
 * @param roots - Absolute directory paths; an empty list adds no plugin restriction.
 * @returns Frozen normalized, deduplicated paths.
 */
export function normalizeWorkspaceRoots(roots) {
  if (!Array.isArray(roots)) throw new TypeError('工作目录白名单必须是绝对路径列表。')
  return Object.freeze([...new Set(roots.map(root => {
    if (typeof root !== 'string' || !path.isAbsolute(root) || /[\u0000-\u001f\u007f]/u.test(root)) throw new TypeError('工作目录白名单中的每一项都必须是有效的绝对路径。')
    return path.resolve(root)
  }))])
}

/**
 * Resolve symlinks, including existing ancestors when preparing a new default directory.
 * @param directory - Absolute directory to resolve.
 * @param options - Whether absent descendants of a real directory are allowed.
 * @returns Canonical path; files and dangling symlinks reject.
 */
export async function canonicalDirectory(directory, { allowMissing = false } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('workspacePath must be absolute')
  let canonical
  try { canonical = await realpath(directory) }
  catch (error) {
    if (!allowMissing || error.code !== 'ENOENT') throw error
    // A dangling symlink must not be mistaken for an absent directory.
    let entry
    try { entry = await lstat(directory) } catch (statError) { if (statError.code !== 'ENOENT') throw statError }
    if (entry) throw error
    const parent = path.dirname(directory)
    if (parent === directory) throw error
    return path.join(await canonicalDirectory(parent, { allowMissing: true }), path.basename(directory))
  }
  if (!(await stat(canonical)).isDirectory()) throw new Error('workspacePath must be an existing directory')
  return canonical
}

/**
 * @param root - Canonical root directory.
 * @param directory - Canonical candidate directory.
 * @returns Whether the candidate is the root itself or one of its descendants.
 */
export function directoryWithin(root, directory) {
  const relative = path.relative(root, directory)
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/**
 * Empty roots add no plugin restriction; native worker permissions remain independent.
 * @param directory - Canonical directory selected for execution.
 * @param roots - Configured allowed directories, resolved before comparison.
 * @returns Resolves on admission; rejects disallowed paths or unavailable configured roots.
 */
export async function assertAllowedDirectory(directory, roots) {
  if (!roots.length) return
  for (const configured of roots) {
    const root = await canonicalDirectory(configured)
    if (directoryWithin(root, directory)) return
  }
  throw Object.assign(new Error(`工作目录不在允许范围内：${directory}。请在私人助理的 Worker 设置中调整工作目录白名单，或明确指定允许的目录。`), { code: 'WORKER_WORKSPACE_NOT_ALLOWED' })
}

/**
 * Read the desktop directory setting through App Server; managed storage takes precedence.
 * @param adapter - Connected local Codex App Server adapter.
 * @param homeDirectory - Execution host's user home, as used by Codex desktop.
 * @returns Absolute default root; configuration read failures reject without guessing a directory.
 */
export async function codexDefaultWorkspaceRoot(adapter, homeDirectory = os.homedir()) {
  const config = await adapter.request('config/read', { includeLayers: false })
  const requirements = await adapter.request('configRequirements/read')
  if (!config?.config || typeof config.config !== 'object' || Array.isArray(config.config)) throw new Error('Codex 未返回有效配置，无法确定默认工作目录。')
  const configured = requirements?.requirements?.application?.storage?.projectlessWorkspaceRoot ?? config.config.desktop?.projectlessWorkspaceRoot
  const root = configured ?? path.join(homeDirectory, 'Documents', 'Codex')
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Codex 的 projectlessWorkspaceRoot 必须是绝对路径。')
  return root
}

/**
 * Match Codex desktop's date/name layout, with a separate directory for each new worker.
 * @param options - Root, objective, directory admission callback, cancellation and local date.
 * @returns Canonical task directory containing work and outputs folders. Failure never reuses an existing task folder; preparation may leave an empty newly created folder.
 */
export async function createCodexWorkspace({ root, objective, authorize, signal, date = new Date() }) {
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const words = objective.toLowerCase().match(/[a-z0-9]+/g)
  const name = words?.length ? words.slice(0, 6).join('-').slice(0, 80) : 'new-chat'
  const dateDirectory = path.join(root, day)
  for (let attempt = 0; attempt < 105; attempt++) {
    signal?.throwIfAborted()
    const suffix = attempt === 0 ? '' : `-${attempt < 100 ? attempt + 1 : randomUUID()}`
    const directory = await authorize(path.join(dateDirectory, `${name}${suffix}`), { allowMissing: true })
    signal?.throwIfAborted()
    await mkdir(path.dirname(directory), { recursive: true })
    await authorize(directory, { allowMissing: true })
    try { await mkdir(directory) }
    catch (error) { if (error.code === 'EEXIST') continue; throw error }
    const canonical = await authorize(directory)
    await mkdir(path.join(canonical, 'outputs'))
    await mkdir(path.join(canonical, 'work'))
    signal?.throwIfAborted()
    return canonical
  }
  throw new Error('无法为 Codex worker 创建独立工作目录，请明确指定目录后重试。')
}
