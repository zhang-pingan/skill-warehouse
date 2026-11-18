import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { PersonalAgentService } from '../lib/service.js'
import { resolveConfig } from '../lib/config.js'
import { MainSession } from '../lib/main-session.js'
import { ExecutionResults } from '../lib/execution-results.js'
import { WechatChannel } from '../lib/wechat-channel.js'
import { wechatProjection } from '../lib/wechat-projection.js'
import { WechatApi, WechatError, parseWechatUpdates, trustedWechatOrigin, splitWechatText } from '../lib/wechat-api.js'

/** Deterministic native admission and log fixture; external protocol tests use a loopback server. */
async function fixture(t, settings = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pac-wechat-'))
  let record = null, flushFailure = false, credentialFailure = false, creates = 0
  const agents = new Map(), logs = new Map(), admitted = new Set(), sent = []
  const append = (id, type, data, surfaceOp) => {
    const session = agents.get(id).session
    const event = { seq: session.seq++, type, data, ...(surfaceOp ? { surfaceOp } : {}) }
    logs.get(id).push(event)
    return event
  }
  const ctx = {
    credentials: { async readRecord() { return record }, async modifyRecord(_key, mutate) { if (credentialFailure) throw new Error('credential disk'); record = await mutate(record); return record }, async deleteRecord() { record = null } },
    agents: { get: id => agents.get(id), turnBoundaryOf: session => ({ lastTurn: logs.get(session.id).some(e => e.type === 'turn/start') ? 1 : 0, openTurnStartSeq: null }) }, workspaceRegistry: { archivedSessionIds: [],
      async archiveSession(id) {
        if (agents.get(id)?.status === 'running') throw new Error('native activity is running')
        if (!this.archivedSessionIds.includes(id)) this.archivedSessionIds.push(id)
      },
      async unarchiveSession(id) { this.archivedSessionIds = this.archivedSessionIds.filter(value => value !== id) },
    },
    workspaceController: { async initializeDefault() { return { workspace: { workspaceId: 'workspace' } } } },
    agentPresets: { presetForSession: session => session.preset ?? 'standard', async select(agent, preset) { agent.session.preset = preset; append(agent.id ?? agent.session.id, 'agent-preset/selected', { agentPreset: preset }) } },
    sessionTitle: {
      get(session) { return logs.get(session.id).findLast(event => event.type === 'session/title')?.data },
      rename(session, title) { const data = { title, source: { kind: 'user' }, messageSeqs: [] }; append(session.id, 'session/title', data); return data },
    },
    sessionPersistence: {
      async stat(id) { return agents.has(id) ? { id, eventCount: logs.get(id).length, revision: logs.get(id).length, header: { id, createdAt: '2026-11-17T00:00:00.000Z' } } : null },
      async flush() { if (flushFailure) { flushFailure = false; throw new Error('flush disk') } },
      async open(id) { return { async read(offset, length) { return {events: logs.get(id).slice(offset, offset + length)} }, async close() {} } },
    },
    sessionController: {
      async create({ sessionId }) {
        creates += 1
        const session = { id: sessionId, seq: 0 }
        const nextStep=[]
        agents.set(sessionId, { session, status: 'idle', inbox: {nextStep,splice(target,start,removedCount,inserted){const removed=nextStep.splice(start,removedCount,...inserted);append(sessionId,'agent/inbox/spliced',{target,start,removedCount,inserted});return removed},remove(id){const index=nextStep.findIndex(message=>message.id===id);if(index<0)return false;nextStep.splice(index,1);append(sessionId,'agent/inbox/spliced',{target:'next-step',start:index,removedCount:1,inserted:[]});return true}},
          inject(message) {const start=nextStep.length;nextStep.push(message);append(sessionId,'agent/inbox/spliced',{target:'next-step',start,removedCount:0,inserted:[message]})} })
        logs.set(sessionId, [])
        return { sessionId }
      },
      async resolveAgent(id) { return agents.has(id) ? {agent: agents.get(id)} : {error: {message: 'missing'}} },
      async prompt(request) {
        if (!admitted.has(request.requestId)) {
          admitted.add(request.requestId)
          append(request.sessionId, 'turn/start', {turn: 1})
          const agent=agents.get(request.sessionId)
          for(const message of [...agent.inbox.nextStep]){agent.inbox.remove(message.id);append(request.sessionId,'user/message',message,'append')}
          append(request.sessionId, 'user/message', {source: {kind: 'user', rpcId: request.requestId}, content: request.content}, 'append')
        }
        return {accepted:true}
      },
      async cancel() {},
    },
  }
  const service = new PersonalAgentService(resolveConfig({ dataDir: root, codexHome: path.join(root,'codex'), wechatLockDir: path.join(root,'locks'), historyRead:false, memoryExtractionEnabled:false, ...settings }), { context:ctx, logger:{warn(){}} })
  await service.initialize()
  const projection = { stateOf: session => logs.get(session.id).reduce(wechatProjection.apply, wechatProjection.init()) }
  service.mainSession = new MainSession(service, projection)
  const api = { async send(_credential, _peer, _token, id, text) { sent.push({id,text}) }, async updates(_credential,_cursor,signal) { return new Promise((_,reject) => { if(signal.aborted)reject(signal.reason); else signal.addEventListener('abort',()=>reject(signal.reason),{once:true}) }) } }
  service.wechat = new WechatChannel(service, projection, {api})
  t.after(async () => { await service.dispose(); rmSync(root,{recursive:true,force:true}) })
  const channel = service.wechat, db = service.database.db
  return { root, service, channel, ctx, db, agents, logs, append, sent, admitted, get creates(){return creates}, set flushFailure(v){flushFailure=v}, set credentialFailure(v){credentialFailure=v}, get record(){return record},
    async bind() {
      const target = await service.mainSession.ensure()
      channel.store.update({account_id:'account',owner_id:'owner',generation:1,session_id:target.sessionId,binding_version:target.version,start_seq:target.agent.session.seq-1,observed_seq:target.agent.session.seq-1})
      await channel.saveCredentials(() => ({accountId:'account',token:'test-secret',baseUrl:'https://ilinkai.weixin.qq.com',peers:{owner:{contextToken:'reply-secret',at:Date.now(),sent:0}}}))
      return target
    },
  }
}
const batch = (ids, cursor='cursor') => ({cursor,messages:ids.map(externalId=>({externalId,peer:'owner',text:`hello ${externalId}`,contextToken:'reply-secret'}))})
const signal = () => new AbortController().signal

 test('desktop and channel acquire exactly one Host-owned main session, and archive never creates a replacement', async t => {
  const f=await fixture(t)
  const results=await Promise.all(Array.from({length:10},()=>f.service.mainSession.ensure()))
  assert.equal(f.creates,1)
  assert.equal(new Set(results.map(r=>r.sessionId)).size,1)
  assert.equal(f.logs.get(results[0].sessionId).length,2)
  f.ctx.workspaceRegistry.archivedSessionIds.push(results[0].sessionId)
  await assert.rejects(f.service.mainSession.ensure(),{code:'MAIN_SESSION_ARCHIVED'})
  assert.equal(f.creates,1)
})

test('historical role markers never become main-session candidates or assistant authority', async t => {
  const f=await fixture(t)
  for (const id of ['a','b']) f.service.ledger.upsertSession({system:'dsh',externalId:id,sourceKind:'personal_assistant'})
  assert.equal(f.service.isAssistantSession('a'),false)
  assert.equal(f.service.isAssistantSession('b'),false)
  const target=await f.service.mainSession.ensure()
  assert.ok(!['a','b'].includes(target.sessionId))
  assert.equal(f.service.isAssistantSession(target.sessionId),true)
  assert.equal((await f.service.mainSession.ensure()).sessionId,target.sessionId)
  assert.equal(f.creates,1)
  assert.equal(Object.hasOwn(f.channel.view(),'candidates'),false)
})

test('oversized pulls retain their cursor and resume accepted identities without duplicate native input', async t => {
  const f=await fixture(t,{wechatQueueCapacity:10});await f.bind()
  await assert.rejects(f.channel.acceptBatch(batch(Array.from({length:11},(_,i)=>String(i)))) ,{code:'QUEUE_FULL'})
  assert.equal(f.channel.store.channel().cursor,'')
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wechat_inbox').get().n,10)
  await f.channel.dispatch(signal())
  await f.channel.acceptBatch(batch(Array.from({length:11},(_,i)=>String(i))))
  assert.equal(f.channel.store.channel().cursor,'cursor')
  const b=batch(['one']);b.messages.push({externalId:'stranger',peer:'other',text:'malicious',contextToken:'no'})
  await f.channel.acceptBatch(b);await f.channel.acceptBatch(b)
  await f.channel.dispatch(signal());await f.channel.dispatch(signal())
  assert.equal(f.admitted.size,12)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wechat_inbox').get().n,12)
  assert.equal(f.record.payload.peers.other,undefined)
})

test('input accepted before a failed flush reuses its native request identity after recovery', async t => {
  const f=await fixture(t);await f.bind();await f.channel.acceptBatch(batch(['one']))
  const prompt=f.ctx.sessionController.prompt
  f.ctx.sessionController.prompt=async request=>{await prompt(request);f.flushFailure=true;f.ctx.sessionController.prompt=prompt}
  await assert.rejects(f.channel.dispatch(signal()),/flush disk/)
  assert.equal(f.db.prepare('SELECT state FROM wechat_inbox').get().state,'dispatching')
  await f.channel.dispatch(signal())
  assert.equal(f.admitted.size,1)
  assert.equal(f.db.prepare('SELECT state FROM wechat_inbox').get().state,'accepted')
})

