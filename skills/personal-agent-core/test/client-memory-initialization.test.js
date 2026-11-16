import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

function fixture(t, listResponse = () => ({ records: [{ type: 'entity', id: 'old', name: 'Old entity' }], supplementary: [], nextOffset: 100, index: { entities: 1 } })) {
  const hooks = [], effects = [], cleanups = [], timers = new Map(), listeners = new Map(), requests = []
  let cursor = 0, timerId = 0, confirm = false, tree
  const escapeSelectionRef = { current: null }
  const React = {
    Fragment: 'Fragment',
    useState(initial) { const key = cursor++; if (!(key in hooks)) hooks[key] = initial; return [hooks[key], value => { hooks[key] = typeof value === 'function' ? value(hooks[key]) : value }] },
    useRef(initial) { const key = cursor++; return hooks[key] ??= { current: initial } },
    useEffect(callback, deps) { const key = cursor++; if (!hooks[key] || deps.some((value, i) => value !== hooks[key][i])) { hooks[key] = deps; effects.push({ key, callback }) } },
  }
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children })
  const window = { matchMedia: () => ({ matches: false }), confirm: () => confirm, clearTimeout: id => timers.delete(id), setTimeout: callback => { timers.set(++timerId, callback); return timerId } }
  const document = { hidden: false, addEventListener: (key, value) => listeners.set(key, value), removeEventListener: key => listeners.delete(key) }
  const requestMemoryInitialization = (method, signal) => { const deferred = Promise.withResolvers(); requests.push({ method, signal, ...deferred }); return deferred.promise }
  let listCalls = 0
  const requestMemory = async (method, params, body, signal) => { listCalls++; return listResponse(params, signal) }
  const start = client.indexOf('    function MemoryBrowser('), end = client.indexOf('\n    function MemoryOverlay(', start)
  const MemoryBrowser = runInNewContext(client.slice(client.indexOf('    function memoryGraphData('),client.indexOf('    function MemoryGraph('))+client.slice(start, end) + ';MemoryBrowser', { React, h, Button: 'button', Glyph: 'glyph', window, document, AbortController, requestMemoryInitialization, requestMemory, MemoryGraph: 'MemoryGraph' })
  const render = () => { cursor = 0; tree = MemoryBrowser({ t: key => key, escapeSelectionRef }); while (effects.length) { const { key, callback } = effects.shift(); cleanups[key]?.(); cleanups[key] = callback() } return tree }
  const nodes = () => { const values = []; const walk = node => { if (Array.isArray(node)) node.forEach(walk); else if (node && typeof node === 'object') { values.push(node); walk(node.children) } }; walk(tree); return values }
  const button = label => nodes().find(node => node.type === 'button' && node.children.includes(label))
  const settle = () => new Promise(resolve => setImmediate(resolve))
  t.after(async () => { cleanups.forEach(cleanup => cleanup?.()); for (const req of requests) req.resolve({ running: false }); await settle(); assert.equal(timers.size, 0); assert.equal(listeners.size, 0) })
  render()
  return { render, button, nodes, requests, timers, listeners, document, settle, escapeSelectionRef, setConfirm(value) { confirm = value }, get listCalls() { return listCalls } }
}

test('initialization requires confirmation, disables duplicate operations, and refreshes records after completion', async t => {
  const f = fixture(t)
  assert.equal(f.button('memoryInitialize').props.disabled, true)
  f.requests[0].resolve({ running: false, state: 'idle' }); await f.settle(); f.render()
  assert.equal(f.button('memoryInitialize').props.disabled, false)
  f.button('memoryInitialize').props.onClick(); await f.settle()
  assert.equal(f.requests.filter(req => req.method === 'POST').length, 0)
  f.setConfirm(true)
  f.button('memoryInitialize').props.onClick(); f.button('memoryInitialize').props.onClick()
  assert.equal(f.requests.filter(req => req.method === 'POST').length, 1)
  f.requests.at(-1).resolve({ running: true, state: 'running', phase: 'draining' }); await f.settle(); f.render()
  assert.equal(f.button('memoryInitializing').props.disabled, true)
  assert.equal(f.button('memoryRun'), undefined)
  assert.equal(f.nodes().some(node => node.children.includes('Old entity')), false)
  assert.ok(f.nodes().some(node => node.children.includes('memoryInitializeDraining')))
  const calls = f.listCalls
  f.requests.at(-1).resolve({ running: false, state: 'succeeded', phase: 'done' }); await f.settle(); f.render()
  assert.equal(f.listCalls, calls + 1)
  assert.equal(f.button('memoryInitialize').props.disabled, false)
  assert.ok(f.nodes().some(node => node.children.includes('memoryInitialized')))
})

