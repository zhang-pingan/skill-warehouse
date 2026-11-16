const queryNoise = new Set([
  '帮我', '请问', '请帮我', '看看', '查下', '找下', '查找', '查询', '搜索', '检索', '历史', '会话任务', '会话', '对话',
  '任务', '相关', '最近', '之前', '以前', '过去', '有哪些', '哪个', '什么', '记录', '内容', '一下', 'please', 'find',
  'search', 'history', 'sessions', 'session', 'conversation', 'conversations', 'tasks', 'task', 'about', 'related', 'recent',
  'show', 'look', 'up', 'me', 'for', 'which', 'what',
])

export function searchTerms(input) {
  const text = String(input ?? '').normalize('NFKC')
  const words = text.match(/[\p{L}\p{N}_]+/gu) ?? []
  const runs = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) ?? []
  const cjk = runs.flatMap(run => run.length < 2 ? [run] : Array.from({ length: run.length - 1 }, (_, index) => run.slice(index, index + 2)))
  return [...new Set([...words, ...cjk])].slice(0, 48)
}

/** Reduce a long natural-language query to distinctive lexical topics for a bounded fallback search. */
export function topicSearchTerms(input) {
  let text = String(input ?? '').normalize('NFKC').toLocaleLowerCase()
  for (const noise of [...queryNoise].filter(term => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(term)).sort((a, b) => b.length - a.length)) {
    text = text.replaceAll(noise, ' ')
  }
  const segments = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[\p{L}\p{N}_]+/gu) ?? []
  const terms = segments.flatMap(segment => {
    if (!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(segment)) return queryNoise.has(segment) ? [] : [segment]
    return segment.length < 2 ? [] : Array.from({ length: segment.length - 1 }, (_, index) => segment.slice(index, index + 2))
  })
  return [...new Set(terms)].slice(0, 24)
}

/** Require multiple topic matches while allowing a compact query to recover a longer related phrase. */
export function topicMatchThreshold(terms) {
  return terms.length < 2 ? null : Math.min(4, Math.max(2, Math.ceil(terms.length * 0.45)))
}

export function ftsQuery(input) {
  const tokens = searchTerms(input)
  if (!tokens.length) throw new Error('Search query has no searchable terms')
  return tokens.map(token => `"${token.replaceAll('"', '""')}"`).join(' AND ')
}

/** Describe lexical recall and its limits without changing the agent's query. */
export function retrievalInfo(query, matched, filters = {}, match = null) {
  const fallbackTerms = topicSearchTerms(query)
  const mode = match?.mode ?? (matched ? 'all-terms' : topicMatchThreshold(fallbackTerms) ? 'all-terms-then-topic-fallback' : 'all-terms')
  return {
    mode, terms: searchTerms(query), fallbackTerms, filters,
    ...(match?.matchedTerms ? { matchedTerms: match.matchedTerms, minimumTermMatches: match.minimumTermMatches } : {}),
    status: matched ? 'matched' : 'no-match',
    guidance: matched
      ? mode === 'topic-fallback'
        ? 'Topic fallback results matched the reported number of distinctive query terms in one eligible text fragment. Treat them as leads, verify source details, and group by Session; the results are not a complete Session list.'
        : 'Results are matching evidence, not a complete Session list. Group by session and verify source details before reporting.'
      : mode === 'all-terms'
        ? 'No evidence matched all query terms under these filters. Inspect processing coverage and try a shorter topical query before concluding that no related history exists.'
        : 'No evidence matched the strict query or the conservative topic fallback under these filters. This does not establish that related conversations do not exist. Try a shorter topical query or check health for history import availability.',
  }
}

/** Return normalized terms present in one eligible text fragment. */
export function matchedSearchTerms(text, terms) {
  const value = String(text ?? '').normalize('NFKC').toLocaleLowerCase()
  const words = new Set(value.match(/[\p{L}\p{N}_]+/gu) ?? [])
  return terms.filter(term => {
    const normalized = term.toLocaleLowerCase()
    return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(normalized) ? value.includes(normalized) : words.has(normalized)
  })
}

/** Require every normalized query term in one text fragment. */
export function matchesSearchTerms(text, terms) {
  return terms.length > 0 && matchedSearchTerms(text, terms).length === terms.length
}
