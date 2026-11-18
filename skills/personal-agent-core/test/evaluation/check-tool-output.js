/** Compare canonical tool output validation using production reads and the owning Harness pipeline. */
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdirSync,writeFileSync} from 'node:fs'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {TOOL} from '../../index.js'
import {fixture} from '../helpers.js'
const [checkout,output]=process.argv.slice(2)
if(!checkout||!output)throw new Error('Usage: check-tool-output.js CHECKOUT NEW_OUTPUT_DIRECTORY')
const require=createRequire(path.join(checkout,'packages/test-support/tool-testkit/package.json'))
const load=specifier=>import(pathToFileURL(require.resolve(specifier)))
const [{Context},{default:Tools},{default:SystemPrompt},{executeToolFixture}]=await Promise.all([
 load('@deepseek-ai/cordis'),load('@deepseek-ai/dsh-tools'),load('@deepseek-ai/dsh-system-prompt'),import(pathToFileURL(path.join(checkout,'packages/test-support/tool-testkit/lib/index.js')))
])
const candidate={oneOf:[{type:'object',additionalProperties:true},{type:'array',items:{type:'object',additionalProperties:true}},{type:'null'}]}
const f=fixture(),rows=[]
const {PersonalAgentService}=await import('../../lib/service.js')
const service=new PersonalAgentService(f.config);await service.initialize()
try{
 const task=service.ledger.createTask({objective:'Output protocol test',acceptance:['Only valid JSON results']})
 for(const [variant,schema] of [['object-only',{type:'object',additionalProperties:true}],['candidate',candidate],['production',TOOL.output.schema]]){
  const ctx=new Context()
  try{
   await ctx.plugin(SystemPrompt);await ctx.plugin(Tools)
   const dispose=ctx.tools.register({...TOOL,output:{...TOOL.output,schema},execute:args=>service.operate(args,{actor:'agent'})})
   try{
    for(const [action,args,nullable] of [['list_steps',{taskId:task.taskId},true],['get_task',{taskId:'missing'},true],['memory_get',{memoryId:'missing'},true],['get_task',{taskId:task.taskId},false]]){
     const result=await executeToolFixture(ctx,{callId:variant+'-'+action+String(nullable),name:TOOL.name,arguments:{action,...args},signal:new AbortController().signal})
     assert.equal(result.isError,variant==='object-only'&&nullable)
     if(!result.isError){assert.deepEqual(JSON.parse(result.content[0].text),result.value);if(action==='list_steps')assert.deepEqual(result.value,[]);if(args.taskId==='missing'||args.memoryId==='missing')assert.equal(result.value,null)}
     rows.push({variant,action,args,isError:result.isError,...result.isError?{error:result.content}:{value:result.value}})
    }
   }finally{dispose()}
  }finally{await ctx.fiber.dispose()}
 }
 mkdirSync(output,{recursive:true});writeFileSync(path.join(output,'results.json'),JSON.stringify({recordedAt:new Date().toISOString(),schema:candidate,checks:rows.length,rows},null,2)+'\n',{flag:'wx'})
 console.log(JSON.stringify({checks:rows.length,passed:true,output}))
}finally{await service.dispose();f.close()}
