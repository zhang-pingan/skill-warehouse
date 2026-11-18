/** Run each fixed coverage case in its own profile so on-demand history cannot import earlier cases. */
import {spawn} from 'node:child_process'
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import path from 'node:path'
import {digest,loadJson,sourceManifest} from './fixture.js'
const [configPath,outputPath,rawRepeat]=process.argv.slice(2),repeat=Number(rawRepeat),out=path.resolve(outputPath)
if(!Number.isInteger(repeat)||repeat<0||repeat>2)throw new Error('Specify repeat 0, 1 or 2')
mkdirSync(out,{recursive:true})
const protocol=loadJson('autonomy-cases.json'),source=sourceManifest()
writeFileSync(path.join(out,'batch-manifest.json'),JSON.stringify({startedAt:new Date().toISOString(),repeat,source,
 isolation:'One independent supported profile and HOME per case; three concurrent repetition lanes. No other case sessions are available to imports.',
 cases:protocol.cases.map(c=>c.id),runnerSha256:digest(readFileSync(new URL(import.meta.url)))},null,2)+'\n',{flag:'wx'})
const rows=[]
for(const item of protocol.cases){
 const output=path.join(out,item.id)
 const code=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[new URL('run-autonomy.js',import.meta.url).pathname,configPath,output,`case:${item.id}:${repeat}`],{stdio:'inherit'});child.once('error',reject);child.once('exit',resolve)})
 rows.push({caseId:item.id,exitCode:code,summary:JSON.parse(readFileSync(path.join(output,'summary.json'),'utf8'))})
 if(sourceManifest().sha256!==source.sha256)throw new Error('Production source changed during batch')
}
writeFileSync(path.join(out,'batch-summary.json'),JSON.stringify({completedAt:new Date().toISOString(),sourceUnchanged:sourceManifest().sha256===source.sha256,rows},null,2)+'\n',{flag:'wx'})
