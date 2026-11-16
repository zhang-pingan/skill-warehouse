import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fixture } from './helpers.js'
import { MemorySystem } from '../lib/memory-system.js'
import { CodexHistoryImporter } from '../lib/codex-history.js'
import { AnalysisRuns } from '../lib/analysis-runs.js'

function setup(options = {}) {
  const f = fixture(options)
  const service = { ledger: f.ledger, database: f.database, config: f.config, historyLifetime: new AbortController(), backgroundModelSelection: () => null }
  service.memory = new MemorySystem(service)
  const history = f.ledger.history
  const session = f.ledger.upsertSession({ system: 'dsh', externalId: 'review-session', cwd: f.root })
  const stage = (text, index) => history.stage({ sessionRefId: session.sessionRefId, sourceSystem: 'dsh', sourceKind: 'message', sourceUri: 'dsh://review-session', sourceLocator: `seq:${index}`, sourceIdentity: `v:${index}`, text, authorRole: 'user', occurredAt: `2026-01-01T00:00:${String(index).padStart(2,'0')}.000Z` })
  const task = { id: 'new:review', title: 'Review project', goal: 'Review project', summary: 'Review result', state: 'open' }
  service.analysisRuns = { async run(options, commit) { return commit(options.input.messages ? { tasks: options.input.tasks.length ? [] : [task], assignments: options.input.messages.map(m => ({ messageId: m.messageId, taskIds: [options.input.tasks[0]?.id ?? task.id], status: 'assigned' })) } : { merges: [] }) } }
  const publish = async () => { history.complete(session.sessionRefId); await history.segmentNext(); return history.list().records[0] }
  return { ...f, service, history, session, stage, publish }
}

test('task extraction keeps model entities candidate even when output supplies a trusted state', async () => {
  const f = setup(); try {
    f.stage('Aurora uses SQLite', 0); await f.publish()
    f.service.analysisRuns.run = async (options, commit) => commit({ entities: [{ name: 'Aurora', type: 'project', attributes: {}, state: 'confirmed', evidenceId: options.input.evidence[0].id, quote: 'Aurora' }], memories: [], relations: [] })
    await f.service.memory.runBatch()
    assert.equal(f.database.db.prepare('SELECT entity_state FROM memory_entities').get().entity_state, 'candidate')
    assert.equal(f.service.memory.search('Aurora').entities.length, 0)
  } finally { f.close() }
})

test('an exhausted task does not throttle successful batches and run counts all completed tasks', async () => {
  const f = setup(); try {
    for (let i = 0; i < 3; i++) f.stage(`Project ${i}`, i)
    f.history.complete(f.session.sessionRefId)
    f.service.analysisRuns.run = async (options, commit) => commit(options.input.messages ? {
      tasks: options.input.messages.map((m, i) => ({ id: `new:p${i}`, title: `Project ${i}`, goal: m.text, summary: m.text, state: 'open' })),
      assignments: options.input.messages.map((m, i) => ({ messageId: m.messageId, taskIds: [`new:p${i}`], status: 'assigned' })),
    } : { merges: [] })
    await f.history.segmentNext()
    f.database.db.prepare("UPDATE session_tasks SET attempts=?,last_error='Prior exhausted failure' WHERE title='Project 0'").run(f.config.memoryExtractionRetryLimit)
    let calls = 0
    f.service.analysisRuns.run = async (options, commit) => { calls++; return commit({ entities: [], memories: [], relations: [] }) }
    const result = await f.service.memory.run()
    assert.equal(calls, 2)
    assert.equal(result.processed, 2)
    assert.equal(f.database.db.prepare('SELECT COUNT(*) AS n FROM session_tasks WHERE context_version=extracted_version').get().n, 2)
    assert.match(result.errors[0].last_error, /Prior exhausted failure/)
  } finally { f.close() }
})

test('a failure in the current batch stops the run without retrying the task again in that run', async () => {
  const f = setup(); try {
    f.stage('Project source', 0); await f.publish()
    let calls = 0
    f.service.analysisRuns.run = async () => { calls++; throw new Error('Model unavailable') }
    const result = await f.service.memory.run()
    assert.equal(calls, 1)
    assert.equal(result.processed, 0)
    assert.equal(f.database.db.prepare('SELECT attempts FROM session_tasks').get().attempts, 1)
    assert.match(result.errors[0].last_error, /Model unavailable/)
  } finally { f.close() }
})

