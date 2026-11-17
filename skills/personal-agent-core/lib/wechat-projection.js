/** Pure, bounded projection of assistant context and the current/final reply; no delivery effects. */
import { z } from 'zod'

const turn = z.object({ turn: z.number(), requestIds: z.array(z.string()), unidentifiedUserInput: z.boolean(), calls: z.array(z.object({ id: z.string(), name: z.string(), arguments: z.string() })), messageSeq: z.number(), text: z.string() })
export const wechatProjection = {
  key: 'personalAgentWechat',
  stateVersion: 3,
  stateSchema: z.object({ contextLoaded: z.boolean(), current: turn.nullable(), final: turn.extend({ seq: z.number(), reason: z.string() }).nullable() }),
  init: () => ({ contextLoaded: false, current: null, final: null }),
  apply(state, event) {
    if (event.type === 'turn/start') return { ...state, current: { turn: event.data.turn, requestIds: [], unidentifiedUserInput: false, calls: [], messageSeq: -1, text: '' }, final: null }
    if (event.type === 'user/message') {
      const source = event.data.source
      if (source.kind === 'agent-instructions' && source.changes?.some(change => change.path === 'personal-assistant' && change.action === 'add')) return state.contextLoaded ? state : { ...state, contextLoaded: true }
      if (event.surfaceOp === 'append' && source.kind === 'user' && state.current) {
        return { ...state, current: { ...state.current, unidentifiedUserInput: state.current.unidentifiedUserInput || !source.rpcId, requestIds: source.rpcId ? [...new Set([...state.current.requestIds, source.rpcId])] : state.current.requestIds } }
      }
    }
    if (event.type === 'assistant/message' && state.current?.turn === event.data.turn && event.surfaceOp === 'append') {
      const content = event.data.message.content
      const text = event.data.interrupted || content.some(part => part.type === 'tool-call') ? '' : content.filter(part => part.type === 'text').map(part => part.text).join('\n')
      return { ...state, current: { ...state.current, calls: content.filter(part => part.type === 'tool-call').map(({ id, name, arguments: args }) => ({ id, name, arguments: args })), messageSeq: event.seq, text } }
    }
    if (event.type === 'turn/end' && state.current?.turn === event.data.turn) return { ...state, current: null, final: { ...state.current, seq: event.seq, reason: event.data.reason.kind } }
    return state
  },
}
