/** Keep one-off observations out of default retrieval and durable extraction. */
export function memoryClass(text) {
  const value = String(text ?? '').trim().toLocaleLowerCase()
  if (!value || /(?:可能|不确定|尚未确认|maybe|uncertain|unverified)/u.test(value)) return 'pending'
  if (/(?:天气|气温|weather|stock price|股价|几点|current time|临时|一次性|just now|today's status)/u.test(value)
    && !/(?:决定|偏好|记住|项目|架构|约定|always|decision|preference|project|architecture)/u.test(value)) return 'temporary'
  return 'recent'
}

/** Keep source offsets stable while separating temporary and useful statements. */
export function memoryFragments(text) {
  return String(text ?? '').split(/(?<=[。！？!?\n])/u).map((text, index) => ({ text: text.trim(), index, memory: memoryClass(text) })).filter(item => item.text)
}
