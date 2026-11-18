/** Exact-ID retrieval scores and seeded source-family bootstrap intervals. */
export const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
export function quantile(values, fraction) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]
}

export function recall(actual, expected) {
  if (!expected.length) return null
  const found = new Set(actual)
  return new Set(expected).size ? [...new Set(expected)].filter(id => found.has(id)).length / new Set(expected).size : null
}

export function reciprocalRank(actual, expected) {
  if (!expected.length) return null
  const first = actual.findIndex(id => expected.includes(id))
  return first < 0 ? 0 : 1 / (first + 1)
}

/** Resample source-family means, never treat repeated queries as independent samples. */
export function familyInterval(rows, field, { draws = 2000, seed = 18427 } = {}) {
  const families = new Map()
  for (const row of rows) {
    if (row[field] === null || row[field] === undefined) continue
    if (!families.has(row.familyId)) families.set(row.familyId, [])
    families.get(row.familyId).push(row[field])
  }
  const values = [...families.values()].map(mean)
  if (!values.length) return { value: null, low: null, high: null, families: 0 }
  let state = seed >>> 0
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296 }
  const samples = Array.from({ length: draws }, () => mean(values.map(() => values[Math.floor(random() * values.length)])))
  return { value: mean(values), low: quantile(samples, 0.025), high: quantile(samples, 0.975), families: values.length }
}

/** Score only observed IDs; an unexecuted or failed query receives zero recall. */
export function scoreRetrieval(testCase, { taskIds = [], evidenceIds = [], memoryIds = [] }) {
  const gold = testCase.expected
  return { taskRecall: recall(taskIds, gold.sessionTaskIds ?? []), evidenceRecall: recall(evidenceIds, gold.evidenceMessageIds ?? []),
    memoryRecall: recall(memoryIds, gold.memoryIds ?? []), taskMrr: reciprocalRank(taskIds, gold.sessionTaskIds ?? []) }
}

/** Literal answer/evidence rubric; this is a diagnostic, not a semantic judge. */
export function scoreAnswer(testCase, answer) {
  if (!answer || typeof answer !== 'object' || typeof answer.answer !== 'string' || !Array.isArray(answer.evidenceMessageIds) || typeof answer.abstain !== 'boolean') {
    return { parsed: false, lexicalAnswerPass: false, evidenceRecall: 0, abstentionCorrect: false, routeCorrect: false }
  }
  const expected = testCase.expected
  const text = answer.answer.toLocaleLowerCase()
  const literal = (expected.answerTerms ?? []).every(term => text.includes(term.toLocaleLowerCase()))
    && !(expected.forbiddenAnswerTerms ?? []).some(term => text.includes(term.toLocaleLowerCase()))
  const evidence = recall(answer.evidenceMessageIds, expected.evidenceMessageIds ?? [])
  const route = expected.route
  return { parsed: true, lexicalAnswerPass: answer.abstain === expected.abstain && (expected.abstain || literal) && (evidence === null || evidence === 1),
    evidenceRecall: evidence, abstentionCorrect: answer.abstain === expected.abstain,
    routeCorrect: !route ? null : answer.route?.decision === route.decision && (!route.targetSessionTaskId || answer.route?.targetSessionTaskId === route.targetSessionTaskId) }
}