test('idle main context stays queued once and reconciliation does not require a model turn', async t => {
  const f=await fixture(t);const target=await f.bind()
  const original=target.agent.inbox.nextStep[0]
  for(let i=0;i<1000;i++)target.agent.inject({...original,id:`duplicate-context-${i}`})
  target.agent.inject({id:'other-context',source:{kind:'user'},content:[]})
  const before=f.logs.get(target.sessionId).length
  await f.service.mainSession.ensure()
  await f.channel.reconcile(signal());await f.channel.reconcile(signal())
  assert.equal(f.logs.get(target.sessionId).length,before+1)
  assert.deepEqual(target.agent.inbox.nextStep.map(message=>message.id),[original.id,'other-context'])
  assert.equal(f.service.mainSession.projection.stateOf(target.agent.session).contextLoaded,false)
  assert.equal(f.admitted.size,0)
  target.agent.inbox.remove(original.id);target.agent.status='running'
  await f.service.mainSession.ensure()
  assert.deepEqual(target.agent.inbox.nextStep.map(message=>message.id),['other-context'])
  target.agent.status='idle';await f.service.mainSession.ensure()
  assert.equal(target.agent.inbox.nextStep.length,2)
})

test('idle channel observes persisted replies without restoring the main agent', async t => {
  const f=await fixture(t);const target=await f.bind()
  f.ctx.sessionController.resolveAgent=async()=>{throw new Error('idle agent must remain unloaded')}
  f.append(target.sessionId,'turn/start',{turn:1})
  f.append(target.sessionId,'assistant/message',{turn:1,message:{content:[{type:'text',text:'Persisted desktop reply'}]}},'append')
  f.append(target.sessionId,'turn/end',{turn:1,reason:{kind:'completed'}})
  await f.channel.dispatch(signal());await f.channel.reconcile(signal());await f.channel.sendPending(signal())
  assert.deepEqual(f.sent.map(item=>item.text),['Persisted desktop reply'])
  await f.channel.reconcile(signal());await f.channel.sendPending(signal())
  assert.equal(f.sent.length,1)
  await f.channel.acceptBatch(batch(['new-input']))
  await assert.rejects(f.channel.dispatch(signal()),/idle agent must remain unloaded/)
  f.ctx.workspaceRegistry.archivedSessionIds.push(target.sessionId)
  await assert.rejects(f.channel.reconcile(signal()),{code:'MAIN_SESSION_ARCHIVED'})
  f.ctx.workspaceRegistry.archivedSessionIds.length=0
  f.ctx.sessionPersistence.stat=async()=>null
  await assert.rejects(f.channel.reconcile(signal()),{code:'MAIN_SESSION_MISSING'})
  f.channel.store.update({binding_version:target.version+1})
  await assert.rejects(f.channel.reconcile(signal()),{code:'BINDING_CHANGED'})
})

test('missing scanner identity requires scanning again and never authorizes the first sender', async t => {
  const f=await fixture(t,{wechatEnabled:true});f.channel.store.update({account_id:'account'})
  await f.channel.saveCredentials(()=>({accountId:'account',token:'fixture',peers:{}}));await f.channel.sync()
  await f.channel.acceptBatch(batch(['message']))
  assert.equal(f.channel.view().identityStatus,'scan-required')
  assert.equal(f.channel.view().ownerId,null)
  assert.equal(f.creates,0)
  assert.deepEqual(f.record.payload.peers,{})
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wechat_inbox').get().n,0)
})

test('verification retries a failed main flush with the retained cursor and same main identity', async t => {
  const f=await fixture(t,{wechatEnabled:true});f.channel.store.update({account_id:'account'})
  await f.channel.saveCredentials(()=>({accountId:'account',userId:'owner',token:'fixture',peers:{}}));await f.channel.sync()
  f.flushFailure=true
  await assert.rejects(f.channel.acceptBatch(batch(['retry'])),/flush disk/)
  assert.equal(f.channel.store.channel().cursor,'')
  assert.equal(f.channel.store.channel().owner_id,null)
  const reserved=f.service.mainSession.binding().session_id
  await f.channel.acceptBatch(batch(['retry']))
  assert.equal(f.channel.store.channel().session_id,reserved)
  assert.equal(f.channel.view().identityStatus,'verified')
  assert.equal(f.creates,1)
})

test('a restarted channel restores scanner verification and refuses conflicting stored owners', async t => {
  const f=await fixture(t,{wechatEnabled:true});await f.bind()
  await f.channel.saveCredentials(c=>({...c,userId:'owner'}))
  await f.channel.close()
  const restarted=new WechatChannel(f.service,f.service.mainSession.projection,{api:f.channel.api});f.service.wechat=restarted
  await restarted.sync()
  assert.equal(restarted.view().identityStatus,'verified')
  await restarted.saveCredentials(c=>({...c,userId:'other'}));await restarted.sync()
  assert.equal(restarted.view().status,'error')
  assert.equal(restarted.lifetime,null)
  assert.equal(restarted.store.channel().owner_id,'owner')
})

test('shutdown drains automatic identity verification before releasing the account lock', async t => {
  const f=await fixture(t,{wechatEnabled:true});f.channel.store.update({account_id:'account'})
  await f.channel.saveCredentials(()=>({accountId:'account',userId:'owner',token:'fixture',peers:{}}))
  const entered=Promise.withResolvers(),release=Promise.withResolvers()
  f.ctx.sessionPersistence.flush=async()=>{entered.resolve();await release.promise}
  f.channel.api.updates=async()=>({get_updates_buf:'uncommitted',msgs:[{message_type:1,message_id:'one',from_user_id:'owner',item_list:[{type:1,text_item:{text:'hello'}}]}]})
  await f.channel.sync();await entered.promise
  let stopped=false
  const stopping=f.channel.stop().then(()=>{stopped=true})
  const second=new WechatChannel(f.service,f.service.mainSession.projection,{api:f.channel.api});t.after(()=>second.close())
  await second.sync();assert.equal(second.status,'occupied');assert.equal(stopped,false)
  release.resolve();await stopping
  assert.equal(f.channel.store.channel().owner_id,null)
  assert.equal(f.channel.store.channel().cursor,'')
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wechat_inbox').get().n,0)
  assert.equal(f.channel.releaseLock,null)
})

test('only final committed answer text is segmented, checkpointed and delivered without reasoning or tools', async t => {
  const f=await fixture(t,{wechatMessageChars:100});const target=await f.bind()
  await f.channel.acceptBatch(batch(['one']));await f.channel.dispatch(signal())
  f.append(target.sessionId,'assistant/message',{turn:1,message:{content:[{type:'text',text:'progress'},{type:'tool-call',name:'secret'}]}},'append')
  await f.channel.reconcile(signal());assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wechat_outbox').get().n,0)
  const text='最终答复🌙'.repeat(30)
  f.append(target.sessionId,'assistant/message',{turn:1,message:{content:[{type:'reasoning',text:'private'},{type:'text',text}]}},'append')
  f.append(target.sessionId,'turn/end',{turn:1,reason:{kind:'completed'}})
  await f.channel.reconcile(signal());await f.channel.reconcile(signal());await f.channel.sendPending(signal())
  assert.equal(f.sent.map(s=>s.text).join(''),text)
  assert.equal(f.db.prepare('SELECT state FROM wechat_inbox').get().state,'completed')
  assert.equal(f.sent.some(s=>s.text.includes('private')||s.text.includes('progress')),false)
  assert.equal(new Set(f.sent.map(s=>s.id)).size,f.sent.length)
})

test('send result is never changed to failed by a later credential write and unknown sends require confirmation', async t => {
  const f=await fixture(t);await f.bind();f.channel.store.enqueue('one','reply')
  f.credentialFailure=true
  await assert.rejects(f.channel.sendPending(signal()),/credential disk/)
  assert.equal(f.sent.length,0)
  assert.equal(f.db.prepare('SELECT state FROM wechat_outbox').get().state,'pending')
  f.credentialFailure=false
  await f.channel.sendPending(signal());assert.equal(f.sent.length,1)
  f.channel.store.enqueue('two','uncertain')
  f.channel.api.send=async()=>{throw new WechatError('SEND_UNKNOWN','unknown',{effect:'unknown'})}
  await f.channel.sendPending(signal());await f.channel.sendPending(signal())
  const row=f.db.prepare("SELECT * FROM wechat_outbox WHERE state='unknown'").get()
  assert.ok(row)
  await assert.rejects(f.channel.manage({action:'retry-send',id:row.id}),/本地确认/)
  assert.equal(f.db.prepare("SELECT state FROM wechat_outbox WHERE text='reply'").get().state,'accepted')
})

test('context budget pauses in sequence and a fresh interaction resumes remaining segments', async t => {
  const f=await fixture(t,{wechatSendBudget:1});await f.bind()
  f.channel.store.enqueue('one','first');f.channel.store.enqueue('two','second')
  await f.channel.sendPending(signal());assert.equal(f.sent.length,1)
  assert.equal(f.db.prepare("SELECT state FROM wechat_outbox WHERE text='second'").get().state,'waiting')
  await f.channel.acceptBatch(batch(['fresh']))
  await f.channel.command({id:'control',text:'/wx-pending',generation:1},await f.service.mainSession.ensure())
  await f.channel.sendPending(signal());assert.equal(f.sent[1].text,'second')
})

test('WeChat rejects main-session selection without changing the shared conversation or queues', async t => {
  const f=await fixture(t);const target=await f.bind();await f.channel.acceptBatch(batch(['old']))
  f.channel.store.enqueue('old','private answer')
  const prior=f.channel.store.channel()
  await assert.rejects(f.channel.manage({action:'bind-session',sessionId:'second'}), /不支持的微信操作/)
  assert.equal(f.channel.store.channel().session_id,target.sessionId)
  assert.equal(f.channel.store.channel().generation,prior.generation)
  assert.equal(f.db.prepare('SELECT state FROM wechat_inbox').get().state,'pending')
  assert.equal(f.db.prepare('SELECT state FROM wechat_outbox').get().state,'pending')
})