test('loading more supplementary sources advances the host cursor and retains earlier sources', async t => {
  const offsets = []
  const f = fixture(t, params => {
    offsets.push(params.offset)
    return { version: 'stable', records: [], graphRecords: [], supplementary: [{id:params.offset?'second':'first',type:'raw-hit',content:params.offset?'Second raw source':'First raw source'}], nextOffset:params.offset+100, hasMore:params.offset===0 }
  })
  f.requests[0].resolve({running:false,state:'idle'}); await f.settle(); f.render()
  f.button('memoryLoadMore').props.onClick(); await f.settle(); f.render()
  assert.deepEqual(offsets, [0,100])
  assert.ok(f.nodes().some(node=>node.children.includes('First raw source')))
  assert.ok(f.nodes().some(node=>node.children.includes('Second raw source')))
  assert.equal(f.button('memoryLoadMore'), undefined)
})

test('opening during initialization restores progress, retains failed-after-clear status, and stops polling when hidden', async t => {
  const f = fixture(t)
  f.requests[0].resolve({ running: true, state: 'running', phase: 'importing' }); await f.settle(); f.render()
  assert.ok(f.nodes().some(node => node.children.includes('memoryInitializeImporting')))
  assert.equal(f.button('memoryInitializing').props.disabled, true)
  f.document.hidden = true; f.listeners.get('visibilitychange')()
  assert.equal(f.timers.size, 0)
  f.document.hidden = false; f.listeners.get('visibilitychange')()
  f.requests.at(-1).resolve({ running: false, state: 'failed', cleared: true, lastError: 'storage failure' }); await f.settle(); f.render()
  assert.ok(f.nodes().some(node => node.props.role === 'alert' && node.children.some(child => typeof child === 'string' && child.includes('memoryInitializeFailedAfterClear'))))
  assert.equal(f.button('memoryInitialize').props.disabled, false)
})

test('initialization copy is registered in both live client dictionaries and locale resources', () => {
  const start = client.indexOf('const zh = {'), end = client.indexOf('    const CSS', start)
  assert.ok(end > start)
  const dictionaries = runInNewContext(client.slice(client.indexOf('    function memoryGraphData('),client.indexOf('    function MemoryGraph('))+client.slice(start, end) + ';({zh,en})')
  for (const language of ['zh', 'en']) {
    const resource = JSON.parse(readFileSync(new URL(`../locale/${language}.json`, import.meta.url), 'utf8'))
    for (const [key, value] of Object.entries(resource).filter(([key]) => key.startsWith('memoryInitializ'))) assert.equal(dictionaries[language][key], value, `${language}.${key}`)
  }
})

test('clearing selection aborts details and a delayed reply cannot restore them', async t => {
  const pending=Promise.withResolvers();let signal
  const f=fixture(t,(params,requestSignal)=>{if(params.entityId){signal=requestSignal;return pending.promise}return{records:[],graphRecords:[],supplementary:[],nextOffset:100}})
  f.requests[0].resolve({running:false});await f.settle();f.render()
  const graph=()=>f.nodes().find(node=>node.type==='MemoryGraph')
  graph().props.onSelect({type:'entity',id:'late'});f.render();assert.ok(f.button('memoryClearSelection'))
  assert.equal(f.escapeSelectionRef.current(),true);f.render();assert.equal(signal.aborted,true);assert.equal(graph().props.selected,null)
  pending.resolve({id:'late',type:'entity',name:'Stale entity'});await f.settle();f.render()
  assert.equal(f.button('memoryClearSelection'),undefined);assert.equal(f.nodes().some(node=>node.children.includes('Stale entity')),false)
  assert.equal(f.escapeSelectionRef.current,null)
})

test('derived graph relationships show endpoints without fetching or exposing record mutations', async t => {
  const f=fixture(t);f.requests[0].resolve({running:false});await f.settle();f.render();const calls=f.listCalls
  f.nodes().find(node=>node.type==='MemoryGraph').props.onSelect({type:'relation',id:'derived',derived:true,relation:'has-memory',fromKind:'session-task',fromId:'task',fromLabel:'Task title',toKind:'memory',toId:'memory',toLabel:'Memory text'})
  f.render();assert.equal(f.listCalls,calls);assert.ok(f.button('Task title'));assert.ok(f.button('Memory text'))
  assert.equal(f.button('memorySave'),undefined);assert.equal(f.button('memoryDelete'),undefined)
  f.button('memoryClearSelection').props.onClick();f.render();assert.equal(f.nodes().find(node=>node.type==='MemoryGraph').props.selected,null)
})
