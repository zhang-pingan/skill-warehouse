import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
const client=readFileSync(new URL('../client.js',import.meta.url),'utf8')
const source=client.slice(client.indexOf('function createStarMapRenderer('),client.indexOf("    const React = require('react');"))
function fixture({failBounds=false,reducedMotion=true,empty=false}={}) {
  const frames=new Map(),listeners=new Map(),documentListeners=new Map(),captures=new Set(),arcs=[],rings=[],strokes=[],lines=[],curves=[],clicks=[],backdropImages=[],composites=[];let serial=0,observer
  const ctx=new Proxy({createRadialGradient:()=>({addColorStop(){}}),measureText:text=>({width:text.length*7}),arc:(...args)=>{arcs.push(args);if(args[2]>20)rings.push(ctx.globalAlpha)},stroke:()=>strokes.push({width:ctx.lineWidth,color:ctx.strokeStyle}),lineTo:(...args)=>lines.push(args),quadraticCurveTo:(...args)=>curves.push(args)},{get:(target,key)=>target[key]??(()=>{})})
  ctx.drawImage=(...args)=>composites.push(args)
  const decorationContext=new Proxy({createRadialGradient:()=>({addColorStop(){}}),createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),drawImage:(...args)=>backdropImages.push(args)},{get:(target,key)=>target[key]??(()=>{})})
  const document={hidden:false,createElement:()=>({width:0,height:0,getContext:()=>decorationContext}),addEventListener:(name,fn)=>documentListeners.set(name,fn),removeEventListener:name=>documentListeners.delete(name)}
  const canvas={ownerDocument:document,style:{},getContext:()=>ctx,getBoundingClientRect(){if(failBounds)throw Error('detached');return{left:0,top:0,width:1100,height:700}},addEventListener:(n,f)=>listeners.set(n,f),removeEventListener:n=>listeners.delete(n),setPointerCapture:id=>captures.add(id),hasPointerCapture:id=>captures.has(id),releasePointerCapture:id=>captures.delete(id)}
  const window={devicePixelRatio:2,requestAnimationFrame:fn=>{frames.set(++serial,fn);return serial},cancelAnimationFrame:id=>frames.delete(id)}
  const create=runInNewContext(source+';createStarMapRenderer',{window,ResizeObserver:class{constructor(){observer=this}observe(){}disconnect(){this.disconnected=true}}})
  const graph={nodes:[{key:'memory:a',type:'memory',label:'A',record:{id:'a',type:'memory'}},{key:'entity:b',type:'entity',label:'B',record:{id:'b',type:'entity'}}],edges:[{from:'memory:a',to:'entity:b',label:'about',record:{type:'relation',id:'a-b'}}]}
  return{frames,listeners,documentListeners,document,captures,arcs,rings,strokes,lines,curves,clicks,backdropImages,composites,get observer(){return observer},start:()=>create(canvas,{graph:empty?{nodes:[],edges:[]}:graph,reducedMotion,onSelect:record=>clicks.push(record)}),draw(now=0){arcs.length=0;rings.length=0;strokes.length=0;lines.length=0;curves.length=0;for(const[id,fn]of [...frames]){frames.delete(id);fn(now)}},event:(x,y,extra={})=>({pointerId:1,button:0,pointerType:'mouse',clientX:x,clientY:y,...extra})}
}
test('unselected graph displays all business nodes and relationships; lens shares stable pick coordinates',()=>{
  const f=fixture(),renderer=f.start();try{
    f.draw();const nodes=f.arcs.filter(arc=>arc[2]>1);assert.equal(nodes.length,2);assert.equal(f.curves.length,2);const edgeEnd=f.curves[0]
    const [x,y,r]=nodes[0];f.listeners.get('pointermove')(f.event(x,y));f.draw()
    const enlarged=f.arcs.find(arc=>arc[0]===x&&arc[1]===y);assert.ok(enlarged[2]>r)
    f.listeners.get('pointerdown')(f.event(x,y));f.listeners.get('pointerup')(f.event(x,y));assert.equal(f.clicks.length,1)
    f.listeners.get('pointerleave')();f.draw();assert.deepEqual(f.curves[0],edgeEnd);assert.ok(f.arcs.some(arc=>arc[2]>r))
  }finally{renderer.dispose()}
  assert.equal(f.listeners.size,0);assert.equal(f.frames.size,0);assert.equal(f.observer.disconnected,true)
})
test('drag does not activate a node and touch does not retain a hover lens',()=>{
  const f=fixture(),renderer=f.start();try{
    f.draw();const[x,y]=f.arcs.find(arc=>arc[2]>1)
    f.listeners.get('pointerdown')(f.event(x,y));f.listeners.get('pointermove')(f.event(x+20,y));f.listeners.get('pointerup')(f.event(x+20,y));assert.equal(f.clicks.length,0)
    f.listeners.get('pointerdown')(f.event(x,y,{pointerType:'touch'}));renderer.dispose();assert.equal(f.captures.size,0)
  }finally{renderer.dispose()}
})
test('failed canvas startup releases registered input and observers',()=>{
  const f=fixture({failBounds:true});assert.throws(f.start,/detached/);assert.equal(f.listeners.size,0);assert.equal(f.frames.size,0);assert.equal(f.documentListeners.size,0);assert.equal(f.observer.disconnected,true)
})

