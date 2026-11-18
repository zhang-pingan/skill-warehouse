/** Evidence-based terminal observations and complete synthetic workspace snapshots. */
import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, readlink } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const questionsOf = questions => questions.map(question => ({ id: question.id, question: question.question,
  header: question.header ?? null, options: question.options ?? [], multiSelect: question.multiSelect ?? question.multi_select ?? false }))

/** Match a live request to one pending durable call; prose, stale calls and answered requests do not qualify. */
export function pendingQuestionEndpoint(observation, requests, { mainSeq = 0, newExecutionCount = 0 } = {}) {
  if (newExecutionCount !== 0) return null
  const events = observation.events.filter(event => event.seq >= mainSeq)
  const results = new Set(events.filter(event => event.type === 'tool/result').map(event => event.data.message?.toolCallId ?? event.data.message?.source?.callId))
  for (const request of requests) {
    if (request.sessionId !== observation.sessionId || request.settled || request.signal?.aborted || !request.questions?.length) continue
    const calls = events.filter(event => {
      if (event.type !== 'tool/call' || event.data.name !== 'ask_user_question' || results.has(event.data.callId)) return false
      if (request.callId && event.data.callId !== request.callId) return false
      let args
      try { args = JSON.parse(event.data.arguments) } catch (_error) { return false }
      return Array.isArray(args.questions) && isDeepStrictEqual(questionsOf(args.questions), questionsOf(request.questions))
    })
    if (calls.length !== 1) continue
    const call = calls[0]
    return { kind: 'waiting_user', sessionId: observation.sessionId, callId: call.data.callId, callSeq: call.seq,
      requestObserved: true, requestPending: true, durableCallPending: true, newExecutionCount,
      questions: structuredClone(request.questions), observedAt: request.observedAt }
  }
  return null
}

/** Snapshot all workspace entries without following symlinks; fail visibly if a complete read is impossible. */
export async function snapshotWorkspace(root) {
  const entries = {}
  const walk = async relative => {
    const absolute = path.join(root, relative)
    const stat = await lstat(absolute)
    const mode = stat.mode & 0o777
    if (stat.isSymbolicLink()) entries[relative] = { kind: 'symlink', target: await readlink(absolute), mode }
    else if (stat.isDirectory()) {
      if (relative) entries[relative] = { kind: 'directory', mode }
      for (const name of (await readdir(absolute)).sort()) await walk(path.join(relative, name))
    } else if (stat.isFile()) {
      const bytes = await readFile(absolute)
      entries[relative] = { kind: 'file', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mode }
    } else throw new Error(`Unsupported workspace entry: ${relative}`)
  }
  await walk('')
  return { version: 'workspace-files-v1', entries }
}

/** Preserve added, removed and changed paths alongside the legacy source.json-only metric. */
export function compareWorkspaces(before, after) {
  const names = [...new Set([...Object.keys(before.entries), ...Object.keys(after.entries)])].sort()
  const added = [], removed = [], changed = []
  for (const name of names) {
    if (!Object.hasOwn(before.entries, name)) added.push(name)
    else if (!Object.hasOwn(after.entries, name)) removed.push(name)
    else if (!isDeepStrictEqual(before.entries[name], after.entries[name])) changed.push(name)
  }
  return { version: 'workspace-changes-v1', unchanged: added.length + removed.length + changed.length === 0, added, removed, changed, before, after }
}
