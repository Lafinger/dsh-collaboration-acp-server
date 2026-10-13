import assert from 'node:assert/strict';import{readFileSync,readdirSync}from'node:fs';import{dirname,join,resolve}from'node:path';import{fileURLToPath}from'node:url';import{spawnSync}from'node:child_process';
const root=dirname(fileURLToPath(import.meta.url));
function run(args){const r=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit'});if(r.error)throw r.error;assert.equal(r.status,0,'Deployment check failed');}
for(const e of readdirSync(root))if(/\.(?:mjs|cjs)$/.test(e))run(['--check',e]);
run(['--test','acceptance-policy.test.mjs','reset-state.test.mjs']);
const read=name=>readFileSync(join(root,name),'utf8');const compose=read('compose.yaml'),docker=read('Dockerfile'),ignore=read('.dockerignore'),sshd=read('sshd_config'),profile=read('profile.patch.yml');
assert.match(read('package.json'),/github:Lafinger\/dsh-collaboration-acp-server#v0\.4\.2/,'Deploy fixed release only');
assert.match(compose,/image: dsh-collaboration-linux-sim:0\.4\.2/);assert.match(compose,/cpus: 2\.0/);assert.match(compose,/mem_limit: 2g/);assert.match(compose,/restart: unless-stopped/);assert.match(compose,/no-new-privileges:true/);assert.match(compose,/\/tmp:rw,exec,nosuid,nodev/);
for(const line of ['127.0.0.1:22222:22','192.168.2.27:22222:23','10.242.14.211:22222:24'])assert.ok(compose.includes(line));assert.ok(!compose.includes('0.0.0.0:22222'));assert.ok(!compose.includes('docker.sock'));
assert.match(docker,/^FROM node:24\.21\.0-bookworm-slim@sha256:[0-9a-f]{64}/);assert.match(docker,/--frozen-lockfile --ignore-scripts/);assert.match(docker,/collaboration-members/);assert.ok(!/privileged/.test(compose));
assert.equal(ignore.split(/\r?\n/)[0],'*');assert.ok(!ignore.includes('!provision'));assert.ok(!ignore.includes('!.dsh'));assert.match(ignore,/!reset-state\.mjs/);
assert.match(sshd,/ForceCommand .*connector-cli\.mjs/);assert.match(sshd,/PasswordAuthentication no/);assert.match(sshd,/PermitRootLogin no/);assert.match(sshd,/AllowUsers alice bob/);
assert.match(profile,/deepseek-v4\.1-flash/);assert.ok(!/llm-retry|subagent|dsh-web-app/.test(profile));
for(const file of ['readme.md','README.md']){if(file!=='README.md')continue;for(const m of read(file).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)){const link=m[1].replace(/^<|>$/g,'').split('#')[0];if(!link||/^https?:/.test(link))continue;const target=resolve(root,link);assert.ok(readdirSync(dirname(target)).includes(target.slice(target.lastIndexOf(process.platform==='win32'?'\\':'/')+1)),`Broken deployment link ${link}`);}}
console.log(JSON.stringify({deploymentSourceCheck:'PASS',realModelCalls:false,productionDataChanged:false}));