test('restored backup holds sending until local confirmation and never replays the restored backlog', async t => {
  const f=await fixture(t);await f.bind();f.channel.store.enqueue('old','old reply')
  const source=path.join(f.root,'backup.sqlite'),target=path.join(f.root,'restored.sqlite')
  f.service.database.backup(source);f.service.database.restoreToNewPath(source,target)
  const {DatabaseSync}=await import('node:sqlite');const restored=new DatabaseSync(target)
  try{assert.equal(restored.prepare('SELECT restore_hold FROM wechat_channel').get().restore_hold,1)}finally{restored.close()}
  assert.equal(f.service.database.validateBackup(target).ok,true)
  f.channel.store.update({restore_hold:1});await f.channel.manage({action:'resume-restored',confirmed:true})
  assert.equal(f.channel.store.channel().restore_hold,0)
  assert.equal(f.db.prepare('SELECT state FROM wechat_outbox').get().state,'cancelled')
  assert.equal(f.sent.length,0)
})

test('native approval is disabled by default; enabled answers are owner-bound one-time decisions', async t => {
  const f=await fixture(t,{wechatEnabled:true});const target=await f.bind()
  f.channel.lifetime=new AbortController()
  let desktop=0
  assert.equal(await f.channel.interactions.approval({agent:target.agent,toolName:'shell'},async()=>{desktop++;return 'rejected'}),'rejected')
  assert.equal(desktop,1);assert.equal(f.channel.interactions.view().length,0)
  f.service.config={...f.service.config,wechatRemoteApprovalEnabled:true}
  const controller=new AbortController()
  const result=f.channel.interactions.approval({agent:target.agent,toolName:'shell',signal:controller.signal},async()=> new Promise(resolve=> {
    const req=[...f.channel.interactions.pending.values()][0].request
    req.signal.addEventListener('abort',()=>resolve('cancelled'),{once:true})
  }))
  const card=f.channel.interactions.view()[0]
  await f.channel.interactions.answer({id:'bad',peer:'other',text:`/wx-approval ${card.id} allow`})
  assert.equal(f.channel.interactions.view().length,1)
  await f.channel.interactions.answer({id:'good',peer:'owner',text:`/wx-approval ${card.id} allow`})
  assert.equal(await result,'allowed-once')
  assert.equal(f.db.prepare('SELECT state FROM wechat_interactions WHERE interaction_id=?').get(card.id).state,'answered')
  f.channel.lifetime.abort()
})

test('desktop answer invalidates the remote number and permission-bearing question intents stay local', async t => {
  const f=await fixture(t,{wechatEnabled:true});const target=await f.bind();f.channel.lifetime=new AbortController()
  const question={agent:target.agent,questions:[{id:'q',question:'Pick',options:[{label:'One'},{label:'Two'}]}]}
  const done=Promise.withResolvers()
  const result=f.channel.interactions.question(question,()=>done.promise)
  const card=f.channel.interactions.view()[0];done.resolve({answers:[{id:'q',selected:['Two']}]})
  assert.equal((await result).answers[0].selected[0],'Two')
  await f.channel.interactions.answer({id:'late',peer:'owner',text:`/wx-answer ${card.id} 1:A`})
  assert.equal(f.channel.interactions.view().length,0)
  assert.equal(await f.channel.interactions.question({...question,questions:[{...question.questions[0],intent:{kind:'approval'}}]},()=> 'desktop only'),'desktop only')
  f.channel.lifetime.abort()
})

test('account lock denies a second consumer and close releases all ownership', async t => {
  const f=await fixture(t,{wechatEnabled:true});await f.bind();await f.channel.sync()
  const second=new WechatChannel(f.service,f.service.mainSession.projection,{api:f.channel.api})
  t.after(()=>second.close())
  await second.sync();assert.equal(second.status,'occupied')
  await f.channel.close();await second.sync();assert.notEqual(second.status,'occupied')
  await second.close();assert.equal(second.lifetime,null)
})

test('iLink transport validates origins, text and IDs and never retries an uncertain POST', async t => {
  let sends=0
  const server=createServer((req,res)=>{req.resume();req.on('end',()=>{ if(req.url.includes('sendmessage')){sends++;res.end('{"ret":0}')}else res.end('{"get_updates_buf":"next","msgs":[]}') })})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise(resolve=>server.close(resolve)))
  const config=resolveConfig({dataDir:os.tmpdir(),historyRead:false})
  const baseUrl=`http://127.0.0.1:${server.address().port}`
  const api=new WechatApi(config,{baseUrl})
  await api.send({baseUrl,token:'fixture'},'peer','ctx','stable','hello',signal())
  assert.equal(sends,1)
  assert.deepEqual(parseWechatUpdates(await api.updates({baseUrl,token:'fixture'},'',signal())),{cursor:'next',messages:[]})
  assert.throws(()=>trustedWechatOrigin('https://evil.example/','https://ilinkai.weixin.qq.com'),{code:'INVALID_ORIGIN'})
  assert.throws(()=>parseWechatUpdates({get_updates_buf:'next',msgs:[{message_type:1,from_user_id:'a',message_id:undefined,item_list:[]}]}),{code:'MESSAGE_ID'})
  assert.equal(parseWechatUpdates({get_updates_buf:'next',msgs:[{message_type:2}]}).messages.length,0)
  assert.equal(splitWechatText('🌙你好🌙',2).join(''),'🌙你好🌙')
})

test('QR identity automatically binds only its matching sender without exposing credentials', async t => {
  const f=await fixture(t,{wechatEnabled:true})
  f.channel.api.qr=async()=>({qrcode:'code',qrcode_img_content:'https://weixin.qq.com/fixture'})
  f.channel.api.qrStatus=async()=>({status:'confirmed',bot_token:'private-bot-token',ilink_bot_id:'account',ilink_user_id:'owner',baseurl:'https://ilinkai.weixin.qq.com'})
  await f.channel.manage({action:'login'});await f.channel.loginWork;await f.channel.management
  assert.equal(f.channel.view().identityStatus,'waiting-message')
  const stranger=batch(['first']);stranger.messages[0].peer='stranger'
  await f.channel.acceptBatch(stranger)
  assert.equal(f.channel.view().identityStatus,'mismatch')
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wechat_inbox').get().n,0)
  assert.deepEqual(f.record.payload.peers,{})
  await assert.rejects(f.channel.manage({action:'bind-owner',peerId:'stranger',confirmed:true}),/不支持的微信操作/)
  await f.channel.acceptBatch(batch(['new']));await f.channel.acceptBatch(batch(['new']))
  assert.equal(f.channel.view().identityStatus,'verified')
  assert.equal(f.channel.view().ownerId,'owner')
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wechat_inbox').get().n,1)
  assert.equal(JSON.stringify(f.channel.view()).includes('private-bot-token'),false)
  assert.equal(JSON.stringify(f.channel.view()).includes('reply-secret'),false)
  await f.channel.sync()
  assert.equal(f.channel.view().identityStatus,'verified')
})

test('numeric iLink message IDs retain all digits through contact discovery and repeated delivery', async t => {
  const f=await fixture(t)
  const ids=['9223372036854775806','9223372036854775807']
  let wireIds=ids
  const server=createServer((req,res)=>{req.resume();req.on('end',()=>res.end(`{"get_updates_buf":"next","msgs":[${wireIds.map(id=>`{"message_type":1,"message_id":${id},"from_user_id":"owner","context_token":"fixture-context","item_list":[{"type":1,"text_item":{"text":"hello"}}]}`).join(',')}]}`))})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise(resolve=>server.close(resolve)))
  const baseUrl=`http://127.0.0.1:${server.address().port}`
  const api=new WechatApi(f.service.config,{baseUrl})
  const read=async()=>parseWechatUpdates(await api.updates({baseUrl,token:'fixture'},'',signal()))
  const received=await read()
  assert.deepEqual(received.messages.map(message=>message.externalId),ids)
  f.channel.store.update({account_id:'account'})
  await f.channel.saveCredentials(()=>({accountId:'account',token:'fixture',baseUrl,peers:{}}))
  await f.channel.acceptBatch(received)
  assert.deepEqual(f.channel.view().contacts.map(contact=>contact.peerId),['owner'])
  assert.equal(f.channel.view().ownerId,null)
  assert.equal(f.admitted.size,0)
  f.service.config={...f.service.config,wechatEnabled:true}
  await f.channel.saveCredentials(c=>({...c,userId:'owner'}));await f.channel.sync()
  await f.channel.acceptBatch(received)
  await f.channel.acceptBatch(await read())
  await f.channel.dispatch(signal())
  assert.equal(f.admitted.size,2)
  assert.deepEqual(f.db.prepare('SELECT external_id FROM wechat_inbox ORDER BY external_id').all().map(row=>row.external_id),ids)
  for (const invalid of ['1.5','9e30']) {
    wireIds=[invalid]
    await assert.rejects(read(),{code:'MESSAGE_ID'})
  }
})

