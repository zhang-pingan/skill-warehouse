import { createHash, randomUUID } from 'node:crypto'

export const sha256 = value => createHash('sha256').update(value).digest('hex')
export const stableId = (prefix, ...parts) => `${prefix}_${sha256(parts.map(value => String(value ?? '')).join('\0')).slice(0, 32)}`
export const newId = prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`
export const nowIso = clock => new Date(clock?.() ?? Date.now()).toISOString()
export const json = value => JSON.stringify(value ?? null)
export const parseJson = (value, fallback = null) => {
  try { return value === null || value === undefined ? fallback : JSON.parse(value) } catch { return fallback }
}
export const cleanText = (value, max = 8_000) => String(value ?? '').replaceAll('\r\n', '\n').trim().slice(0, max)

export const encodeRpcId = value => {
  if (typeof value === 'number' && Number.isFinite(value)) return `n:${JSON.stringify(value)}`
  if (typeof value === 'string') return `s:${value}`
  throw new TypeError('JSON-RPC request id must be a finite number or string')
}
export const decodeRpcId = value => {
  if (typeof value !== 'string') return value
  if (value.startsWith('n:')) {
    try { return JSON.parse(value.slice(2)) } catch { return value }
  }
  if (value.startsWith('s:')) return value.slice(2)
  return value
}
