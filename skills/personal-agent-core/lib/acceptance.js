/** Parse persisted criterion definitions; result records never define requirements. */
export function criteriaOf(items) {
  return items.flatMap((item, index) => typeof item === 'string' && item.trim()
    ? [{ id: String(index), text: item }]
    : item?.kind === 'criterion' && typeof item.text === 'string' && item.text.trim()
      ? [{ id: String(item.id ?? index), text: item.text }] : [])
}

/** Validate public requirements before any task or execution side effect. */
export function requireCriteria(items) {
  if (!Array.isArray(items) || !items.length || items.length > 32 || criteriaOf(items).length !== items.length) throw new TypeError('Tasks require 1–32 acceptance criteria')
  const ids = criteriaOf(items).map(item => item.id)
  if (new Set(ids).size !== ids.length) throw new TypeError('Acceptance criterion ids must be unique')
  return items
}