test('Codex decisions use the bound ledger request and reject stale connection epochs', async t => {
  const f=await fixture(t,{wechatRemoteApprovalEnabled:true});const target=await f.bind()
  const {taskId}=f.service.ledger.createTask({objective:'Codex fixture'})
  const session=f.service.ledger.upsertSession({system:'dsh',externalId:target.sessionId})
  f.service.ledger.attachTaskSession(taskId,session.sessionRefId)
  const {executionId}=f.service.ledger.planExecution({taskId,executorKind:'codex',method:'thread/new',params:{},dispatch:false})
  let epoch=1;const responses=[]
  f.service.approvals.adapter={initialized:true,adapterInstanceId:'adapter',connectionEpoch:1,async replyToServerRequest(handle,response){if(handle.connectionEpoch!==epoch)throw new Error('stale epoch');responses.push(response)}}
  const capture = requestId => f.service.approvals.capture({executionId,handle:{adapterInstanceId:'adapter',connectionEpoch:1,externalRequestId:requestId},method:'item/commandExecution/requestApproval',params:{command:'echo fixture',availableDecisions:['accept','decline']}})
  const a=capture(1);await f.channel.interactions.captureCodex(target)
  assert.deepEqual(await f.channel.interactions.captureCodex(target),[])
  let card=f.db.prepare("SELECT * FROM wechat_interactions WHERE state='pending'").get()
  await f.channel.interactions.answer({id:'allow',peer:'owner',text:`/wx-approval ${card.interaction_id} allow`})
  assert.deepEqual(responses,[{decision:'accept'}])
  assert.equal(f.db.prepare('SELECT approval_state FROM approvals WHERE approval_id=?').get(a.approvalId).approval_state,'approved')
  assert.match(f.db.prepare("SELECT text FROM wechat_outbox WHERE kind='interaction' LIMIT 1").get().text,/完整请求范围/)
  f.service.approvals.capture({executionId,handle:{adapterInstanceId:'adapter',connectionEpoch:1,externalRequestId:'oversized'},method:'item/commandExecution/requestApproval',params:{command:'x'.repeat(f.service.config.wechatMessageChars),availableDecisions:['accept','decline']}})
  assert.deepEqual(await f.channel.interactions.captureCodex(target),[])
  capture(2);await f.channel.interactions.captureCodex(target)
  card=f.db.prepare("SELECT * FROM wechat_interactions WHERE state='pending'").get();epoch=2
  await assert.rejects(f.channel.interactions.answer({id:'stale',peer:'owner',text:`/wx-approval ${card.interaction_id} allow`}),/stale epoch/)
  assert.equal(responses.length,1)
  f.service.approvals.adapter.connectionEpoch=2
  assert.deepEqual(await f.channel.interactions.captureCodex(target),[])
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM wechat_interactions WHERE state='pending'").get().n,0)
  f.channel.interactions.withdraw()
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM wechat_interactions WHERE state='pending'").get().n,0)
})

test('questions stay answerable without a desktop, reject ambiguous grammar and preserve borrowed signals', async t => {
  const f=await fixture(t,{wechatEnabled:true});const target=await f.bind()
  f.channel.kick=()=>{};f.channel.lifetime=new AbortController()
  const controller=new AbortController()
  const request=Object.freeze({agent:target.agent,signal:controller.signal,questions:[{id:'one',question:'Pick',options:[{label:'One'},{label:'Two'}]},{id:'two',question:'Pick',multiSelect:true,options:[{label:'A'},{label:'B'}]}]})
  const result=f.channel.interactions.question(request,async()=>{throw Object.assign(new Error('No desktop'),{code:'NO_PROVIDER'})})
  const card=f.channel.interactions.view()[0]
  await Promise.resolve();await Promise.resolve()
  assert.equal(f.channel.interactions.view().length,1)
  for(const text of [ `/wx-approval ${card.id} allow`,...['1:A 1:B 2:A','1:A 2:A,A','1:A 3:A','1:A 2:A extra','1:A,B 2:A','1:A','1:A 2:A -- other'].map(answer=>`/wx-answer ${card.id} ${answer}`)]) {
    await assert.rejects(f.channel.interactions.answer({id:text,peer:'owner',text}),TypeError)
    assert.equal(f.channel.interactions.view().length,1)
  }
  await f.channel.interactions.answer({id:'valid',peer:'owner',text:`/wx-answer ${card.id} 1:A 2:A,B`})
  assert.deepEqual(await result,{answers:[{id:'one',selected:['One']},{id:'two',selected:['A','B']}]})
  assert.equal(request.signal,controller.signal);assert.equal(controller.signal.aborted,false)
  assert.equal(f.db.prepare("SELECT state FROM wechat_outbox WHERE kind='interaction'").get().state,'cancelled')
})

test('approval waits without a desktop; cancellation and native desktop cleanup settle both ends', async t => {
  const f=await fixture(t,{wechatEnabled:true,wechatRemoteApprovalEnabled:true});const target=await f.bind()
  f.channel.kick=()=>{};f.channel.lifetime=new AbortController()
  const request=Object.freeze({agent:target.agent,toolName:'shell'})
  const result=f.channel.interactions.approval(request,async()=> 'unavailable')
  const card=f.channel.interactions.view()[0]
  await Promise.resolve();await Promise.resolve()
  await assert.rejects(f.channel.interactions.answer({id:'wrong',peer:'owner',text:`/wx-answer ${card.id} allow`}),TypeError)
  await f.channel.interactions.answer({id:'allow',peer:'owner',text:`/wx-approval ${card.id} allow`})
  assert.equal(await result,'allowed-once')
  const controller=new AbortController(), started=Promise.withResolvers()
  let cleaned=false
  const cancelled=f.channel.interactions.question({agent:target.agent,signal:controller.signal,questions:[{id:'q',question:'Free text'}]},()=>assert.fail('must delegate with a copied request'),forwarded=> new Promise((_,reject)=>{
    started.resolve();forwarded.signal.addEventListener('abort',()=>{cleaned=true;reject(forwarded.signal.reason)},{once:true})
  }))
  await started.promise;controller.abort()
  await assert.rejects(cancelled,{code:'ASK_ABORTED'});assert.equal(cleaned,true)
})

test('single free-text question is submitted as one answer and pending desktop cards are withdrawn', async t => {
  const f=await fixture(t,{wechatEnabled:true});const target=await f.bind()
  f.channel.kick=()=>{};f.channel.lifetime=new AbortController()
  const result=f.channel.interactions.question({agent:target.agent,questions:[{id:'q',question:'What next?'}]},async()=>{throw Object.assign(new Error('No desktop'),{code:'NO_PROVIDER'})})
  const card=f.channel.interactions.view()[0]
  await f.channel.interactions.answer({id:'free',peer:'owner',text:`/wx-answer ${card.id} -- 请继续 检查原文。`})
  assert.deepEqual(await result,{answers:[{id:'q',selected:[],custom:'请继续 检查原文。'}]})
  const done=Promise.withResolvers()
  const desktop=f.channel.interactions.question({agent:target.agent,questions:[{id:'q2',question:'Continue?'}]},()=>done.promise)
  done.resolve({answers:[{id:'q2',selected:[],custom:'Desktop answer'}]})
  await desktop
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM wechat_outbox WHERE kind='interaction' AND state<>'cancelled'").get().n,0)
})

test('mixed media is acknowledged without submitting a partial user instruction', async t => {
  const f=await fixture(t);await f.bind()
  const parsed=parseWechatUpdates({get_updates_buf:'media',msgs:[{message_type:1,from_user_id:'owner',message_id:'mixed',context_token:'ctx',item_list:[{type:1,text_item:{text:'see this image'}},{type:2,image_item:{}}]}]})
  await f.channel.acceptBatch(parsed);await f.channel.acceptBatch(parsed);await f.channel.dispatch(signal())
  assert.equal(f.admitted.size,0)
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM wechat_inbox WHERE state='command'").get().n,1)
  assert.equal(f.channel.store.channel().cursor,'media')
  assert.match(f.db.prepare('SELECT text FROM wechat_outbox').get().text,/纯文字/)
})

test('only pre-connection send failures retry automatically and the retry budget is finite', async t => {
  const f=await fixture(t,{wechatSendRetryLimit:1});await f.bind()
  let attempts=0
  f.channel.api.send=async()=>{attempts++;throw new WechatError('SEND_NOT_SUBMITTED','connect failed')}
  f.channel.store.enqueue('connect-retry','queued')
  const scheduled=[];f.channel.scheduleSend=at=>scheduled.push(at)
  await f.channel.sendPending(signal())
  let row=f.db.prepare('SELECT * FROM wechat_outbox').get()
  assert.equal(row.state,'pending');assert.equal(row.attempts,1);assert.equal(scheduled.length,1)
  assert.ok(row.next_attempt_at>Date.now())
  f.db.prepare('UPDATE wechat_outbox SET next_attempt_at=0').run()
  await f.channel.sendPending(signal())
  row=f.db.prepare('SELECT * FROM wechat_outbox').get()
  assert.equal(row.state,'failed');assert.equal(attempts,2)
  await f.channel.sendPending(signal());assert.equal(attempts,2)
  const config=f.service.config
  for(const code of ['ECONNREFUSED','ENOTFOUND','UND_ERR_CONNECT_TIMEOUT']) {
    const api=new WechatApi(config,{fetchImpl:async()=>{throw new TypeError('connect',{cause:Object.assign(new Error('not connected'),{code})})}})
    await assert.rejects(api.send({token:'fixture'},'p','c','i','text',signal()),{code:'SEND_NOT_SUBMITTED',effect:'none'})
  }
  for(const code of ['ECONNRESET','UND_ERR_SOCKET','ETIMEDOUT']) {
    const api=new WechatApi(config,{fetchImpl:async()=>{throw new TypeError('network',{cause:Object.assign(new Error('uncertain'),{code})})}})
    await assert.rejects(api.send({token:'fixture'},'p','c','i','text',signal()),{code:'SEND_UNKNOWN',effect:'unknown'})
  }
})

test('unavailable desktop requests expire without retaining interaction cards or borrowed abort listeners', async t => {
  const f=await fixture(t,{wechatEnabled:true,wechatRemoteApprovalEnabled:true,wechatInteractionTtlMs:1000});const target=await f.bind()
  f.channel.kick=()=>{};f.channel.lifetime=new AbortController()
  t.mock.timers.enable({apis:['setTimeout']})
  const controller=new AbortController()
  const result=f.channel.interactions.approval(Object.freeze({agent:target.agent,toolName:'fixture',signal:controller.signal}),async()=> 'unavailable')
  const card=f.channel.interactions.view()[0]
  await Promise.resolve();await Promise.resolve()
  t.mock.timers.tick(1000)
  assert.equal(await result,'cancelled')
  assert.equal(controller.signal.aborted,false)
  assert.equal(f.channel.interactions.view().length,0)
  assert.equal(f.db.prepare('SELECT state FROM wechat_interactions WHERE interaction_id=?').get(card.id).state,'expired')
  assert.equal(f.db.prepare("SELECT state FROM wechat_outbox WHERE kind='interaction'").get().state,'cancelled')
})

