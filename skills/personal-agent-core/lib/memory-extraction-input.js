/** Pack complete experiences, or consecutive excerpts of one long experience, within the serialized input budget. */
export function extractionInputs(rows, maxChars) {
  const item = (row, text = row.text, offset = 0) => ({ id: row.evidence_id, text, role: row.author_role,
    source: row.source_system, occurredAt: row.occurred_at, offset, totalChars: row.text.length })
  const packed = []
  for (const row of rows) {
    const next = item(row)
    if (JSON.stringify({ evidence: [...packed, next] }).length > maxChars) break
    packed.push(next)
  }
  if (packed.length) return [{ input: { evidence: packed }, rows: rows.slice(0, packed.length) }]
  if (!rows.length) return []
  const row = rows[0]
  const batches = []
  let offset = 0
  while (offset < row.text.length) {
    let low = 0, high = row.text.length - offset
    while (low < high) {
      const length = Math.ceil((low + high) / 2)
      if (JSON.stringify({ evidence: [item(row, row.text.slice(offset, offset + length), offset)] }).length <= maxChars) low = length
      else high = length - 1
    }
    if (!low) throw new Error('Extraction source metadata exceeds the configured input budget')
    let end = offset + low
    if (end < row.text.length && /[\uD800-\uDBFF]/u.test(row.text[end - 1])) end -= 1
    if (end <= offset) throw new Error('Extraction input budget cannot fit a source character')
    const text = row.text.slice(offset, end)
    batches.push({ input: { evidence: [item(row, text, offset)] }, rows: [{ ...row, text }] })
    offset = end
  }
  return batches
}
