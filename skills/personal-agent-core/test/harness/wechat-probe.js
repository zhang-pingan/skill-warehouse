/** Real Harness Session and projection exercise; all Tencent calls stay in this fixture. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PersonalAgentService } from '../../lib/service.js'
import { resolveConfig } from '../../lib/config.js'
import { MainSession } from '../../lib/main-session.js'
import { WechatChannel } from '../../lib/wechat-channel.js'
import { WechatApi, parseWechatUpdates } from '../../lib/wechat-api.js'
import { registerWechatInteractions } from '../../lib/wechat-interactions.js'
import { wechatProjection } from '../../lib/wechat-projection.js'
import { isAssistantContext, assistantContextMessage } from '../../lib/assistant-context.js'

export async function runWechatProbe(ctx, root) {
  const projection=await ctx.sessionProjections.register(wechatProjection)
  const service=new PersonalAgentService(resolveConfig({dataDir:path.join(root,`wechat-probe-${crypto.randomUUID()}`),codexHome:path.join(root,'codex'),wechatLockDir:path.join(root,'locks'),historyRead:false,memoryExtractionEnabled:false,cleanupEnabled:false}),{context:ctx})
  const sent=[], disposers=[]
  try {
    await service.initialize()
    service.mainSession=new MainSession(service,projection)
    service.wechat=new WechatChannel(service,projection,{api:{async send(_credential,_peer,_context,id,text){sent.push({id,text})},
      async updates(_credential,_cursor,signal){return new Promise((_,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true})})}}})
    const [target,other]=await Promise.all([service.mainSession.ensure(),service.mainSession.ensure()])
    assert.equal(target.sessionId,other.sessionId)
    target.agent.inject(assistantContextMessage())
    await service.mainSession.ensure();await service.mainSession.ensure()
    assert.equal(target.agent.inbox.nextStep.filter(isAssistantContext).length,1)
    assert.equal(projection.stateOf(target.agent.session).contextLoaded,false)
    const ordinary=await ctx.sessionController.create({cwd:root,agentPreset:'standard'})
    const resolved=await ctx.sessionController.resolveAgent(ordinary.sessionId)
    if ('error' in resolved) throw new Error('Cannot restore ordinary fixture conversation')
    await resolved.agent.model.select({provider:'personal-agent-smoke',model:'fixture',reasoningEffort:'off'})
    await ctx.sessionController.prompt({sessionId:ordinary.sessionId,requestId:'ordinary-memory-source',mode:'queue',content:[{type:'text',text:'记住我喜欢简洁的回答'}]},new AbortController().signal)
    await resolved.agent.whenIdle()
    const remembered=await service.operate({action:'remember',content:'我喜欢简洁的回答'},{actor:'assistant',agent:resolved.agent})
    const source=service.database.db.prepare('SELECT s.external_id,e.source_uri FROM memory_sources m JOIN evidence e USING(evidence_id) JOIN session_refs s USING(session_ref_id) WHERE m.memory_id=?').get(remembered.id)
    assert.equal(source.external_id,ordinary.sessionId)
    assert.equal(source.source_uri,`dsh://session/${ordinary.sessionId}`)
    assert.equal(service.isAssistantSession(ordinary.sessionId),false)
    assert.equal(projection.stateOf(resolved.agent.session).contextLoaded,false)
    assert.equal(service.isAssistantSession(target.sessionId),true)
    assert.equal((await service.mainSession.ensure()).sessionId,target.sessionId)
    assert.equal(ctx.commands.list(resolved.agent).some(command=>command.name==='personal-assistant'),false)
    assert.equal(Object.hasOwn(service.wechat.view(),'candidates'),false)
    await assert.rejects(service.wechat.manage({action:'bind-session',sessionId:ordinary.sessionId}),/不支持的微信操作/)

    await target.agent.model.select({provider:'personal-agent-smoke',model:'fixture',reasoningEffort:'off'})
    const channel=service.wechat
    channel.store.update({account_id:'fixture-account'})
    await channel.saveCredentials(()=>({accountId:'fixture-account',token:'fixture-only',baseUrl:'https://ilinkai.weixin.qq.com',peers:{}}))
    await channel.acceptBatch({cursor:'before-binding',messages:[{peer:'fixture-owner',externalId:'first',text:'not authorized',contextToken:'fixture-context'}]})
    assert.equal(service.database.db.prepare('SELECT COUNT(*) AS n FROM wechat_inbox').get().n,0)
    await channel.saveCredentials(current=>({...current,userId:'fixture-owner'}))
    channel.loginUserId='fixture-owner'
    channel.lifetime=new AbortController()
    await channel.acquireAccountLock()
    const transport=new WechatApi(service.config,{fetchImpl:async()=>new Response('{"get_updates_buf":"after-binding","msgs":[{"message_type":1,"message_id":9223372036854775807,"from_user_id":"fixture-owner","context_token":"fixture-context","item_list":[{"type":1,"text_item":{"text":"微信原文 fixture: please continue in the shared conversation."}}]}]}')})
    const batch=parseWechatUpdates(await transport.updates({token:'fixture-only'},'before-binding',new AbortController().signal))
    assert.equal(batch.messages[0].externalId,'9223372036854775807')
    await channel.acceptBatch(batch);await channel.acceptBatch(batch)
    const signal=new AbortController().signal
    assert.equal(channel.view().identityStatus,'verified')
    await channel.reconcile(signal)
    assert.equal(target.agent.inbox.nextStep.filter(isAssistantContext).length,1)
    assert.equal(projection.stateOf(target.agent.session).contextLoaded,false)
    await channel.dispatch(signal)
    await target.agent.whenIdle()
    await channel.reconcile(signal);await channel.sendPending(signal)
    assert.equal(sent.length,1)
    assert.equal(sent[0].text,'Recorded fixture result: verification output observed.')
    await channel.dispatch(signal);await channel.reconcile(signal);await channel.sendPending(signal)
    assert.equal(sent.length,1)
    await ctx.sessionController.prompt({sessionId:target.sessionId,requestId:'desktop-followup',mode:'queue',content:[{type:'text',text:'Desktop followup in the same conversation.'}]},signal)
    await target.agent.whenIdle()
    await channel.reconcile(signal);await channel.sendPending(signal)
    assert.equal(sent.length,2)
    const log=await ctx.sessionPersistence.open(target.sessionId,'read')
    let events=[]
    try{let offset=0;while(true){const page=await log.read(offset,256);events.push(...page.events);offset+=page.events.length;if(page.events.length<256)break}}finally{await log.close()}
    const users=events.filter(e=>e.type==='user/message' && e.data.source.kind==='user')
    assert.equal(users.length,2)
    assert.equal(users.filter(e=>e.data.source.rpcId?.startsWith('wx-')).length,1)
    assert.equal(users[0].data.content[0].text,batch.messages[0].text)
    assert.equal(projection.stateOf(target.agent.session).contextLoaded,true)
    assert.equal(events.filter(e=>e.type==='user/message'&&isAssistantContext(e.data)).length,1)
    service.config={...service.config,wechatEnabled:true,wechatRemoteApprovalEnabled:true}
    channel.lifetime=new AbortController()
    let offered=Promise.withResolvers(), persistenceFailureClosed=false
    channel.kick=()=>{const card=channel.interactions.view()[0];if(card)offered.resolve(card)}
    disposers.push(...registerWechatInteractions(ctx,Promise.resolve(),()=>channel.interactions))
    disposers.push(ctx.tools.register({name:'wechat_fixture',description:'Exercise native question and approval from the real agent loop.',
      parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
      execute:async(_args,exec)=>{
        const question=await ctx.userQuestions.ask({agent:exec.agent,signal:exec.signal,questions:[{id:'native-wx',question:'Shared question fixture',options:[{label:'Continue'},{label:'Stop'}]}]})
        assert.deepEqual(question,{answers:[{id:'native-wx',selected:['Continue']}]})
        const approval=await ctx.approval.request({agent:exec.agent,signal:exec.signal,toolName:'wechat_fixture',callId:exec.callId,reason:'Native one-time approval fixture'})
        assert.equal(approval,'allowed-once')
        const denied=await ctx.approval.request({agent:exec.agent,signal:exec.signal,toolName:'wechat_fixture',callId:exec.callId,reason:'Persistence failure fixture'})
        persistenceFailureClosed=denied==='unavailable'
        assert.equal(persistenceFailureClosed,true)
        return {question:true,approval:true,persistenceFailureClosed}
      }}))
    await ctx.sessionController.prompt({sessionId:target.sessionId,requestId:'wechat-native-interactions',mode:'queue',content:[{type:'text',text:'Native WeChat interaction fixture'}]},signal)
    const q=await offered.promise
    offered=Promise.withResolvers()
    await channel.interactions.answer({id:'native-question',peer:'fixture-owner',text:`/wx-answer ${q.id} 1:A`})
    const a=await offered.promise
    assert.match(a.prompt,/工具调用参数/)
    offered=Promise.withResolvers()
    await channel.interactions.answer({id:'native-approval',peer:'fixture-owner',text:`/wx-approval ${a.id} allow`})
    const failedCard=await offered.promise
    const transaction=service.database.transaction.bind(service.database)
    let failed=false
    service.database.transaction=callback=>{if(!failed){failed=true;throw new Error('fixture settlement write failed')}return transaction(callback)}
    try {await assert.rejects(channel.interactions.answer({id:'native-failed-approval',peer:'fixture-owner',text:`/wx-approval ${failedCard.id} allow`}),/fixture settlement write failed/)}
    finally {service.database.transaction=transaction}
    await target.agent.whenIdle()
    assert.equal(channel.interactions.view().length,0)
    const credentialBefore=await channel.credentials(), receiveCursor=channel.store.channel().cursor
    const memoriesBefore=service.database.db.prepare('SELECT * FROM memory_records ORDER BY memory_id').all()
    const reset=service.mainSession.reset
    reset.start({confirmed:true,expectedSessionId:target.sessionId})
    await reset.operation
    assert.equal(reset.view().state,'succeeded',JSON.stringify(reset.view()))
    const replacement=await service.mainSession.ensure()
    assert.notEqual(replacement.sessionId,target.sessionId)
    assert.equal(ctx.workspaceRegistry.archivedSessionIds.includes(target.sessionId),true)
    assert.equal(ctx.sessionTitle.get(target.agent.session).title,'鲸鱼娘-废弃会话-1')
    assert.equal(ctx.sessionTitle.get(replacement.agent.session).title,'鲸鱼娘')
    await ctx.agentPresets.select(replacement.agent,'cordis')
    await service.mainSession.ensure()
    assert.equal(ctx.agentPresets.presetForSession(replacement.agent.session),'standard')
    const titleSeq=replacement.agent.session.seq
    await service.mainSession.ensure();await service.mainSession.ensure()
    assert.equal(replacement.agent.session.seq,titleSeq)
    assert.equal(replacement.agent.inbox.nextStep.filter(isAssistantContext).length,1)
    assert.deepEqual(service.database.db.prepare('SELECT * FROM memory_records ORDER BY memory_id').all(),memoriesBefore)
    assert.deepEqual(await channel.credentials(),credentialBefore)
    assert.equal(channel.store.channel().cursor,receiveCursor)
    assert.equal(channel.store.channel().session_id,replacement.sessionId)
    await channel.reconcile(signal)
    assert.equal(channel.store.channel().observed_seq,replacement.agent.session.seq-1)
    assert.equal(projection.stateOf(replacement.agent.session).current,null)
    assert.equal(projection.stateOf(replacement.agent.session).final,null)
    const imported=service.database.db.prepare('SELECT h.* FROM history_messages h JOIN session_refs s USING(session_ref_id) WHERE s.external_id=?').all(target.sessionId)
    assert.equal(imported.filter(row=>row.staged_text===users[0].data.content[0].text).length,1)
    assert.equal(imported.some(row=>row.staged_text?.includes('For direct work on a persistent Task')),false)
    const snapshot={singleMainSession:true,ordinaryMemorySourcePreserved:true,ordinaryAssistantAuthority:false,roleCommandAbsent:true,sessionSelectionAbsent:true,nativeQuestion:true,nativeApproval:true,nativeApprovalScope:true,nativePersistenceFailureClosed:persistenceFailureClosed,ownerRequired:true,automaticOwnerVerification:true,idleContextReconciliation:true,singleContextMessage:true,nativeInputCount:users.length,wechatInputCount:1,finalReplyCount:sent.length,duplicateDelivery:false,contextRecorded:true,replyText:sent.map(row=>row.text)}
    Object.assign(snapshot,{mainResetPreservesMemory:true,mainResetPreservesWechat:true,mainResetArchivesSource:true,mainResetStartsEmpty:true,mainNamesPinned:true,archiveNameNumbered:true,emptyMainPresetRecovered:true})
    assert.deepEqual(snapshot,JSON.parse(await readFile(new URL('./wechat-expected.json',import.meta.url),'utf8')))
    await writeFile(path.join(root,'wechat-behavior.json'),JSON.stringify(snapshot,null,2)+'\n')
    return snapshot
  } finally {for(const dispose of disposers)await dispose();await service.dispose();await projection.dispose()}
}