test('a withdrawn card cannot be sent after an asynchronous credential reservation', async t => {
  const f=await fixture(t);await f.bind()
  f.channel.store.enqueue('interaction-withdrawn','permission card',{kind:'interaction'})
  const entered=Promise.withResolvers(), release=Promise.withResolvers()
  const modify=f.ctx.credentials.modifyRecord
  f.ctx.credentials.modifyRecord=async(...args)=>{entered.resolve();await release.promise;return modify(...args)}
  const work=f.channel.sendPending(signal())
  await entered.promise
  f.channel.interactions.settle('withdrawn',null,'settled')
  release.resolve();await work
  assert.equal(f.sent.length,0)
  assert.equal(f.record.payload.peers.owner.sent,0)
  assert.equal(f.db.prepare('SELECT state FROM wechat_outbox').get().state,'cancelled')
})

test('a failed main-session flush retries the same reserved identity without duplicating context', async t => {
  const f=await fixture(t)
  let flushes=0
  f.ctx.sessionPersistence.flush=async()=>{ if (++flushes===2) throw new Error('flush disk') }
  await assert.rejects(f.service.mainSession.ensure(),/flush disk/)
  const original=f.service.mainSession.binding()
  assert.equal(original.state,'creating')
  const target=await f.service.mainSession.ensure()
  assert.equal(target.sessionId,original.session_id)
  assert.equal(f.service.mainSession.binding().state,'ready')
  assert.equal(f.creates,1)
  assert.equal(f.logs.get(target.sessionId).filter(event => event.type === 'agent/inbox/spliced').length,1)
  assert.equal(flushes,3)
})

test('scanning a new owner isolates old input and pending output', async t => {
  const f=await fixture(t);await f.bind();await f.channel.acceptBatch(batch(['old-owner']))
  f.channel.store.enqueue('old-owner','private')
  f.channel.api.qr=async()=>({qrcode:'code',qrcode_img_content:'https://weixin.qq.com/fixture'})
  f.channel.api.qrStatus=async()=>({status:'confirmed',bot_token:'new-token',ilink_bot_id:'account',ilink_user_id:'replacement'})
  await f.channel.manage({action:'login'});await f.channel.loginWork;await f.channel.management
  assert.equal(f.db.prepare('SELECT state FROM wechat_inbox').get().state,'held')
  assert.equal(f.db.prepare('SELECT state FROM wechat_outbox').get().state,'cancelled')
})

test('full output queues drain and long answers checkpoint incrementally without duplication', async t => {
  const f=await fixture(t,{wechatQueueCapacity:10,wechatMessageChars:100,wechatSendBudget:10});const target=await f.bind()
  f.append(target.sessionId,'turn/start',{turn:1})
  const text='a'.repeat(1500)
  f.append(target.sessionId,'assistant/message',{turn:1,message:{content:[{type:'text',text}]}},'append')
  const end=f.append(target.sessionId,'turn/end',{turn:1,reason:{kind:'completed'}})
  for(let n=0;n<10;n++)f.channel.store.enqueue(`existing-${n}`,`existing ${n}`)
  f.channel.lifetime=new AbortController()
  await f.channel.kick()
  assert.equal(f.sent.length,10)
  await f.channel.acceptBatch({cursor:'fresh',messages:[{externalId:'more',peer:'owner',text:'/wx-pending',contextToken:'fresh'}]})
  await f.channel.kick()
  await f.channel.acceptBatch({cursor:'fresh2',messages:[{externalId:'more2',peer:'owner',text:'/wx-pending',contextToken:'fresh2'}]})
  await f.channel.kick()
  assert.equal(f.sent.filter(s=>s.text.startsWith('a')).map(s=>s.text).join(''),text)
  assert.equal(new Set(f.sent.map(s=>s.id)).size,f.sent.length)
  assert.equal(f.channel.store.channel().observed_seq,end.seq)
})

test('stop refuses a turn containing desktop input without an rpc id', async t => {
  const f=await fixture(t);const target=await f.bind()
  await f.channel.acceptBatch(batch(['stop-source']));await f.channel.dispatch(signal())
  f.append(target.sessionId,'user/message',{source:{kind:'user'},content:[{type:'text',text:'desktop instruction'}]},'append')
  target.agent.status='running';f.channel.lifetime=new AbortController()
  let cancels=0;f.ctx.sessionController.cancel=()=>{cancels++;return {accepted:true}}
  await f.channel.command({id:'stop',text:'/wx-stop',generation:1},target)
  assert.equal(cancels,0)
})

test('healthy empty polls do not clear a dispatch failure or waiting send status', async t => {
  const f=await fixture(t);await f.bind()
  const controller=new AbortController(), polled=Promise.withResolvers(), next=Promise.withResolvers()
  let calls=0
  f.channel.api.updates=async()=>{if(calls++===0)return {get_updates_buf:'healthy',msgs:[]};polled.resolve();await next.promise;throw controller.signal.reason}
  f.channel.report(new WechatError('CONTEXT_UNAVAILABLE','context unavailable'))
  const receive=f.channel.receiveLoop(f.record.payload,controller.signal)
  await polled.promise
  assert.equal(f.channel.view().status,'error');assert.equal(f.channel.view().error,'context unavailable')
  controller.abort();next.resolve();await receive
  f.channel.errors.clear();f.channel.store.enqueue('waiting-status','reply')
  const row=f.db.prepare('SELECT id FROM wechat_outbox').get();f.channel.store.outbound(row.id,'waiting','needs interaction')
  f.channel.refreshStatus()
  assert.equal(f.channel.view().status,'waiting-interaction')
})

test('channel shutdown cancels in-flight sending before waiting for a queued management operation', async t => {
  const f=await fixture(t);await f.bind();f.channel.lifetime=new AbortController()
  const entered=Promise.withResolvers()
  f.channel.api.send=async(_c,_p,_t,_id,_text,signal)=>new Promise((_,reject)=>{entered.resolve();signal.addEventListener('abort',()=>reject(new WechatError('SEND_UNKNOWN','interrupted',{effect:'unknown'})),{once:true})})
  f.channel.store.enqueue('shutdown','reply')
  const row=f.db.prepare('SELECT id FROM wechat_outbox').get();f.channel.store.outbound(row.id,'failed')
  const managed=f.channel.manage({action:'retry-send',id:row.id})
  await entered.promise
  await f.channel.close();await managed
  assert.equal(f.db.prepare('SELECT state FROM wechat_outbox').get().state,'unknown')
  assert.equal(f.channel.lifetime,null)
})

test('stop drains owned desktop cleanup while delegated local-only questions stay independent', async t => {
  const f=await fixture(t,{wechatEnabled:true});const target=await f.bind()
  f.channel.kick=()=>{};f.channel.lifetime=new AbortController()
  const local=Promise.withResolvers()
  const localResult=f.channel.interactions.question({agent:target.agent,questions:[{id:'local',question:'local',intent:{kind:'approval'}}]},()=>local.promise)
  const started=Promise.withResolvers(), clean=Promise.withResolvers(), aborted=Promise.withResolvers()
  const remote=f.channel.interactions.approval({agent:target.agent},()=>local.promise)
  // Disabled remote approval delegates without becoming channel-owned work.
  assert.equal(f.channel.interactions.operations.size,0)
  const owned=f.channel.interactions.question({agent:target.agent,questions:[{id:'remote',question:'remote'}]},()=>assert.fail('copied request required'),request=>{
    started.resolve()
    request.signal.addEventListener('abort',()=>aborted.resolve(),{once:true})
    return clean.promise
  })
  const cancelled=assert.rejects(owned,{code:'ASK_ABORTED'})
  await started.promise
  let stopped=false
  const stopping=f.channel.stop().then(()=>{stopped=true})
  await aborted.promise;assert.equal(stopped,false)
  clean.resolve({answers:[]});await stopping;await cancelled
  local.resolve({answers:[]});await localResult;await remote
})

test('shutdown removes a native card immediately even while its desktop responder is starting', async t => {
  const f=await fixture(t,{wechatEnabled:true,wechatRemoteApprovalEnabled:true});const target=await f.bind()
  f.channel.kick=()=>{};f.channel.lifetime=new AbortController()
  const result=f.channel.interactions.approval({agent:target.agent,toolName:'fixture'},async()=> 'unavailable')
  const stopping=f.channel.stop()
  assert.equal(await result,'cancelled');await stopping
  assert.equal(f.channel.interactions.operations.size,0)
})

test('unverified senders are bounded and never receive stored reply credentials', async t => {
  const f=await fixture(t);await f.bind();f.channel.store.update({owner_id:null});await f.channel.saveCredentials(c=>({...c,peers:{}}))
  for(let n=0;n<3;n++)await f.channel.acceptBatch({cursor:String(n),messages:Array.from({length:16},(_,i)=>({peer:`peer-${n}-${i}`,externalId:`${n}-${i}`,text:'hello',contextToken:'fixture'}))})
  const contacts=f.channel.view().contacts.map(c=>c.peerId).sort()
  assert.equal(contacts.length,16)
  assert.deepEqual(Object.keys(f.record.payload.peers),[])
})

test('Codex scope and approval command must fit together in one message', async t => {
  const f=await fixture(t,{wechatRemoteApprovalEnabled:true,wechatMessageChars:300});const target=await f.bind()
  const {taskId}=f.service.ledger.createTask({objective:'scope fixture'})
  const session=f.service.ledger.upsertSession({system:'dsh',externalId:target.sessionId});f.service.ledger.attachTaskSession(taskId,session.sessionRefId)
  const {executionId}=f.service.ledger.planExecution({taskId,executorKind:'codex',method:'thread/new',params:{},dispatch:false})
  f.service.approvals.adapter={initialized:true,adapterInstanceId:'adapter',connectionEpoch:1}
  f.service.approvals.capture({executionId,handle:{adapterInstanceId:'adapter',connectionEpoch:1,externalRequestId:1},method:'item/commandExecution/requestApproval',params:{command:'x'.repeat(210),availableDecisions:['accept','decline']}})
  assert.deepEqual(await f.channel.interactions.captureCodex(target),[])
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM wechat_outbox').get().n,0)
})