test('stale extraction does not report its failure on the latest task version', async () => {
  const f = setup(); try {
    f.stage('Project source', 0); const task = await f.publish()
    f.service.analysisRuns.run = async (options, commit) => {
      f.database.db.prepare("UPDATE session_tasks SET summary='Updated task context' WHERE session_task_id=?").run(task.id)
      f.history.refreshTasks([task.id])
      return commit({ entities: [], memories: [], relations: [] })
    }
    await f.service.memory.runBatch()
    const current = f.database.db.prepare('SELECT attempts,last_error,extracted_version FROM session_tasks').get()
    assert.deepEqual({ ...current }, { attempts: 0, last_error: null, extracted_version: null })
    assert.equal(f.service.memory.status().errors.length, 0)
  } finally { f.close() }
})

test('stale segmentation does not report its failure on a newly imported session revision', async () => {
  const f = setup(); try {
    f.stage('Initial source', 0); f.history.complete(f.session.sessionRefId)
    const analyze = f.service.analysisRuns.run
    f.service.analysisRuns.run = async (options, commit) => {
      if (!options.input.messages) f.stage('New source during reconciliation', 1)
      return analyze(options, commit)
    }
    await f.history.segmentNext()
    const row = f.database.db.prepare('SELECT attempts,last_error,published_revision FROM history_sessions').get()
    assert.deepEqual({ ...row }, { attempts: 0, last_error: null, published_revision: 0 })
    assert.equal(f.history.coverage().sessionsPending, 1)
    assert.equal(f.history.list().records.length, 0)
  } finally { f.close() }
})

test('reconciliation repairs an attempt to replace a published task and preserves its original sources', async () => {
  const f = setup(); try {
    f.stage('Initial project request', 0); const original = await f.publish()
    const source = f.history.get(original.id).messages[0].evidenceId
    f.stage('Continuation of the same project', 1); f.history.complete(f.session.sessionRefId)
    let reconciliations = 0
    f.service.analysisRuns.run = async (options, commit) => {
      if (options.input.messages) return commit({
        tasks: [{ id: 'new:duplicate', title: 'Continued project', goal: 'Review project', summary: 'Continued work', state: 'open' }],
        assignments: options.input.messages.map(m => ({ messageId: m.messageId, taskIds: ['new:duplicate'], status: 'assigned' })),
      })
      reconciliations++
      if (reconciliations === 1) return commit({ merges: [{ from: original.id, to: 'new:duplicate' }] })
      assert.ok(options.instructions.includes('"allowedFromIds":["new:duplicate"]'))
      assert.ok(options.instructions.includes(original.id))
      assert.equal(f.history.get(original.id).messages.length, 1)
      return commit({ merges: [{ from: 'new:duplicate', to: original.id }] })
    }
    assert.deepEqual(await f.history.segmentNext(), { attempted: true, published: true })
    assert.equal(reconciliations, 2)
    assert.deepEqual(f.history.list().records.map(task => task.id), [original.id])
    assert.equal(f.history.get(original.id).messages.length, 2)
    assert.equal(f.history.get(original.id).messages[0].evidenceId, source)
  } finally { f.close() }
})

test('failed segmentation stops the current run while a completed no-task session allows the next session', async () => {
  const f = setup(); try {
    f.stage('No historical task', 0); f.history.complete(f.session.sessionRefId)
    let calls = 0
    f.service.analysisRuns.run = async (options, commit) => { calls++; return commit({ tasks: [], assignments: [] }) }
    const failed = await f.service.memory.run()
    assert.equal(failed.failed, true)
    assert.equal(calls, f.config.memoryExtractionRetryLimit)
    assert.equal(f.database.db.prepare('SELECT attempts FROM history_sessions').get().attempts, 1)
    const other = f.ledger.upsertSession({ system: 'dsh', externalId: 'next-session' })
    f.history.stage({ sessionRefId: other.sessionRefId, sourceSystem: 'dsh', sourceKind: 'message', sourceUri: 'dsh://next-session', sourceLocator: 'seq:1', sourceIdentity: 'next:1', text: 'Another greeting', authorRole: 'user' })
    f.history.complete(other.sessionRefId)
    f.service.analysisRuns.run = async (options, commit) => commit(options.input.messages ? {
      tasks: [], assignments: options.input.messages.map(m => ({ messageId: m.messageId, taskIds: [], status: 'no-task' })),
    } : { merges: [] })
    await f.service.memory.run()
    assert.equal(f.history.coverage().sessionsPending, 0)
    assert.deepEqual(f.history.coverage().messages.map(row => ({ ...row })), [{ ownership: 'no-task', count: 2 }])
  } finally { f.close() }
})

