/** Native execution recovery and latest receipt per child. Receipt storage grows with child identities, not turns; settlement updates copy that index. Effects live in ExecutionResults. */
import { z } from 'zod'

const run = z.object({ executionId:z.string(),requestId:z.string(),messageId:z.string().nullable(),turn:z.number(),startSeq:z.number(),text:z.string() })
const stateSchema=z.object({current:run.nullable(),final:run.extend({seq:z.number(),reason:z.string()}).nullable(),lastNoticeId:z.string().nullable(),settlements:z.record(z.string(),z.number())})
export const executionProjection={
  key:'personalAgentExecution',stateVersion:2,stateSchema,
  init:()=>({current:null,final:null,lastNoticeId:null,settlements:{}}),
  apply(state,event) {
    if (event.type==='user/message' && event.surfaceOp==='append') {
      if (event.data.source?.kind==='subagent-settled') return {...state,settlements:{...state.settlements,[event.data.source.senderSessionId]:event.seq}}
      let value
      for (const block of event.data.content??[]) {
        if (block.type!=='text') continue
        try { const parsed=JSON.parse(block.text);if(parsed?.personalAgentExecution || parsed?.personalAgentResultNotice){value=parsed;break} }
        catch (error) { /* Native sender labels and ordinary text contain no JSON marker. */ }
      }
      if (typeof value?.personalAgentResultNotice==='string' && event.data.source?.rpcId===value.personalAgentResultNotice) return {...state,lastNoticeId:value.personalAgentResultNotice}
      if (typeof value?.personalAgentExecution==='string' && typeof value.requestId==='string') return {...state,current:{executionId:value.personalAgentExecution,requestId:value.requestId,messageId:event.data.id??null,turn:event.data.turn??-1,startSeq:event.seq,text:''}}
    }
    if (event.type==='assistant/message' && state.current && event.surfaceOp==='append') {
      const content=event.data.message.content
      if (event.data.interrupted || content.some(item=>item.type==='tool-call')) return state
      return {...state,current:{...state.current,turn:event.data.turn,text:content.filter(item=>item.type==='text').map(item=>item.text).join('\n')}}
    }
    if (event.type==='turn/end' && state.current && (state.current.turn===-1 || state.current.turn===event.data.turn)) return {...state,current:null,final:{...state.current,seq:event.seq,reason:event.data.reason.kind}}
    return state
  },
  wire:{viewSchema:stateSchema,view:state=>state},
}
