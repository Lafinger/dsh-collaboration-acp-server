import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const english=['work','bench'].join('');
const chinese=[['项目','工作台'].join(''),['项目管理','工作台'].join('')];
const obsolete=new RegExp(`${english}|${chinese.join('|')}`,'i');
// Exact immutable historical artifacts, not a blanket exclusion of documentation.
const historic=new Set(['PROVENANCE.json','docs/GITHUB-RELEASE-VERIFY.md']);
const ignored=new Set(['.git','.dsh','node_modules','lib-test']);
const sourceOriginFiles=new Set(['README.md','docs/SPLIT.md','business/docs/具体核心实现.md','business/docs/协作服务需求文档MVP/ACP独立运行时方案.md']);
const findings=[],exceptions=[];
function walk(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){
 if(ignored.has(entry.name)||entry.isSymbolicLink())continue;
 const path=join(dir,entry.name),rel=relative(root,path).replaceAll('\\','/');
 if(obsolete.test(entry.name))findings.push({path:rel,kind:'obsolete filename'});
 if(entry.isDirectory()){walk(path);continue;}
 if(!/\.(?:mjs|cjs|js|ts|md|json|yml|yaml|ps1|sh)$/.test(entry.name)&&!['Dockerfile','.dockerignore','.gitignore'].includes(entry.name))continue;
 const text=readFileSync(path,'utf8');
 if(historic.has(rel)||rel.startsWith('docs/history/')||rel==='deploy/docker-linux/VERIFY-LEGACY-v0.2.0.md'){
  if(obsolete.test(text))exceptions.push({path:rel,reason:'immutable historical source/release evidence'});continue;
 }
 for(const[line,textLine]of text.split(/\r?\n/).entries()){
  let current=textLine;
  if(sourceOriginFiles.has(rel))current=current.replace(new RegExp(`dsh-project-${english}`,'g'),'historical-source');
  // The approved Windows workspace is not renamed; only actual absolute Desktop paths qualify.
  current=current.replace(new RegExp(`Desktop(?:[/\\\\]+)${chinese[1]}`,'g'),'Desktop/actual-workspace');
  if(obsolete.test(current))findings.push({path:rel,line:line+1,kind:'obsolete current name'});
  else if(obsolete.test(textLine))exceptions.push({path:rel,line:line+1,reason:'real historical repository or actual host path'});
 }
}}
walk(root);
console.log(JSON.stringify({currentNaming:findings.length?'FAIL':'PASS',historicalAndHostPathExceptions:exceptions,findings},null,2));
if(findings.length)process.exitCode=1;