test('task extraction preparation failures consume a bounded attempt and remain visible', async () => {
  const f = setup(); try {
    f.stage('Original source', 0); const task = await f.publish()
    f.service.config = { ...f.config, analysisInputChars: 50 }
    f.service.analysisRuns.run = async () => { throw new Error('No model call should fit') }
    const result = await f.service.memory.runBatch()
    const failed = f.database.db.prepare('SELECT attempts,last_error,extracted_version FROM session_tasks WHERE session_task_id=?').get(task.id)
    assert.equal(result.processed, 0)
    assert.equal(failed.attempts, 1)
    assert.match(failed.last_error, /input budget/)
    assert.equal(failed.extracted_version, null)
  } finally { f.close() }
})

test('task status changes invalidate extraction even when its summary and sources stay the same', async () => {
  const f = setup(); try {
    f.stage('Original task', 0); const first = await f.publish()
    f.stage('Thanks', 1)
    f.service.analysisRuns.run = async (options, commit) => commit(options.input.messages ? { tasks: [{ ...f.history.directory(f.session.sessionRefId)[0], state: 'completed' }], assignments: options.input.messages.map(m => ({ messageId: m.messageId, taskIds: [], status: 'no-task' })) } : { merges: [] })
    const second = await f.publish()
    assert.equal(second.state, 'completed')
    assert.notEqual(second.version, first.version)
  } finally { f.close() }
})

test('deleting a task while segmentation is in flight prevents stale task resurrection', async () => {
  const f = setup(); try {
    f.stage('Original task', 0); const task = await f.publish()
    f.stage('Follow-up', 1); f.history.complete(f.session.sessionRefId)
    f.service.analysisRuns.run = async (options, commit) => {
      if (!options.input.messages) { f.history.removeTask(task.id); return commit({ merges: [] }) }
      return commit({ tasks: [], assignments: options.input.messages.map(m => ({ messageId: m.messageId, taskIds: [task.id], status: 'assigned' })) })
    }
    await f.history.segmentNext()
    assert.equal(f.history.get(task.id), null)
    assert.equal(f.history.list().records.length, 0)
    assert.deepEqual(f.history.coverage().errors, [])
  } finally { f.close() }
})

test('deleting a task releases the obsolete retry limit for remaining unprocessed messages', async () => {
  const f = setup(); try {
    f.stage('Original source', 0); const task = await f.publish()
    f.stage('Remaining source', 1); f.history.complete(f.session.sessionRefId)
    f.database.db.prepare("UPDATE history_sessions SET attempts=?,last_error='Failed previous snapshot'").run(f.config.memoryExtractionRetryLimit)
    f.history.removeTask(task.id)
    const current = f.database.db.prepare('SELECT attempts,last_error FROM history_sessions').get()
    assert.deepEqual({ ...current }, { attempts: 0, last_error: null })
    assert.deepEqual(await f.history.segmentNext(), { attempted: true, published: true })
    const replacement = f.history.list().records[0]
    assert.notEqual(replacement.id, task.id)
    assert.equal(f.history.get(replacement.id).messages.length, 1)
    assert.equal(f.history.coverage().sessionsPending, 0)
  } finally { f.close() }
})

test('deleting one source invalidates surviving task pages and in-flight extraction', async () => {
  const f = setup(); try {
    f.stage('First source', 0); f.stage('Second source', 1); const task = await f.publish()
    const detail = f.history.get(task.id)
    f.service.analysisRuns.run = async (options, commit) => {
      f.service.memory.removeExperience(detail.messages[0].evidenceId)
      return commit({ entities: [], memories: [], relations: [] })
    }
    const result = await f.service.memory.runBatch()
    assert.equal(result.processed, 0)
    assert.throws(() => f.history.get(task.id, { version: detail.version, offset: 1 }), /changed during paging/)
    assert.equal(f.history.get(task.id).messages.length, 1)
    assert.equal(f.database.db.prepare('SELECT extracted_version FROM session_tasks').get().extracted_version, null)
    assert.equal(f.database.db.prepare('SELECT attempts FROM session_tasks').get().attempts, 0)
  } finally { f.close() }
})

