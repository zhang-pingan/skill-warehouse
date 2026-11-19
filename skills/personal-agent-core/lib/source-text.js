import { gunzipSync } from 'node:zlib'
import { sha256 } from './ids.js'

/** Register the shared bounded archive decoder on a read or write connection. */
export function registerSourceText(db, maxBytes) {
  db.function('source_text', { deterministic: true }, (content, compressed, hash) => {
    if (content !== null) return Buffer.from(content).toString('utf8')
    if (compressed === null) throw new Error('Source body is unavailable; retry after restoring the archive')
    const body=gunzipSync(compressed, { maxOutputLength: maxBytes() })
    if (sha256(body)!==hash) throw new Error('Archived source hash mismatch; restore a verified backup and retry')
    return body.toString('utf8')
  })
}
