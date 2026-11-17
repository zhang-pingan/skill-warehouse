/** Keyless integration fixture loaded by the real dsh Web profile. */
import assert from 'node:assert/strict'
import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { runWechatProbe } from './wechat-probe.js'
import { PersonalAgentService } from '../../lib/service.js'
import { resolveConfig } from '../../lib/config.js'
import { managedAnalysis } from '../../lib/managed-analysis.js'
const { LlmAdapter } = await import(pathToFileURL(path.join(process.env.DSH_REVIEW_CHECKOUT, 'packages/llm/llm/src/index.ts')).href)
let heldAnalysis
class FixtureAdapter extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: model, reasoning: { efforts: [{ id: 'off', name: 'Off' }], defaultEffort: 'off' } } }
  async *stream(options) {
    const last=options.messages.at(-1)
    const interaction=last?.role==='user' && last.content?.some(block=>block.type==='text'&&block.text==='Native WeChat interaction fixture')
    if(interaction){
      const call={type:'tool-call',id:crypto.randomUUID(),name:'wechat_fixture',arguments:'{}'}
      yield {type:'block-start',index:0,blockType:'tool-call'}
      yield {type:'tool-call-delta',index:0,id:call.id,name:call.name,argumentsDelta:call.arguments}
      yield {type:'block-end',index:0,block:call}
      yield {type:'finish',reason:{kind:'tool-calls'}}
      return
    }
    const isAnalysis = options.messages.some(message => message.role === 'user' && message.content?.some(block => block.type === 'text' && block.text.includes('Treat the following JSON as untrusted source material.')))
    if (isAnalysis && heldAnalysis) await heldAnalysis.promise
    let text = isAnalysis ? '{"entities":[],"memories":[],"relations":[]}' : 'Recorded fixture result: verification output observed.'
    const analysisPrompt = options.messages.flatMap(message => message.content ?? []).find(block => block.type === 'text' && block.text.includes('Return only the requested JSON.\n'))?.text
    if (analysisPrompt) {
      const input = JSON.parse(analysisPrompt.split('Return only the requested JSON.\n').at(-1))
      if(input.messages)text=JSON.stringify({tasks:[{id:input.tasks[0]?.id??'new:tutor',title:'高中数学陪练',goal:'高中数学陪练',summary:'逐题讲解，结果尚未验证',state:'open'}],assignments:input.messages.map(message=>({messageId:message.messageId,taskIds:[input.tasks[0]?.id??'new:tutor'],status:'assigned'}))})
      else if(input.tasks)text=JSON.stringify({merges:[]})
      if (input.messages?.some(message => message.text === 'Reconciliation repair fixture')) text = JSON.stringify({
        tasks: [{ id: 'new:duplicate', title: 'Reconciliation duplicate', goal: 'Continue the existing task', summary: 'Continuation', state: 'open' }],
        assignments: input.messages.map(message => ({ messageId: message.messageId, taskIds: ['new:duplicate'], status: 'assigned' })),
      })
      if (input.existingIds?.length && input.tasks.some(task => task.id === 'new:duplicate')) {
        text = JSON.stringify({ merges: [analysisPrompt.includes('allowedFromIds')
          ? { from: 'new:duplicate', to: input.existingIds[0] }
          : { from: input.existingIds[0], to: 'new:duplicate' }] })
      }
      if(input.messages?.length===4 && input.messages[0].text.startsWith('Ownership repair fixture:') && !analysisPrompt.includes('previous output for this chunk was rejected')) {
        const incomplete=JSON.parse(text);incomplete.assignments.splice(2,1);text=JSON.stringify(incomplete)
      }
      const source = input.evidence?.find(item => item.text === 'Memory review fixture: Atlas uses SQLite for local persistence.')
      if (source) text = JSON.stringify({
        entities: [{ name: 'Atlas', type: 'project', attributes: {}, tags: [], aliases: [], evidenceId: source.id, quote: 'Atlas' }],
        memories: [{ kind: 'fact', content: 'Atlas uses SQLite for local persistence.', entityName: 'Atlas', confidence: .8,
          evidence: [{ id: source.id, quote: 'Atlas uses SQLite for local persistence.', stance: 'supports' }] }], relations: [],
      })
      const repair = input.evidence?.find(item => item.text === 'Memory repair fixture: Atlas uses `SQLite` for persistence.')
      if (repair) text = JSON.stringify({ entities: [], relations: [], memories: [{
        kind: 'fact', content: 'Atlas uses SQLite for persistence.', entityName: null, confidence: .8,
        evidence: [{ id: repair.id, quote: analysisPrompt.includes('The previous attempt was rejected.')
          ? 'Atlas uses `SQLite` for persistence.' : 'Atlas uses SQLite for persistence.', stance: 'supports' }],
      }] })
      const taskSource = input.task && input.evidence?.find(item => item.text === '高中数学陪练采用逐题讲解，项目使用 `SQLite` 持久化。')
      if (taskSource) text = JSON.stringify({entities:[{name:'SQLite',type:'tool',attributes:{},state:'confirmed',evidenceId:taskSource.id,quote:'SQLite',aliases:analysisPrompt.includes('previous attempt for this source chunk was rejected')&&!analysisPrompt.includes('Extracted entity alias')?['Unsupported SQLite alias']:[]}],relations:[],memories:[{
        kind:'fact',content:'高中数学陪练项目使用 SQLite 持久化。',entityName:null,confidence:.8,
        evidence:[{id:taskSource.id,quote:analysisPrompt.includes('previous attempt for this source chunk was rejected')?'项目使用 `SQLite` 持久化':'项目使用 SQLite 持久化',stance:'supports'}],
      }]})
      if ([...(input.messages??[]),...(input.evidence??[])].some(item=>item.text==='Malformed JSON repair fixture') && !analysisPrompt.includes('output must be one JSON object')) text='{"tasks":["unfinished'
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 8 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
export const inject = ['webServer','connection','llm','sessionController','sessionPersistence','workingDirectory','agentPresets','agentDefaultModel','subagents','workspaceRegistry','agents','tools','commands','workspaceController','sessionProjections','credentials','userQuestions','approval']
export function apply(ctx) {
  const reviewRoot = process.env.DSH_REVIEW_ROOT
  if (!reviewRoot || !process.env.DSH_HOME || path.resolve(process.env.DSH_HOME) !== path.join(path.resolve(reviewRoot), 'harness-home')) {
    throw new Error('The Harness probe requires DSH_HOME=$DSH_REVIEW_ROOT/harness-home to isolate sessions and settings')
  }
  ctx.effect(() => ctx.llm.registerAdapter(['personal-agent-smoke'], new FixtureAdapter()))
  ctx.effect(() => ctx.webServer.register({kind:'exact',path:'/api/personal-agent-review-hold',handler:async(req,res)=>{
    const rejection=ctx.connection.requestRejection(req)
    if(rejection!==undefined){res.statusCode=rejection;res.end();return}
    if(req.method==='POST'){heldAnalysis??=Promise.withResolvers()}
    else if(req.method==='DELETE'){heldAnalysis?.resolve();heldAnalysis=null}
    res.end(JSON.stringify({held:!!heldAnalysis}))
  }}))
  ctx.effect(() => () => {heldAnalysis?.resolve();heldAnalysis=null})
  ctx.effect(() => ctx.webServer.register({kind:'exact',path:'/api/personal-agent-wechat-probe',handler:async(req,res)=>{
    const rejection=ctx.connection.requestRejection(req)
    if(rejection!==undefined){res.statusCode=rejection;res.end();return}
    try{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await runWechatProbe(ctx,reviewRoot)))}
    catch(error){res.statusCode=500;res.end(JSON.stringify({error:error.stack}))}
  }}))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/personal-agent-review-probe', handler: async (req,res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection !== undefined) { res.statusCode=rejection;res.end();return }
    let service
    try {
      const root = process.env.DSH_REVIEW_ROOT
      service = new PersonalAgentService(resolveConfig({ dataDir:path.join(root,`probe-data-${crypto.randomUUID()}`),codexHome:path.join(root,'codex'),historyRead:false,memoryExtractionEnabled:false,cleanupEnabled:false }), { context:ctx })
      await service.initialize()
      const selection = { provider:'personal-agent-smoke',model:'fixture',reasoningEffort:'off' }
      const analysis = await managedAnalysis(ctx,{purpose:'integration-extraction',instructions:'Return empty arrays for entities, memories and relations.',input:{text:'Project purpose fixture'},cwd:root,selection,signal:new AbortController().signal,budgetMs:30000,maxInputChars:10000,maxOutputChars:10000})
      assert.deepEqual(analysis.value.memories,[])
      const analysisSnapshot = await ctx.sessionPersistence.stat(analysis.sessionId)
      assert.ok(analysisSnapshot)
      assert.equal(await service.dshImporter.executionActivity(ctx.sessionPersistence,analysisSnapshot,async()=>{},{now:Date.now()}),null)
      const analysisLog = await ctx.sessionPersistence.open(analysis.sessionId,'read')
      assert.equal(analysisLog.header.origin,'subagent')
      await analysisLog.close()
      const parentLog = await ctx.sessionPersistence.open(analysis.parentSessionId,'read')
      const parentEvents = (await parentLog.read(0,256)).events
      await parentLog.close()
      assert.equal(parentEvents.some(event=>event.type==='turn/start'||event.type==='user/message'),false)
      assert.ok(parentEvents.some(event=>event.type==='subagent/catalog'))
      service.config = {...service.config,backgroundModelPolicy:'fixture',modelPolicies:{...service.config.modelPolicies,fixture:{worker:'dsh_subagent',provider:selection.provider,model:selection.model,effort:'off'}}}
      const aliasSource = service.ledger.ingestSource({sourceSystem:'dsh',sourceKind:'message',sourceUri:'dsh://alias-fixture',sourceLocator:'seq:1',sourceIdentity:'alias',text:'Atlas Suite is also called Atlas.'})
      service.memory.ensureEntity({name:'Atlas Suite',type:'tool',aliases:['Atlas'],evidenceId:aliasSource.evidenceId,quote:'Atlas Suite is also called Atlas.'})
      service.database.db.prepare("UPDATE memory_extraction_jobs SET state='done' WHERE evidence_id=?").run(aliasSource.evidenceId)
      service.ledger.ingestSource({sourceSystem:'dsh',sourceKind:'message',sourceUri:'dsh://extraction-fixture',sourceLocator:'seq:1',sourceIdentity:crypto.randomUUID(),text:'Memory review fixture: Atlas uses SQLite for local persistence.'})
      await service.memory.run()
      const extractionRun = service.analysisRuns.list('memory-extraction')[0]
      assert.equal(extractionRun.state,'succeeded',JSON.stringify(extractionRun))
      const candidate = service.memory.search('Atlas SQLite',{includeCandidates:true}).memories[0]
      assert.equal(candidate.state,'candidate')
      assert.equal(service.memory.resolveCanonical('Atlas'),null)
      assert.equal(candidate.entityId,service.database.db.prepare("SELECT entity_id FROM memory_entities WHERE entity_key='project:atlas'").get().entity_id)
      assert.equal(service.memory.search('Atlas SQLite').memories.length,0)
      await service.manageMemory({action:'confirm',memoryId:candidate.id})
      assert.equal(service.memory.search('Atlas SQLite').memories[0].state,'confirmed')
      assert.equal(service.memory.search('Atlas Redis').memories.length,0)
      service.ledger.ingestSource({sourceSystem:'dsh',sourceKind:'message',sourceUri:'dsh://repair-fixture',sourceLocator:'seq:1',sourceIdentity:'repair',text:'Memory repair fixture: Atlas uses `SQLite` for persistence.'})
      const beforeRepair = service.memory.indexStatus().memories
      const rejected = await service.memory.run()
      assert.equal(rejected.processed,0)
      assert.equal(service.memory.indexStatus().memories,beforeRepair)
      assert.match(service.analysisRuns.list('memory-extraction')[0].error,/exact source support/)
      assert.equal((await service.memory.run()).processed,1)
      assert.equal(service.analysisRuns.list('memory-extraction')[0].state,'succeeded')
      assert.equal(service.memory.indexStatus().memories,beforeRepair+1)
      const historySession = service.ledger.upsertSession({system:'codex',externalId:'tutor-fixture',cwd:root})
      service.flags.set('history.read',true)
      service.ledger.history.stage({sourceSystem:'codex',sourceKind:'message',externalId:'tutor-fixture',sessionRefId:historySession.sessionRefId,sourceUri:'codex://tutor-fixture',sourceLocator:'message:1',sourceIdentity:'tutor',text:'高中数学陪练采用逐题讲解，项目使用 `SQLite` 持久化。',authorRole:'user',occurredAt:new Date().toISOString()})
      service.ledger.history.complete(historySession.sessionRefId)
      await service.ledger.history.segmentNext()
      assert.equal((await service.operate({action:'list_tasks',includeHistory:true})).historyIncluded,false)
      const recoveredHistory=await service.operate({action:'search_history',query:'高中 陪练'})
      assert.equal(recoveredHistory.results.length,1,JSON.stringify(service.ledger.history.coverage()))
      assert.equal(recoveredHistory.results[0].sessionId,'tutor-fixture')
      const historicalDetail=await service.operate({action:'memory_get',sessionTaskId:recoveredHistory.results[0].id})
      assert.equal(historicalDetail.messages.length,1)
      assert.match((await service.operate({action:'memory_get',evidenceId:historicalDetail.messages[0].evidenceId})).content,/高中数学陪练/)
      const recalled=await service.operate({action:'memory_search',query:'高中 陪练',sourceSystem:'codex'})
      assert.equal(recalled.sessionTasks.length,1)
      assert.equal(recalled.retrieval.status,'matched')
      const taskFailures = service.analysisRuns.failures().total
      await service.memory.runBatch()
      assert.equal(service.analysisRuns.failures().total,taskFailures+2)
      assert.equal(service.ledger.history.get(recoveredHistory.results[0].id).memories.length,1)
      assert.equal(service.database.db.prepare("SELECT entity_state FROM memory_entities WHERE canonical_name='SQLite'").get().entity_state,'candidate')
      assert.equal(service.database.db.prepare('SELECT context_version=extracted_version AS done FROM session_tasks').get().done,1)
      const ownershipSession=service.ledger.upsertSession({system:'codex',externalId:'ownership-repair-fixture',cwd:root})
      for(let i=0;i<4;i++)service.ledger.history.stage({sourceSystem:'codex',sourceKind:'message',externalId:'ownership-repair-fixture',sessionRefId:ownershipSession.sessionRefId,sourceUri:'codex://ownership-repair-fixture',sourceLocator:`message:${i}`,sourceIdentity:`ownership:${i}`,text:`Ownership repair fixture: source ${i}`,authorRole:'user',occurredAt:new Date().toISOString()})
      service.ledger.history.complete(ownershipSession.sessionRefId)
      const ownershipFailures=service.analysisRuns.failures().total
      await service.ledger.history.segmentNext()
      assert.equal(service.analysisRuns.failures().total,ownershipFailures+1)
      assert.equal(service.ledger.history.coverage().sessionsPending,0)
      const repairedTask=service.ledger.history.list({sessionId:'ownership-repair-fixture'}).records[0]
      assert.equal(service.ledger.history.get(repairedTask.id).messages.length,4)
      for(let i=0;i<3;i++)service.ledger.history.stage({sessionRefId:ownershipSession.sessionRefId,sourceSystem:'codex',sourceKind:'message',sourceUri:'codex://pending-review',sourceLocator:`seq:${i}`,sourceIdentity:`pending:${i}`,text:`Unassigned telescope source ${i}`,authorRole:'user',occurredAt:new Date().toISOString()})
      const rawPage=await service.operate({action:'memory_search',query:'telescope',limit:2})
      assert.equal(rawPage.historyPage.hasMore,true)
      assert.equal((await service.operate({action:'memory_search',query:'telescope',limit:2,offset:rawPage.historyPage.nextOffset})).experiences.length,1)
      assert.equal((await service.operate({action:'search_history',query:'telescope',sessionId:'another-session'})).supplementary.length,0)
      assert.equal((await service.operate({action:'search_history',query:'telescope',sessionId:'ownership-repair-fixture'})).retrieval.status,'matched')
      assert.equal((await service.operate({action:'memory_search',query:'!!!'})).retrieval.status,'no-match')
      const jsonSession=service.ledger.upsertSession({system:'dsh',externalId:'json-repair-fixture',cwd:root})
      service.ledger.history.stage({sessionRefId:jsonSession.sessionRefId,sourceSystem:'dsh',sourceKind:'message',sourceUri:'dsh://json-repair-fixture',sourceLocator:'seq:1',sourceIdentity:'json-repair:1',text:'Malformed JSON repair fixture',authorRole:'user',occurredAt:new Date().toISOString()})
      service.ledger.history.complete(jsonSession.sessionRefId)
      const jsonFailures=service.analysisRuns.failures().total
      await service.ledger.history.segmentNext()
      const jsonTask=service.database.db.prepare('SELECT t.*,s.cwd FROM session_tasks t JOIN session_refs s USING(session_ref_id) WHERE session_ref_id=?').get(jsonSession.sessionRefId)
      assert.ok(jsonTask)
      assert.equal((await service.memory.extractTask(jsonTask)).processed,1)
      assert.equal(service.analysisRuns.failures().total,jsonFailures+2)
      assert.equal(service.database.db.prepare('SELECT context_version=extracted_version AS done FROM session_tasks WHERE session_task_id=?').get(jsonTask.session_task_id).done,1)
      const batchReview = new PersonalAgentService(resolveConfig({ dataDir: path.join(root, `batch-review-${crypto.randomUUID()}`), codexHome: path.join(root, 'codex'), historyRead: false, memoryExtractionEnabled: false, cleanupEnabled: false }), { context: ctx })
      try {
        await batchReview.initialize()
        batchReview.config = { ...batchReview.config, backgroundModelPolicy: 'fixture', modelPolicies: service.config.modelPolicies }
        const stage = (session, text, index) => batchReview.ledger.history.stage({ sessionRefId: session.sessionRefId, sourceSystem: 'dsh', sourceKind: 'message', sourceUri: `dsh://${session.sessionRefId}`, sourceLocator: `seq:${index}`, sourceIdentity: `version:${index}`, text, authorRole: 'user', occurredAt: new Date().toISOString() })
        const taskIds = []
        for (let i = 0; i < 3; i++) {
          const session = batchReview.ledger.upsertSession({ system: 'dsh', externalId: `batch-review-${i}`, cwd: root })
          stage(session, `Batch source ${i}`, 0)
          batchReview.ledger.history.complete(session.sessionRefId)
          await batchReview.ledger.history.segmentNext()
          taskIds.push(batchReview.ledger.history.list({ sessionId: session.sessionRefId }).records[0].id)
        }
        batchReview.database.db.prepare("UPDATE session_tasks SET attempts=?,last_error='Exhausted prior task' WHERE session_task_id=?").run(batchReview.config.memoryExtractionRetryLimit, taskIds[0])
        assert.equal((await batchReview.memory.run()).processed, 2)
        assert.equal(batchReview.database.db.prepare('SELECT COUNT(*) AS n FROM session_tasks WHERE context_version=extracted_version').get().n, 2)
        const task = batchReview.ledger.history.get(taskIds[1])
        const session = { sessionRefId: task.sessionRefId }
        const oldEvidence = task.messages[0].evidenceId
        stage(session, 'Reconciliation repair fixture', 1)
        batchReview.ledger.history.complete(session.sessionRefId)
        const failures = batchReview.analysisRuns.failures().total
        await batchReview.ledger.history.segmentNext()
        assert.equal(batchReview.analysisRuns.failures().total, failures + 1)
        assert.equal(batchReview.ledger.history.get(task.id).messages.length, 2)
        assert.equal(batchReview.ledger.history.get(task.id).messages[0].evidenceId, oldEvidence)
        const run = batchReview.analysisRuns.run.bind(batchReview.analysisRuns)
        batchReview.analysisRuns.run = (options, commit) => run(options, value => {
          batchReview.database.db.prepare("UPDATE session_tasks SET summary='Newer task context' WHERE session_task_id=?").run(task.id)
          batchReview.ledger.history.refreshTasks([task.id])
          return commit(value)
        })
        const oldVersion = batchReview.database.db.prepare('SELECT t.*,s.cwd FROM session_tasks t JOIN session_refs s USING(session_ref_id) WHERE session_task_id=?').get(task.id)
        assert.equal((await batchReview.memory.extractTask(oldVersion)).processed, 0)
        assert.equal(batchReview.ledger.history.get(task.id).extractionPending, true)
        assert.equal(batchReview.database.db.prepare('SELECT last_error FROM session_tasks WHERE session_task_id=?').get(task.id).last_error, null)
        assert.equal(batchReview.analysisRuns.failures().total, failures + 2)
        assert.match(batchReview.analysisRuns.list('memory-extraction')[0].error, /changed during extraction/)
        batchReview.analysisRuns.run = run
        stage(session, 'Remaining source after deletion', 2)
        batchReview.ledger.history.complete(session.sessionRefId)
        batchReview.database.db.prepare("UPDATE history_sessions SET attempts=?,last_error='Obsolete segmentation failure' WHERE session_ref_id=?").run(batchReview.config.memoryExtractionRetryLimit, session.sessionRefId)
        batchReview.ledger.history.removeTask(task.id)
        assert.deepEqual(await batchReview.ledger.history.segmentNext(), { attempted: true, published: true })
        const remaining = batchReview.ledger.history.list({ sessionId: session.sessionRefId }).records[0]
        assert.notEqual(remaining.id, task.id)
        assert.equal(batchReview.ledger.history.get(remaining.id).messages.length, 1)
      } finally { await batchReview.dispose() }
      service.flags.set('history.read',false)
      const created = await ctx.sessionController.create({ cwd:root,agentPreset:'standard' })
      service.database.db.prepare("INSERT INTO main_session_binding VALUES(1,?,1,'ready',?)").run(created.sessionId,new Date().toISOString())
      const resolved = await ctx.sessionController.resolveAgent(created.sessionId)
      if ('error' in resolved) throw new Error(JSON.stringify(resolved.error))
      const agent = resolved.agent
      agent.model.select(selection)
      const internal = await service.executeObjective({worker:'internal',objective:'Record actual Harness result',mutatesWorkspace:false,acceptance:['Observe fixture output'],requestId:'real-internal'},{agent})
      agent.followup(Object.freeze({id:crypto.randomUUID(),role:'user',source:{kind:'user'},content:[{type:'text',text:'Produce the verification fixture output.'}]}))
      await agent.whenIdle()
      const finished = await service.finishInternalExecution({executionId:internal.executionId,output:'Verify actual logged result'},{agent})
      service.ledger.recordAcceptance(internal.executionId,{state:'passed',evidenceIds:[finished.evidenceId]})
      const task = service.ledger.getTask(internal.taskId)
      assert.equal(service.ledger.transitionTask(task.taskId,'completed',task.state).state,'completed')
      const dsh = await service.executeObjective({worker:'dsh_subagent',agentPreset:'cordis',objective:'Inspect plugin fixture',workspacePath:root,mutatesWorkspace:false,modelProvider:selection.provider,model:selection.model,effort:'off',requestId:'real-dsh'},{agent})
      assert.equal(dsh.stopReason,'completed')
      assert.equal(service.ledger.getTask(dsh.taskId).state,'active')
      const childLog = await ctx.sessionPersistence.open(dsh.childId,'read')
      let childEvents=[]
      try { let offset=0;while(true){const batch=await childLog.read(offset,256);childEvents.push(...batch.events);offset+=batch.events.length;if(batch.events.length<256)break} }finally{await childLog.close()}
      const snapshot={ analysisRecorded:true, analysisHidden:true, extractionRecorded:true, memoryRecallVerified:true, internalState:service.ledger.getTask(internal.taskId).state, workerPreset:childEvents.filter(event=>event.type.includes('preset')).map(event=>event.data), workerState:service.database.db.prepare('SELECT execution_state FROM executions WHERE execution_id=?').get(dsh.executionId).execution_state, taskState:service.ledger.getTask(dsh.taskId).state, resultEvidence:!!dsh.evidenceId, acceptanceState:service.ledger.acceptanceStatus(dsh.taskId).results[0].state, childTerminal:childEvents.filter(event=>event.type==='turn/end').at(-1)?.data?.reason?.kind }
      const evaluation = service.executionEvaluation()
      snapshot.extractionReferencesVerified=true
      snapshot.extractionRepairVerified=true
      snapshot.historyRetrievalVerified=true
      snapshot.sessionTaskOwnershipVerified=true
      snapshot.taskExtractionRepairVerified=true
      snapshot.taskEntityRepairVerified=true
      snapshot.taskCandidateAuthorityVerified=true
      snapshot.supplementaryPaginationVerified=true
      snapshot.malformedOutputRepairVerified=true
      snapshot.batchFailureIsolationVerified=true
      snapshot.staleTaskErrorIsolationVerified=true
      snapshot.publishedTaskIdentityRepairVerified=true
      snapshot.deletedTaskRetryResetVerified=true
      snapshot.taskOwnershipRepairVerified=true
      snapshot.failurePaginationVerified=service.memoryExtractionView().runs.every(run=>run.state!=='succeeded')
      assert.equal(evaluation.quality.verifiedExecutionCount,1)
      assert.equal(evaluation.quality.pending,1)
      assert.equal(evaluation.usage.length,2)
      snapshot.qualityRecorded=true
      assert.equal(ctx.commands.list(agent).some(command => command.name === 'personal-assistant'), false)
      snapshot.assistantCommandAbsent=true
      // Exercise the installed tool pipeline so the real dashboard has a fixture execution to inspect.
      const uiResult=await ctx.tools.execute({agent,signal:new AbortController().signal,calls:[{type:'tool-call',id:crypto.randomUUID(),name:'personal_agent',arguments:JSON.stringify({action:'execute',worker:'dsh_subagent',agentPreset:'cordis',objective:'验证私人助理插件的任务与质量面板',workspacePath:root,mutatesWorkspace:false,modelProvider:selection.provider,model:selection.model,effort:'off',acceptance:['核对 Harness 持久化结果'],forceNew:true,requestId:crypto.randomUUID()})}]})
      assert.equal(uiResult.results[0].result.isError,false,JSON.stringify(uiResult))
      const ui = new PersonalAgentService(resolveConfig({dataDir:path.join(root,'data'),codexHome:path.join(root,'codex'),historyRead:false,memoryExtractionEnabled:false,cleanupEnabled:false}), {context:ctx})
      await ui.initialize()
      try {
        ui.config={...ui.config,backgroundModelPolicy:'fixture',modelPolicies:{fixture:{worker:'dsh_subagent',provider:selection.provider,model:selection.model,effort:'off'}}}
        const session=ui.ledger.upsertSession({system:'dsh',externalId:'memory-ui-fixture',cwd:root})
        for(const [index,text] of ['Memory review fixture: Atlas uses SQLite for local persistence.','Unique source phrase: copper telescope','Read and verify the exact original sources.'].entries())ui.ledger.history.stage({sessionRefId:session.sessionRefId,sourceSystem:'dsh',sourceKind:'message',externalId:'memory-ui-fixture',sourceUri:'dsh://session/memory-ui-fixture',sourceLocator:'seq:'+index,sourceIdentity:'ui:'+index,text,authorRole:'user',occurredAt:new Date().toISOString(),normalizedPayload:{seq:index}})
        ui.ledger.history.complete(session.sessionRefId,'Memory interaction verification')
        const pendingSession=ui.ledger.upsertSession({system:'dsh',externalId:'pending-ui-fixture',cwd:root})
        for(let i=0;i<105;i++)ui.ledger.history.stage({sessionRefId:pendingSession.sessionRefId,sourceSystem:'dsh',sourceKind:'message',sourceUri:'dsh://pending-ui-fixture',sourceLocator:`seq:${i}`,sourceIdentity:`pending-ui:${i}`,text:`待归属分页验证 ${String(i).padStart(3,'0')}：这是一条等待会话任务分析的原始消息。`,authorRole:'user',occurredAt:new Date().toISOString()})
        await ui.memory.runBatch()
      } finally {await ui.dispose()}
      assert.equal(snapshot.childTerminal,'completed')
      assert.equal(snapshot.acceptanceState,'pending')
      const settingsBeforeReset = service.runtimeSettingsView().settings
      service.initializeMemory({confirmed:true})
      await service.memoryInitializationOperation
      assert.equal(service.memoryInitializationView().state,'succeeded')
      assert.equal(service.database.health().tasks,0)
      assert.equal(service.memory.list().index.experiences,0)
      assert.equal(service.memory.list().index.memories,0)
      assert.equal(await service.assistantSessionTarget(),created.sessionId)
      assert.deepEqual(service.runtimeSettingsView().settings,settingsBeforeReset)
      assert.deepEqual(service.database.db.prepare('PRAGMA foreign_key_check').all(),[])
      assert.ok(await ctx.sessionPersistence.stat(analysis.sessionId))
      assert.ok(await ctx.sessionPersistence.stat(dsh.childId))
      snapshot.memoryInitializationVerified=true
      assert.deepEqual(snapshot,JSON.parse(await (await import('node:fs/promises')).readFile(new URL('./expected.json',import.meta.url),'utf8')))
      await writeFile(path.join(root,'harness-behavior.json'),JSON.stringify(snapshot,null,2)+'\n')
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(snapshot))
    }catch(error){res.statusCode=500;res.end(JSON.stringify({error:error.stack}))}finally{await service?.dispose()}
  } }))
}