test('raw supplementary recall respects session and project scopes and has its own complete pagination', async () => {
  const f = setup(); try {
    for (let i=0;i<3;i++) f.stage('Unassigned telescope source '+i, i)
    const project = f.ledger.upsertProject({ name: 'Review', canonicalPath: f.root })
    assert.equal(f.history.list({ query: 'telescope', rawSearch: true }).supplementary.length, 3)
    assert.equal(f.history.list({ query: 'telescope', rawSearch: true, sessionId: 'other' }).supplementary.length, 0)
    assert.equal(f.history.list({ query: 'telescope', rawSearch: true, projectId: 'other' }).supplementary.length, 0)
    assert.equal(f.history.list({ query: 'telescope', rawSearch: true, projectId: project.projectId }).supplementary.length, 3)
    assert.equal(f.history.list({ query: 'telescope', rawSearch: true, taskId: 'other' }).supplementary.length, 0)
    const page = f.service.memory.list({ query: 'telescope', rawSearch: true, limit: 2 })
    assert.equal(page.supplementary.length, 2)
    assert.equal(page.hasMore, true)
    assert.equal(page.nextOffset, 2)
    const next = f.service.memory.list({ query: 'telescope', rawSearch: true, limit: 2, offset: page.nextOffset, version: page.version })
    assert.equal(next.supplementary.length, 1)
    assert.equal(next.hasMore, false)
    assert.equal(new Set([...page.supplementary,...next.supplementary].map(r=>r.id)).size, 3)
    const recall = f.service.memory.search('telescope', { limit: 2 })
    assert.equal(recall.historyPage.hasMore, true)
    assert.equal(f.service.memory.search('telescope', { limit: 2, offset: recall.historyPage.nextOffset }).experiences.length, 1)
  } finally { f.close() }
})

test('new context reconsiders unresolved ownership without repeatedly analyzing an unchanged session', async () => {
  const f=setup(); try {
    const first=f.stage('Ambiguous request',0); f.history.complete(f.session.sessionRefId)
    f.service.analysisRuns.run=async(options,commit)=>commit(options.input.messages?{tasks:[],assignments:options.input.messages.map(m=>({messageId:m.messageId,taskIds:[],status:'unresolved'}))}:{merges:[]})
    await f.history.segmentNext()
    assert.deepEqual(await f.history.segmentNext(),{attempted:false,published:false})
    const second=f.stage('This continues the Aurora project',1);f.history.complete(f.session.sessionRefId)
    f.service.analysisRuns.run=async(options,commit)=>{
      if(!options.input.messages)return commit({merges:[]})
      assert.deepEqual(options.input.messages.map(m=>m.messageId),[first.messageId,second.messageId])
      return commit({tasks:[{id:'new:aurora',title:'Aurora',goal:'Aurora',summary:'Clarified task',state:'open'}],assignments:options.input.messages.map(m=>({messageId:m.messageId,taskIds:['new:aurora'],status:'assigned'}))})
    }
    await f.history.segmentNext()
    assert.equal(f.history.get(f.history.list().records[0].id).messages.length,2)
  } finally { f.close() }
})

test('graph includes relationships between records on different result pages', async () => {
  const f = setup(); try {
    const source = f.ledger.ingestSource({ sourceSystem: 'dsh', sourceKind: 'message', sourceUri: 'dsh://graph', sourceLocator: 'seq:1', sourceIdentity: 'graph', text: 'Aurora project' })
    const entity = f.service.memory.ensureEntity({ name: 'Aurora', type: 'project', evidenceId: source.evidenceId, quote: 'Aurora' })
    const memory = f.service.memory.createRecord({ kind: 'fact', content: 'Aurora project', entityId: entity.id, evidence: [{ id: source.evidenceId, quote: 'Aurora' }] })
    const pages = Array.from({length:8},(_,offset)=>f.service.memory.list({ type: 'all', limit:1, offset, from: '2020-01-01T00:00:00Z' }))
    const ids = new Set(pages.flatMap(page=>page.records.map(r=>r.id)))
    assert.ok(ids.has(entity.id) && ids.has(memory.id))
    assert.ok(pages.some(page=>page.graphRecords.some(r=>r.fromId===memory.id && r.toId===entity.id)))
  } finally { f.close() }
})