test('native approvals show exact tool arguments and incomplete or oversized scope stays on desktop', async t => {
  const f=await fixture(t,{wechatEnabled:true,wechatRemoteApprovalEnabled:true});const target=await f.bind()
  f.channel.kick=()=>{};f.channel.lifetime=new AbortController()
  f.append(target.sessionId,'turn/start',{turn:1})
  const args=JSON.stringify({cmd:'echo fixture',cwd:'/fixture'})
  f.append(target.sessionId,'assistant/message',{turn:1,message:{content:[{type:'tool-call',id:'call-1',name:'shell',arguments:args}]}},'append')
  const result=f.channel.interactions.approval({agent:target.agent,toolName:'shell',callId:'call-1'},async()=> 'unavailable')
  const card=f.channel.interactions.view()[0];assert.ok(card.prompt.includes(args))
  await f.channel.interactions.answer({id:'scope-allow',peer:'owner',text:`/wx-approval ${card.id} allow`});assert.equal(await result,'allowed-once')
  assert.equal(await f.channel.interactions.approval({agent:target.agent,toolName:'shell',callId:'missing'},()=> 'desktop only'),'desktop only')
  f.append(target.sessionId,'assistant/message',{turn:1,message:{content:[{type:'tool-call',id:'call-2',name:'shell',arguments:'x'.repeat(1800)}]}},'append')
  assert.equal(await f.channel.interactions.approval({agent:target.agent,toolName:'shell',callId:'call-2'},()=> 'desktop only'),'desktop only')
})

test('Codex cards retain complete scope, support omitted default decisions and cancel after desktop settlement', async t => {
  const f=await fixture(t,{wechatRemoteApprovalEnabled:true});const target=await f.bind()
  const {taskId}=f.service.ledger.createTask({objective:'live approval'})
  const session=f.service.ledger.upsertSession({system:'dsh',externalId:target.sessionId});f.service.ledger.attachTaskSession(taskId,session.sessionRefId)
  const {executionId}=f.service.ledger.planExecution({taskId,executorKind:'codex',method:'thread/new',params:{},dispatch:false})
  const responses=[]
  f.service.approvals.adapter={initialized:true,adapterInstanceId:'adapter',connectionEpoch:1,async replyToServerRequest(_handle,response){responses.push(response)}}
  const params={command:'echo fixture',reason:'scope fixture',additionalPermissions:{network:true}}
  const capture=id=>f.service.approvals.capture({executionId,handle:{adapterInstanceId:'adapter',connectionEpoch:1,externalRequestId:id},method:'item/commandExecution/requestApproval',params})
  capture(1);await f.channel.interactions.captureCodex(target)
  let card=f.db.prepare("SELECT * FROM wechat_interactions WHERE state='pending'").get()
  assert.deepEqual(JSON.parse(card.details_json).scope.request,params)
  await f.channel.interactions.answer({id:'allow-default',peer:'owner',text:`/wx-approval ${card.interaction_id} allow`})
  assert.deepEqual(responses,[{decision:'accept'}])
  const second=capture(2);await f.channel.interactions.captureCodex(target)
  const entered=Promise.withResolvers(), release=Promise.withResolvers(), modify=f.ctx.credentials.modifyRecord
  f.ctx.credentials.modifyRecord=async(...args)=>{entered.resolve();await release.promise;return modify(...args)}
  const sending=f.channel.sendPending(signal());await entered.promise
  await f.service.approvals.decide(second.approvalId,{state:'denied'})
  release.resolve();await sending
  assert.equal(f.sent.some(row=>row.text.includes('Codex 一次性审批')),false)
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM wechat_interactions WHERE state='pending'").get().n,0)
  f.service.approvals.capture({executionId,handle:{adapterInstanceId:'adapter',connectionEpoch:1,externalRequestId:3},method:'item/fileChange/requestApproval',params:{grantRoot:'/fixture'}})
  assert.deepEqual(await f.channel.interactions.captureCodex(target),[])
})

test('iLink accepts successful JSON responses with omitted zero status fields', async t => {
  const f=await fixture(t)
  for(const raw of ['{}','{"message_id":9223372036854775807}','{"ret":0}','{"errcode":0}']) {
    let calls=0
    const api=new WechatApi(f.service.config,{fetchImpl:async()=>{calls++;return new Response(raw)}})
    const result=await api.send({token:'fixture'},'peer','context','id','text',signal())
    assert.equal(calls,1)
    if(raw.includes('message_id'))assert.equal(result.message_id,'9223372036854775807')
  }
})

test('malformed acknowledgements stay unknown and only the documented limit response waits for interaction', async t => {
  const f=await fixture(t)
  for(const raw of ['', 'not json', 'null', '[]']) {
    const api=new WechatApi(f.service.config,{fetchImpl:async()=>new Response(raw)})
    await assert.rejects(api.send({token:'fixture'},'peer','context','id','text',signal()),{code:'SEND_UNKNOWN',effect:'unknown'})
  }
  for(const [body,code] of [[{ret:0,errcode:'invalid'},'SEND_UNKNOWN'],[{ret:-2,errmsg:'invalid body'},'REJECTED'],[{ret:-2,errmsg:'prepare failed'},'WAIT_INTERACTION']]) {
    const api=new WechatApi(f.service.config,{fetchImpl:async()=>new Response(JSON.stringify(body))})
    await assert.rejects(api.send({token:'fixture'},'peer','context','id','text',signal()),{code})
  }
  assert.throws(()=>trustedWechatOrigin('https://other.ilinkai.weixin.qq.com:8443','https://ilinkai.weixin.qq.com'),{code:'INVALID_ORIGIN'})
})

test('binding during a running turn observes its completion without replaying earlier final replies', async t => {
  const f=await fixture(t);const target=await f.bind()
  f.append(target.sessionId,'turn/start',{turn:1})
  f.append(target.sessionId,'assistant/message',{turn:1,message:{content:[{type:'text',text:'already finished'}]}},'append')
  f.append(target.sessionId,'turn/end',{turn:1,reason:{kind:'completed'}})
  f.append(target.sessionId,'turn/start',{turn:2})
  f.channel.store.update({owner_id:null});await f.channel.saveCredentials(c=>({...c,userId:'owner'}))
  f.service.config={...f.service.config,wechatEnabled:true};f.channel.kick=()=>{};await f.channel.sync()
  await f.channel.acceptBatch(batch(['bind-during-turn']))
  f.append(target.sessionId,'assistant/message',{turn:2,message:{content:[{type:'text',text:'new completion'}]}},'append')
  f.append(target.sessionId,'turn/end',{turn:2,reason:{kind:'completed'}})
  await f.channel.reconcile(signal());await f.channel.sendPending(signal())
  assert.deepEqual(f.sent.map(row=>row.text),['new completion'])
  assert.equal(wechatProjection.stateSchema.safeParse(JSON.parse(f.channel.store.channel().delivery_state_json)).success,true)
})

test('projection checkpoint suffix retains unidentified inputs and exact active tool scope', () => {
  const events=[
    {seq:0,type:'turn/start',data:{turn:1}},
    {seq:1,type:'user/message',surfaceOp:'append',data:{source:{kind:'user'},content:[]}},
    {seq:2,type:'assistant/message',surfaceOp:'append',data:{turn:1,message:{content:[{type:'tool-call',id:'call',name:'shell',arguments:'{"cmd":"echo fixture"}'}]}}},
    {seq:3,type:'turn/end',data:{turn:1,reason:{kind:'cancelled'}}},
  ]
  let state=wechatProjection.init()
  for(let n=0;n<events.length;n++) {
    state=wechatProjection.apply(state,events[n])
    const restored=wechatProjection.stateSchema.parse(JSON.parse(JSON.stringify(state)))
    assert.deepEqual(events.slice(n+1).reduce(wechatProjection.apply,restored),events.reduce(wechatProjection.apply,wechatProjection.init()))
  }
})

test('partially queued replies keep their segmentation after settings changes, pruning and restart', async t => {
  const f=await fixture(t,{wechatQueueCapacity:10,wechatMessageChars:100,wechatSendBudget:10});const target=await f.bind()
  const text='ab🌙'.repeat(500)
  f.append(target.sessionId,'turn/start',{turn:1})
  f.append(target.sessionId,'assistant/message',{turn:1,message:{content:[{type:'text',text}]}},'append')
  f.append(target.sessionId,'turn/end',{turn:1,reason:{kind:'completed'}})
  await assert.rejects(f.channel.reconcile(signal()),{code:'QUEUE_FULL'})
  await f.channel.sendPending(signal());assert.equal(f.sent.length,10)
  f.db.prepare("UPDATE wechat_outbox SET updated_at='2000-01-01T00:00:00.000Z' WHERE state='accepted'").run();f.channel.store.prune()
  await f.channel.close()
  f.service.config={...f.service.config,wechatMessageChars:200}
  const restarted=new WechatChannel(f.service,f.service.mainSession.projection,{api:f.channel.api});f.service.wechat=restarted
  await restarted.acceptBatch(batch(['new-budget']))
  await restarted.reconcile(signal());await restarted.sendPending(signal())
  assert.equal(f.sent.map(row=>row.text).join(''),text)
  assert.equal(f.sent.length,15)
})

