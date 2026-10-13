import {spawnSync} from 'node:child_process';
import {readdirSync,mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join,resolve} from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
function run(args){const r=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit',env:{...process.env,COLLABORATION_OFFICIAL_NODE_MODULES:''}});if(r.error)throw r.error;if(r.status!==0)throw new Error(`Check exited ${r.status}: ${args.join(' ')}`);}
function scan(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())scan(p);else if(e.name.endsWith('.mjs'))run(['--check',p]);}}
for(const dir of ['bin','src','scripts','test'])scan(join(root,dir));
const tsc='node_modules/typescript/bin/tsc';
run([tsc,'-p','business/tsconfig.json','--noEmit']);run(['scripts/check-build.mjs']);
run([tsc,'-p','business/tsconfig.test.json','--noEmitOnError']);run(['--test','business/lib-test/**/*.test.js']);
run(['--test','--test-timeout=15000','test/*.test.mjs']);run(['--test','--test-timeout=15000','test/*.integration.mjs']);run(['scripts/audit.mjs']);run(['scripts/check-naming.mjs']);
if(readdirSync(root).includes('deploy'))run(['deploy/docker-linux/check-deploy.mjs']);
mkdirSync(join(root,'.dsh/evidence'),{recursive:true});writeFileSync(join(root,'.dsh/evidence/check.json'),JSON.stringify({result:'PASS',node:process.version,independentDependencies:true,realSshTested:false,guiTested:false,timestamp:new Date().toISOString()},null,2));
