export function formatCitation(citation) {
  if (!citation) return '[source unavailable]'
  const location = citation.locator ? `:${citation.locator}` : ''
  return `[${citation.system}:${citation.externalId ?? 'unknown'}${location}]`
}

export function answerWithCitations(results, { heading = '历史证据', max = 8 } = {}) {
  const selected = results.slice(0, max)
  if (!selected.length) return `${heading}\n\n没有找到可引用的历史证据。`
  return `${heading}\n\n${selected.map(item => `- ${item.snippet} ${formatCitation(item.citation)}`).join('\n')}`
}