test('stop control waits for a durable receipt and cannot cancel twice after a failed attempt', async t => {
  const f=await fixture(t,{wechatQueueCapacity:10});const target=await f.bind()
  await f.channel.acceptBatch(batch(['source']));await f.channel.dispatch(signal());target.agent.status='running'
  const control=batch(['stop']);control.messages[0].text='/wx-stop';await f.channel.acceptBatch(control)
  for(let i=0;i<10;i++)f.channel.store.enqueue(`block-${i}`,'queued')
  let cancelled=0;f.ctx.sessionController.cancel=()=>{cancelled++;throw new Error('cancel outcome unknown')}
  await assert.rejects(f.channel.dispatch(signal()),{code:'QUEUE_FULL'})
  assert.equal(cancelled,0)
  f.db.prepare("UPDATE wechat_outbox SET state='cancelled'").run()
  await assert.rejects(f.channel.dispatch(signal()),/cancel outcome unknown/)
  await f.channel.dispatch(signal())
  assert.equal(cancelled,1)
  assert.equal(f.db.prepare("SELECT state FROM wechat_inbox WHERE external_id='stop'").get().state,'command')
})

test('a second channel cannot recover or withdraw the live account before acquiring its lock', async t => {
  const f=await fixture(t,{wechatEnabled:true,wechatRemoteApprovalEnabled:true});const target=await f.bind()
  f.channel.kick=()=>{};await f.channel.sync()
  const result=f.channel.interactions.approval({agent:target.agent,toolName:'fixture'},async()=> 'unavailable')
  const card=f.channel.interactions.view()[0]
  f.channel.store.enqueue('inflight','sending')
  const row=f.db.prepare("SELECT id FROM wechat_outbox WHERE text='sending'").get();f.channel.store.outbound(row.id,'sending')
  const second=new WechatChannel(f.service,f.service.mainSession.projection,{api:f.channel.api})
  t.after(()=>second.close())
  assert.equal(f.db.prepare('SELECT state FROM wechat_outbox WHERE id=?').get(row.id).state,'sending')
  await second.sync();assert.equal(second.status,'occupied')
  await second.close()
  assert.equal(f.db.prepare('SELECT state FROM wechat_interactions WHERE interaction_id=?').get(card.id).state,'pending')
  await f.channel.close();assert.equal(await result,'cancelled')
})

test('a failed interaction settlement write cannot grant native approval', async t => {
  const f=await fixture(t,{wechatEnabled:true,wechatRemoteApprovalEnabled:true});const target=await f.bind()
  f.channel.kick=()=>{};f.channel.lifetime=new AbortController()
  const result=f.channel.interactions.approval({agent:target.agent,toolName:'fixture'},async()=> 'unavailable').then(value=>({value}),error=>({error}))
  const card=f.channel.interactions.view()[0], transaction=f.service.database.transaction.bind(f.service.database)
  let failed=false
  f.service.database.transaction=fn=>{if(!failed){failed=true;throw new Error('settlement disk')}return transaction(fn)}
  await assert.rejects(f.channel.interactions.answer({id:'fault',peer:'owner',text:`/wx-approval ${card.id} allow`}),/settlement disk/)
  assert.match((await result).error?.message ?? '',/settlement disk/)
  assert.equal(f.channel.interactions.pending.size,0)
})

test('account contention also rejects local unlink and queue mutation', async t => {
  const f=await fixture(t,{wechatEnabled:true});await f.bind()
  f.channel.kick=()=>{};await f.channel.sync();f.channel.store.enqueue('kept','reply')
  const row=f.db.prepare('SELECT id FROM wechat_outbox').get()
  const second=new WechatChannel(f.service,f.service.mainSession.projection,{api:f.channel.api});t.after(()=>second.close())
  await assert.rejects(second.manage({action:'unlink',confirmed:true}),{code:'ELOCKED'})
  await assert.rejects(second.manage({action:'discard-send',id:row.id}),{code:'ELOCKED'})
  assert.equal(f.channel.store.channel().owner_id,'owner')
  assert.equal(f.record.payload.accountId,'account')
  assert.equal(f.db.prepare('SELECT state FROM wechat_outbox').get().state,'pending')
})

test('completed or failed QR attempts release inactive account ownership', async t => {
  const f=await fixture(t);await f.bind()
  f.channel.api.qr=async()=>({qrcode:'code',qrcode_img_content:'https://weixin.qq.com/fixture'})
  f.channel.api.qrStatus=async()=>({status:'confirmed',bot_token:'private-token',ilink_bot_id:'account',baseurl:'https://ilinkai.weixin.qq.com'})
  await f.channel.manage({action:'login'});await f.channel.loginWork;await f.channel.management
  assert.equal(f.channel.loginLifetime,null)
  assert.equal(f.channel.releaseLock,null)
  f.channel.api.qr=async()=>{throw new WechatError('NETWORK','QR unavailable')}
  await assert.rejects(f.channel.manage({action:'login'}),/QR unavailable/)
  assert.equal(f.channel.loginLifetime,null)
  assert.equal(f.channel.releaseLock,null)
})

test('known unsubmitted sends preserve the interaction budget for their retry', async t => {
  const f=await fixture(t,{wechatSendBudget:1,wechatSendRetryLimit:1});await f.bind()
  let attempts=0
  f.channel.api.send=async(_c,_p,_t,id,text)=>{if(attempts++===0)throw new WechatError('SEND_NOT_SUBMITTED','connection refused');f.sent.push({id,text})}
  f.channel.store.enqueue('retry-budget','reply')
  await f.channel.sendPending(signal());f.db.prepare('UPDATE wechat_outbox SET next_attempt_at=0').run()
  await f.channel.sendPending(signal())
  assert.equal(f.sent.length,1)
  assert.equal(f.record.payload.peers.owner.sent,1)
})

test('automatic verification keeps account ownership until its durable writes finish', async t => {
  const f=await fixture(t,{wechatEnabled:true});await f.bind();f.channel.kick=()=>{};await f.channel.sync()
  f.channel.store.update({owner_id:null});await f.channel.saveCredentials(c=>({...c,userId:'replacement'}));await f.channel.sync()
  const entered=Promise.withResolvers(), release=Promise.withResolvers()
  f.ctx.sessionPersistence.flush=async()=>{entered.resolve();await release.promise}
  const incoming=batch(['verify']);incoming.messages[0].peer='replacement'
  const changing=f.channel.acceptBatch(incoming)
  await entered.promise
  const second=new WechatChannel(f.service,f.service.mainSession.projection,{api:f.channel.api});t.after(()=>second.close())
  try {await assert.rejects(second.manage({action:'unlink',confirmed:true}),{code:'ELOCKED'})}
  finally {release.resolve();await changing}
  assert.equal(f.channel.store.channel().session_id,f.service.mainSession.binding().session_id)
  assert.equal(f.channel.store.channel().owner_id,'replacement')
  assert.equal(f.record.payload.accountId,'account')
})

test('clearing the main conversation syncs only messages, preserves memory and login, and switches both identities atomically', async t => {
  const f = await fixture(t), old = await f.bind()
  f.channel.store.update({ cursor: 'preserved-receive-cursor' })
  f.db.prepare("INSERT INTO memory_records(memory_id,memory_kind,content,memory_state,confidence,recorded_at,created_by) VALUES('kept','fact','Keep this memory','confirmed',1,'2026-11-17','user')").run()
  const memory = f.db.prepare('SELECT * FROM memory_records').all()
  const preferences = f.service.runtimeSettingsView().settings
  f.append(old.sessionId, 'turn/start', { turn: 1 })
  f.append(old.sessionId, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep my message' }] }, 'append')
  f.append(old.sessionId, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'Keep my answer' }] } }, 'append')
  f.append(old.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  for (let i = 0; i < 20; i++) old.agent.inject({ ...old.agent.inbox.nextStep[0], id: `old-duplicate-${i}` })
  await f.channel.acceptBatch(batch(['pending-reset'], 'preserved-receive-cursor'))
  f.channel.store.enqueue('old-reply', 'Old reply')
  f.channel.store.enqueue('uncertain', 'Uncertain reply')
  f.db.prepare("UPDATE wechat_outbox SET state='sending' WHERE text='Uncertain reply'").run()
  const credentials = structuredClone(f.record), reset = f.service.mainSession.reset
  assert.throws(() => reset.start({ expectedSessionId: old.sessionId }), /确认/)
  reset.start({ confirmed: true, expectedSessionId: old.sessionId })
  const operation = reset.operation
  assert.equal(reset.start({ confirmed: true, expectedSessionId: old.sessionId }).running, true)
  assert.equal(reset.operation, operation)
  await assert.rejects(f.service.mainSession.ensure(), { code: 'MAIN_SESSION_RESETTING' })
  assert.throws(() => f.service.initializeMemory({ confirmed: true }), { code: 'MAIN_SESSION_RESETTING' })
  await operation
  assert.equal(reset.view().state, 'succeeded', JSON.stringify(reset.view()))
  const current = await f.service.mainSession.ensure(), channel = f.channel.store.channel()
  assert.notEqual(current.sessionId, old.sessionId)
  assert.equal(current.version, old.version + 1)
  assert.equal(channel.session_id, current.sessionId)
  assert.equal(channel.binding_version, current.version)
  assert.equal(channel.cursor, 'preserved-receive-cursor')
  assert.equal(channel.owner_id, 'owner')
  assert.deepEqual(f.record, credentials)
  assert.deepEqual(f.db.prepare('SELECT * FROM memory_records').all(), memory)
  assert.deepEqual(f.service.runtimeSettingsView().settings, preferences)
  assert.deepEqual(f.db.prepare('SELECT staged_text FROM history_messages ORDER BY source_order').all().map(r => r.staged_text), ['Keep my message', 'Keep my answer'])
  assert.deepEqual(f.ctx.workspaceRegistry.archivedSessionIds, [old.sessionId])
  assert.equal(f.db.prepare('SELECT state FROM wechat_inbox').get().state, 'held')
  assert.equal(f.db.prepare("SELECT state FROM wechat_outbox WHERE text='Old reply'").get().state, 'cancelled')
  assert.equal(f.db.prepare("SELECT state FROM wechat_outbox WHERE text='Uncertain reply'").get().state, 'unknown')
  assert.equal(channel.observed_seq, current.agent.session.seq - 1)
  assert.equal(current.agent.inbox.nextStep.length, 1)
  assert.equal(f.logs.get(current.sessionId).filter(e => e.type === 'user/message').length, 0)
  assert.equal(reset.start({ confirmed: true, expectedSessionId: old.sessionId }).state, 'succeeded')
  assert.equal(f.creates, 2)
  assert.equal(f.sent.length, 0)
})