test('decorative nebula remains visible without records and never opens a record',()=>{
  const f=fixture({empty:true}),renderer=f.start();try{
    f.draw();assert.equal(f.composites.length,1);assert.equal(f.composites[0][0].width,2200);assert.equal(f.composites[0][0].height,1400);assert.ok(f.backdropImages.length>1000);assert.equal(f.frames.size,0)
    f.listeners.get('pointerdown')(f.event(550,350));f.listeners.get('pointerup')(f.event(550,350));assert.deepEqual(f.clicks,[null])
  }finally{renderer.dispose()}
  assert.equal(f.composites[0][0].width,1)
})
test('nebula animation pauses when hidden and releases frames and visibility listeners on close',()=>{
  const f=fixture({reducedMotion:false}),renderer=f.start();try{
    f.draw();assert.equal(f.frames.size,1)
    f.document.hidden=true;f.documentListeners.get('visibilitychange')();assert.equal(f.frames.size,0)
    f.document.hidden=false;f.documentListeners.get('visibilitychange')();assert.equal(f.frames.size,1)
    f.draw(1000);assert.equal(f.composites.length,2)
  }finally{renderer.dispose()}
  assert.equal(f.frames.size,0);assert.equal(f.documentListeners.size,0)
})

test('curved relations open their own record, toggle off, and clear on empty space or external selection reset',()=>{
  const f=fixture(),renderer=f.start();try{
    f.draw();const nodes=f.arcs.filter(arc=>arc[2]>1),curve=f.curves[0]
    const end=nodes.find(node=>Math.abs(node[0]-curve[2])<.01),start=nodes.find(node=>node!==end)
    const x=.25*start[0]+.5*curve[0]+.25*curve[2],y=.25*start[1]+.5*curve[1]+.25*curve[3]
    const click=(x,y)=>{f.listeners.get('pointerdown')(f.event(x,y));f.listeners.get('pointerup')(f.event(x,y))}
    click(x,y);assert.equal(f.clicks.at(-1).type,'relation');assert.equal(f.clicks.at(-1).id,'a-b')
    click(x,y);assert.equal(f.clicks.at(-1),null)
    click(x,y);click(5,5);assert.equal(f.clicks.at(-1),null)
    renderer.select({type:'relation',id:'a-b'});f.draw();assert.ok(f.arcs.some(arc=>arc[2]>20))
    renderer.select(null);f.draw();assert.equal(f.arcs.filter(arc=>arc[2]>20).length,0)
  }finally{renderer.dispose()}
})

test('node selection can be toggled off without losing visible nodes and edges',()=>{
  const f=fixture(),renderer=f.start();try{
    f.draw();const[x,y]=f.arcs.find(arc=>arc[2]>1)
    const click=()=>{f.listeners.get('pointerdown')(f.event(x,y));f.listeners.get('pointerup')(f.event(x,y))}
    click();assert.ok(f.clicks.at(-1));click();assert.equal(f.clicks.at(-1),null);f.draw()
    assert.equal(f.arcs.filter(arc=>arc[2]>1).length,2);assert.equal(f.curves.length,2)
  }finally{renderer.dispose()}
})

test('motion changes the scene but freezes node positions while the pointer inspects it',()=>{
  const f=fixture({reducedMotion:false}),renderer=f.start();try{
    f.draw(0);const first=f.arcs.filter(arc=>arc[2]>1).map(arc=>arc.slice(0,2));f.draw(40)
    assert.notDeepEqual(f.arcs.filter(arc=>arc[2]>1).map(arc=>arc.slice(0,2)),first)
    f.listeners.get('pointermove')(f.event(5,5));f.draw(80);const held=f.arcs.filter(arc=>arc[2]>1).map(arc=>arc.slice(0,2));f.draw(120)
    assert.deepEqual(f.arcs.filter(arc=>arc[2]>1).map(arc=>arc.slice(0,2)),held)
  }finally{renderer.dispose()}
})

for(const record of [{type:'memory',id:'a'},{type:'relation',id:'a-b'}]) {
  test(`${record.type} deselection fades its rings and connected line highlights to the unselected state`,()=>{
    const f=fixture({reducedMotion:false}),renderer=f.start();try{
      f.draw(0);renderer.select(record)
      for(let now=40;now<=400;now+=40)f.draw(now)
      const selectedAlpha=Math.max(...f.rings),selectedWidth=f.strokes[1].width
      assert.ok(selectedAlpha>.5)
      renderer.select(null);f.draw(440)
      const fadingAlpha=Math.max(...f.rings),fadingWidth=f.strokes[1].width
      assert.ok(fadingAlpha>0&&fadingAlpha<selectedAlpha)
      assert.ok(fadingWidth>.7&&fadingWidth<selectedWidth)
      f.draw(480);assert.ok(Math.max(...f.rings)<fadingAlpha)
      for(let now=520;now<=1200;now+=40)f.draw(now)
      assert.equal(f.rings.length,0);assert.ok(Math.abs(f.strokes[1].width-.7)<.001)
      assert.equal(f.arcs.filter(arc=>arc[2]>1).length,2);assert.equal(f.curves.length,2)
    }finally{renderer.dispose()}
  })
  test(`${record.type} selection retains drag inertia and settles without resuming automatic rotation`,()=>{
    const f=fixture({reducedMotion:false}),renderer=f.start();try{
      const location=()=>f.arcs.find(arc=>arc[2]>1&&arc[2]<20).slice(0,2)
      const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1])
      f.draw(0);renderer.select(record);f.draw(40);const held=location();f.draw(80);assert.deepEqual(location(),held)
      f.listeners.get('pointerdown')(f.event(5,5));f.listeners.get('pointermove')(f.event(25,13));f.draw(120)
      const released=location();f.listeners.get('pointerup')(f.event(25,13));f.draw(160);const first=location();f.draw(200)
      assert.ok(distance(released,first)>.1);assert.ok(distance(first,location())<distance(released,first));assert.equal(f.clicks.length,0)
      for(let now=240;now<=4000;now+=40)f.draw(now)
      const settled=location();f.draw(4040);assert.ok(distance(settled,location())<.001);assert.ok(f.rings.length>0)
    }finally{renderer.dispose()}
  })
}
