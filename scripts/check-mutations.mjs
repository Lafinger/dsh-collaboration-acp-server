import {spawnSync}from'node:child_process';
import {mkdirSync,writeFileSync,openSync,closeSync,readFileSync}from'node:fs';
import {fileURLToPath}from'node:url';import{dirname,resolve,join}from'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');mkdirSync(join(root,'.dsh/evidence'),{recursive:true});
const cases=[['owner-check','test/access.test.mjs'],['request-replay','test/access.test.mjs'],['forged-snapshot','test/dsh.integration.mjs'],['mutable-identity','test/dsh.integration.mjs']];
for(const[name,file]of cases){const log=join(root,'.dsh/evidence',`mutation-${name}.log`);const fd=openSync(log,'w');const r=spawnSync(process.execPath,['--import','./scripts/mutation-hook.mjs','--test',file],{cwd:root,stdio:['ignore',fd,fd],env:{...process.env,WORKBENCH_MUTATION:name}});closeSync(fd);if(r.error)throw r.error;const text=readFileSync(log,'utf8');if(r.status!==1||!text.includes('AssertionError'))throw new Error(`Mutation not rejected by assertion: ${name} (${r.status})`);console.log(`DETECTED ${name}`);}
