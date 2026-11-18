/** Archive frozen evaluator inputs and native logs after an isolated run has exited. */
import { access, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { digest } from './fixture.js'
const exec=promisify(execFile), out=path.resolve(process.argv[2])
const exists=async file=>{try{await access(file);return true}catch(error){if(error.code==='ENOENT')return false;throw error}}
const native=await exists(path.join(out,'manifest.json'))
const manifest=JSON.parse(await readFile(path.join(out,native?'manifest.json':'model-manifest.json'),'utf8'))
const summary=JSON.parse(await readFile(path.join(out,native?'summary.json':'model-summary.json'),'utf8'))
if(!summary.completedAt)throw new Error('Run must finish before archival')
const root=summary.sessionLogRoot
if(!root || await exists(path.join(root,'harness-home','.credentials.yaml')))throw new Error('Run credential remains or session root is missing')
for(const [file,hash] of Object.entries(manifest.evaluationTools)) if(digest(await readFile(path.join(import.meta.dirname,file)))!==hash)throw new Error(`Evaluator changed before archival: ${file}`)
for(const archive of ['evaluation-source.tar.gz','native-sessions.tar.gz'])if(await exists(path.join(out,archive)))throw new Error(`Archive already exists: ${archive}`)
await exec('tar',['-czf',path.join(out,'evaluation-source.tar.gz'),'-C',import.meta.dirname,...Object.keys(manifest.evaluationTools)])
await exec('tar',['-czf',path.join(out,'native-sessions.tar.gz'),'-C',path.join(root,'harness-home'),'sessions'])
if(await exists(path.join(root,'codex-sessions')))await exec('tar',['-czf',path.join(out,'codex-sessions.tar.gz'),'-C',root,'codex-sessions'])
const cleanup={recordedAt:new Date().toISOString(),temporaryCredentialsRemoved:true,evaluationToolsMatchFrozenManifest:true,processExit:summary.cleanup??null,
  archives:Object.fromEntries(await Promise.all(['evaluation-source.tar.gz','native-sessions.tar.gz','codex-sessions.tar.gz'].map(async file=>[file,await exists(path.join(out,file))?digest(await readFile(path.join(out,file))):null])))}
await writeFile(path.join(out,'cleanup.json'),JSON.stringify(cleanup,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify(cleanup))