test('active conversations, pending login and stale page targets cannot start a reset', async t => {
  const f = await fixture(t), old = await f.bind(), reset = f.service.mainSession.reset
  old.agent.status = 'running'
  assert.throws(() => reset.start({ confirmed: true, expectedSessionId: old.sessionId }), { code: 'MAIN_SESSION_BUSY' })
  old.agent.status = 'idle'; f.channel.loginLifetime = new AbortController()
  assert.throws(() => reset.start({ confirmed: true, expectedSessionId: old.sessionId }), { code: 'WECHAT_LOGIN_BUSY' })
  f.channel.loginLifetime = null
  assert.throws(() => reset.start({ confirmed: true, expectedSessionId: 'stale' }), { code: 'MAIN_SESSION_CHANGED' })
  assert.equal(f.creates, 1)
  assert.deepEqual(f.ctx.workspaceRegistry.archivedSessionIds, [])
})

test('failed history sync restores the old target and a retry reuses its reserved successor', async t => {
  const f = await fixture(t), old = await f.bind(), reset = f.service.mainSession.reset
  const read = f.ctx.sessionPersistence.open
  f.ctx.sessionPersistence.open = async () => { throw new Error('fixture read failed') }
  const before = f.channel.store.channel()
  reset.start({ confirmed: true, expectedSessionId: old.sessionId }); await reset.operation
  assert.equal(reset.view().state, 'failed')
  assert.equal(f.ctx.sessionTitle.get(old.agent.session).title, '鲸鱼娘')
  assert.equal(reset.view().archiveNumber, 1)
  assert.match(reset.view().lastError, /fixture read failed/)
  assert.equal(f.service.mainSession.binding().session_id, old.sessionId)
  assert.deepEqual(f.channel.store.channel(), before)
  assert.deepEqual(f.ctx.workspaceRegistry.archivedSessionIds, [])
  assert.equal((await f.service.mainSession.ensure()).sessionId, old.sessionId)
  const successor = reset.view().newSessionId
  f.ctx.sessionPersistence.open = read
  reset.start({ confirmed: true, expectedSessionId: old.sessionId }); await reset.operation
  assert.equal(reset.view().state, 'succeeded')
  assert.equal(f.service.mainSession.binding().session_id, successor)
  assert.equal(f.ctx.sessionTitle.get(old.agent.session).title, '鲸鱼娘-废弃会话-1')
})

test('successor durability failure leaves the old binding intact and retries without another successor', async t => {
  const f = await fixture(t), old = await f.bind(), reset = f.service.mainSession.reset
  const create = f.ctx.sessionController.create
  f.ctx.sessionController.create = async request => { const result = await create(request); f.flushFailure = true; return result }
  reset.start({ confirmed: true, expectedSessionId: old.sessionId }); await reset.operation
  assert.equal(reset.view().state, 'failed')
  assert.equal(f.service.mainSession.binding().session_id, old.sessionId)
  assert.deepEqual(f.ctx.workspaceRegistry.archivedSessionIds, [])
  const successor = reset.view().newSessionId
  reset.start({ confirmed: true, expectedSessionId: old.sessionId }); await reset.operation
  assert.equal(reset.view().state, 'succeeded')
  assert.equal(f.service.mainSession.binding().session_id, successor)
  assert.equal(f.creates, 2)
})

test('reset joins history synchronization and shutdown keeps the ledger open until rollback settles', async t => {
  const f = await fixture(t), old = await f.bind(), reset = f.service.mainSession.reset
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const read = f.ctx.sessionPersistence.open
  f.ctx.sessionPersistence.open = async id => { entered.resolve(); await release.promise; return read(id) }
  reset.start({ confirmed: true, expectedSessionId: old.sessionId })
  await entered.promise
  let closed = false
  const closing = f.service.dispose().then(() => { closed = true })
  await Promise.resolve()
  assert.equal(closed, false)
  assert.equal(f.service.mainSession.binding().session_id, old.sessionId)
  release.resolve()
  await closing
  assert.deepEqual(f.ctx.workspaceRegistry.archivedSessionIds, [])
  assert.equal(f.creates, 1)
})

test('interrupted replacement retains its reserved successor and can complete after restoring the reset owner', async t => {
  const f = await fixture(t), old = await f.bind()
  f.service.backgroundJobs.save({ name: 'main-session-reset', state: 'running', running: false, phase: 'creating',
    oldSessionId: old.sessionId, oldVersion: old.version, newSessionId: 'reserved-successor', newVersion: old.version + 1,
    archiveOwned: true, committed: false, lastError: 'Host stopped' })
  await f.ctx.workspaceRegistry.archiveSession(old.sessionId)
  await f.ctx.sessionController.create({ sessionId: 'reserved-successor' })
  const reset = f.service.mainSession.reset
  reset.start({ confirmed: true, expectedSessionId: old.sessionId }); await reset.operation
  assert.equal(reset.view().state, 'succeeded')
  assert.equal((await f.service.mainSession.ensure()).sessionId, 'reserved-successor')
  assert.equal(f.creates, 2)
})


test('main titles are pinned once, archives count across owner restoration and naming changes', async t => {
  const f = await fixture(t), main = f.service.mainSession
  const first = await main.ensure()
  assert.equal(f.ctx.sessionTitle.get(first.agent.session).title, '鲸鱼娘')
  await main.ensure(); await main.ensure()
  assert.equal(f.logs.get(first.sessionId).filter(event => event.type === 'session/title').length, 1)
  main.reset.start({ confirmed: true, expectedSessionId: first.sessionId })
  assert.throws(() => f.service.updateRuntimeSettings({ mainSessionTitle: '另一个名字' }), { code: 'MAIN_SESSION_RESETTING' })
  await main.reset.operation
  assert.equal(f.ctx.sessionTitle.get(first.agent.session).title, '鲸鱼娘-废弃会话-1')
  const second = await main.ensure()
  f.service.mainSession = new MainSession(f.service, main.projection)
  const restored = f.service.mainSession
  restored.reset.start({ confirmed: true, expectedSessionId: second.sessionId }); await restored.reset.operation
  assert.equal(f.ctx.sessionTitle.get(second.agent.session).title, '鲸鱼娘-废弃会话-2')
  f.service.updateRuntimeSettings({ mainSessionTitle: '  小鲸鱼  ' })
  const third = await restored.ensure()
  assert.equal(f.ctx.sessionTitle.get(third.agent.session).title, '小鲸鱼')
  restored.reset.start({ confirmed: true, expectedSessionId: third.sessionId }); await restored.reset.operation
  assert.equal(f.ctx.sessionTitle.get(third.agent.session).title, '小鲸鱼-废弃会话-3')
  assert.equal(f.ctx.sessionTitle.get((await restored.ensure()).agent.session).title, '小鲸鱼')
  for (const title of ['', '鲸'.repeat(17), 'bad\u001bname']) assert.throws(() => f.service.updateRuntimeSettings({ mainSessionTitle: title }), TypeError)
})


test('an untouched main conversation restores its standard preset after native blank-view selection', async t => {
  const f = await fixture(t), main = f.service.mainSession, target = await main.ensure()
  target.agent.session.preset = 'cordis'
  assert.equal((await main.ensure()).sessionId, target.sessionId)
  assert.equal(target.agent.session.preset, 'standard')
  assert.equal(target.agent.inbox.nextStep.length, 1)
  const events = f.logs.get(target.sessionId).length
  await main.ensure(); assert.equal(f.logs.get(target.sessionId).length, events)
  f.append(target.sessionId, 'turn/start', { turn: 1 })
  target.agent.session.preset = 'cordis'
  await assert.rejects(main.ensure(), { code: 'MAIN_SESSION_PRESET' })
})


test('main reset waits for an admitted worker result to persist before archiving',async t=>{
  const f=await fixture(t),old=await f.bind()
  old.agent.inbox.nextTurn=[]
  const entered=Promise.withResolvers(),release=Promise.withResolvers(),events=[]
  const prompt=f.ctx.sessionController.prompt
  f.ctx.sessionController.prompt=async request=>{
    entered.resolve();await release.promise
    const result=await prompt(request);events.push('prompt');return result
  }
  f.service.results=new ExecutionResults(f.service,{stateOf:()=>({})})
  const task=f.service.ledger.createTask({objective:'Deliver result before reset',acceptance:['Verify']})
  const run=f.service.ledger.planExecution({taskId:task.taskId,executorKind:'dsh_subagent',method:'session/prompt',params:{},dispatch:false,mutatesWorkspace:false})
  f.service.results.record(run.executionId,{executionId:run.executionId,acceptanceRequired:true})
  const archive=f.ctx.workspaceRegistry.archiveSession
  f.ctx.workspaceRegistry.archiveSession=async id=>{
    assert.equal(f.db.prepare('SELECT delivery_state FROM execution_results WHERE execution_id=?').get(run.executionId).delivery_state,'delivered')
    events.push('archive');return archive.call(f.ctx.workspaceRegistry,id)
  }
  const pending=f.service.results.kick()
  await entered.promise
  f.service.mainSession.reset.start({confirmed:true,expectedSessionId:old.sessionId})
  release.resolve()
  await pending;await f.service.mainSession.reset.operation
  assert.equal(f.service.mainSession.reset.view().state,'succeeded',JSON.stringify(f.service.mainSession.reset.view()))
  assert.deepEqual(events,['prompt','archive'])
})
