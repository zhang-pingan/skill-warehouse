import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
const client=readFileSync(new URL('../client.js',import.meta.url),'utf8')

function storeFixture(){
  const requests=[];const timers=new Map();const listeners=new Map();let timerId=0
  const document={hidden:false,addEventListener:(key,value)=>listeners.set(key,value),removeEventListener:(key,value)=>{assert.equal(listeners.get(key),value);listeners.delete(key)}}
  const window={setTimeout:(callback,ms)=>{timers.set(++timerId,{callback,ms});return timerId},clearTimeout:id=>timers.delete(id)}
  const start=client.indexOf('function createStore(');const end=client.indexOf('\n    function remoteValue',start)
  const make=runInNewContext(`(${client.slice(start,end)})`,{window,document,AbortController,fetch:(url,options)=>{
    const deferred=Promise.withResolvers();requests.push({url,options,...deferred});return deferred.promise
  }})
  const store=make({layout:{openRightbar(){},closeRightbar(){}}})
  const settle=()=>new Promise(resolve=>setImmediate(resolve))
  const respond=async(request,value)=>{request.resolve({ok:true,json:async()=>value});await settle()}
  return{store,requests,timers,listeners,document,settle,respond}
}

test('extraction status polling pauses with visibility and releases in-flight requests on unmount',async()=>{
  const f=storeFixture();const dispose=f.store.start()
  await f.respond(f.requests[0],{tasks:{active:[]}})
  assert.equal(f.requests.length,1)
  const unwatch=f.store.watchExtraction()
  assert.equal(f.requests[1].url,'/api/personal-agent/memory/extraction')
  await f.respond(f.requests[1],{running:true})
  assert.equal(f.store.getSnapshot().extraction.running,true)
  assert.equal(f.timers.size,1)
  f.document.hidden=true;f.listeners.get('visibilitychange')()
  assert.equal(f.timers.size,0)
  f.document.hidden=false;f.listeners.get('visibilitychange')()
  const inflight=f.requests.at(-1)
  unwatch()
  assert.equal(inflight.options.signal.aborted,true)
  await f.respond(inflight,{running:false})
  assert.equal(f.store.getSnapshot().extraction.running,true)
  assert.equal(f.timers.size,0)
  dispose()
  assert.equal(f.listeners.size,0)
})

test('an aborted refresh cannot overwrite a later run status or cancel its request',async()=>{
  const f=storeFixture();const dispose=f.store.start();const unwatch=f.store.watchExtraction()
  try{
    const old=f.requests.at(-1)
    f.store.refreshExtraction()
    const fresh=f.requests.at(-1)
    assert.equal(old.options.signal.aborted,true)
    await f.respond(fresh,{running:false,runs:[{state:'succeeded'}]})
    await f.respond(old,{running:true})
    assert.equal(f.store.getSnapshot().extraction.running,false)
    assert.equal(fresh.options.signal.aborted,false)
    assert.equal(f.timers.size,2) // dashboard timeout and the next extraction refresh
    f.store.openExtraction()
    assert.equal(f.store.getSnapshot().sidebarPanel,'extraction')
    f.store.toggleSidebar()
    assert.equal(f.store.getSnapshot().sidebarPanel,'tasks')
    assert.equal(f.store.getSnapshot().sidebarOpen,true)
  }finally{unwatch();dispose()}
  for(const request of f.requests) request.resolve({ok:true,json:async()=>({})})
  await f.settle()
  assert.equal(f.timers.size,0)
})

test('run records expose native log addresses and retain queue errors without inventing past runs',()=>{
  const start=client.indexOf('function memoryExtractionState(')
  const end=client.indexOf('    function TaskSidebar(',start)
  const React={Fragment:'Fragment',useState:initial=>[initial,()=>{}],useRef:initial=>({current:initial}),useEffect(){}}
  const h=(type,props,...children)=>({type,props:props??{},children})
  const {ExtractionRecords,memoryExtractionState}=runInNewContext(client.slice(start,end)+';({ExtractionRecords,memoryExtractionState})',{React,h,Button:'button',Glyph:'glyph',formatDate:value=>value})
  const addresses=[];const ctx={uiWorkspace:{openSession:address=>addresses.push(JSON.parse(JSON.stringify(address)))}}
  const allNodes=tree=>{const nodes=[];const walk=node=>{if(Array.isArray(node)){node.forEach(walk);return}if(node&&typeof node==='object'){nodes.push(node);walk(node.children)}};walk(tree);return nodes}
  const errorData={enabled:true,errors:[{last_error:'Source quote mismatch'}],counts:[{state:'pending',count:1}],runs:[]}
  assert.equal(memoryExtractionState(errorData,null),'extractionAttention')
  const errorTree=allNodes(ExtractionRecords({ctx,state:{extraction:errorData},store:{},t:key=>key,locale:'en'}))
  assert.ok(errorTree.some(node=>node.children?.includes('Source quote mismatch')))
  assert.equal(errorTree.some(node=>node.children?.includes('extractionLog')),false)
  const data={...errorData,errors:[],runs:[{id:'record',state:'failed',logAvailable:true,parentSessionId:'parent',sessionId:'child',startedAt:'start',inputCount:1}]}
  let closed=false
  const tree=allNodes(ExtractionRecords({ctx,state:{extraction:data},store:{closeSidebar(){closed=true}},t:key=>key,locale:'en'}))
  tree.find(node=>node.type==='button'&&node.children.includes('extractionLog')).props.onClick()
  assert.deepEqual(addresses,[{parentSessionId:'parent',childSessionId:'child',mode:'continuable'}])
  assert.equal(closed,true)
})