test('punctuation-only memory queries return all empty retrieval lanes', () => {
  const f = setup(); try {
    const result = f.service.memory.search('!!!')
    for (const lane of ['sessionTasks','memories','entities','relations','experiences','tasks']) assert.deepEqual(result[lane], [])
    assert.deepEqual(result.historyPage, { offset: 0, nextOffset: 20, hasMore: false, total: 0, supplementaryTotal: 0 })
  } finally { f.close() }
})

test('Codex write failures retain the import cursor before the failed record', async () => {
  const f = fixture(); try {
    const directory = path.join(f.config.codexHome, 'sessions'); mkdirSync(directory, {recursive:true})
    const file = path.join(directory, 'rollout.jsonl')
    const records = [{type:'session_meta',payload:{id:'codex-review'}},...['First','Second','Third'].map(message=>({type:'event_msg',timestamp:'2026-01-01T00:00:00Z',payload:{type:'user_message',message}}))]
    writeFileSync(file, records.map(r=>JSON.stringify(r)).join('\n')+'\n')
    const importer = new CodexHistoryImporter(f.ledger, f.config)
    const original = f.ledger.stageHistorySource.bind(f.ledger)
    f.ledger.stageHistorySource = source => { if(source.text==='Second')throw new Error('Memory capacity reached'); return original(source) }
    const failed = await importer.importRollouts()
    assert.equal(failed.complete, false)
    assert.match(failed.warnings[0].error, /capacity/)
    assert.ok(importer.cursor(file, statSync(file)).offset < statSync(file).size)
    f.ledger.stageHistorySource = original
    await importer.importRollouts()
    assert.deepEqual(f.database.db.prepare('SELECT staged_text FROM history_messages ORDER BY source_order').all().map(r=>r.staged_text), ['First','Second','Third'])
  } finally { f.close() }
})

for (const repair of [true,false]) test(`malformed task output ${repair ? 'retries only its chunk and records recovery' : 'stops at the retry limit without partial publication'}`, async () => {
  const f=setup({analysisInputChars:2200,memoryExtractionRetryLimit:3}); try {
    f.stage('Aurora source. '+'Context '.repeat(140),0)
    f.stage('Borealis source. '+'Context '.repeat(140),1)
    await f.publish()
    const calls=[]
    const context={
      agents:{async create(){return{agent:{},async dispose(){}}}},agentPresets:{mount(){}},sessionPersistence:{async flush(){}},
      subagents:{async startActivation(spec){
        const prompt=spec.prompt[0].text,input=JSON.parse(prompt.split('Return only the requested JSON.\n').at(-1)),source=input.evidence[0]
        const name=source.text.startsWith('Aurora')?'Aurora':'Borealis'
        calls.push(name)
        assert.equal(f.database.db.prepare('SELECT COUNT(*) AS n FROM memory_records').get().n,0)
        const retry=prompt.includes('output must be one JSON object')
        const text=name==='Borealis'&&(!repair||!retry)?'{"memories":["unterminated':JSON.stringify({entities:[],relations:[],memories:[{kind:'fact',content:name+' source.',confidence:.8,evidence:[{id:source.id,quote:name+' source.',stance:'supports'}]}]})
        return{result:Promise.resolve({stopReason:'completed',output:[{type:'text',text}]}),async dispose(){}}
      }},
    }
    f.service.analysisRuns=new AnalysisRuns(f.database.db,context)
    const result=await f.service.memory.runBatch()
    assert.deepEqual(calls,repair?['Aurora','Borealis','Borealis']:['Aurora','Borealis','Borealis','Borealis'])
    assert.equal(result.processed,repair?1:0)
    assert.equal(f.database.db.prepare('SELECT COUNT(*) AS n FROM memory_records').get().n,repair?2:0)
    assert.equal(f.service.analysisRuns.failures().total,repair?1:3)
  } finally { f.close() }
})
