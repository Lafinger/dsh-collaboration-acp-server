// Run with the installed Electron in Node mode so its bundled YAML parser is available.
// Only CODEGO_API_KEY is read into memory. Secret travels on stdin, never argv/stdout/image.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const docker='C:/Users/cjh13/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe';
const yaml=require('C:/Users/cjh13/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/js-yaml');
const container='dsh-collaboration-linux-sim';
const privateDir=path.resolve(process.cwd(),'.dsh/docker-linux-sim');
if(!fs.existsSync(privateDir))throw new Error('Create private directory and restrict its Windows ACL first');
function run(exe,args,input){const result=cp.spawnSync(exe,args,{input,stdio:input===undefined?'inherit':['pipe','inherit','inherit']});if(result.error)throw result.error;if(result.status!==0)throw new Error('Provision command failed; no automatic credential overwrite');}
for(const account of ['alice','bob']){
 const key=path.join(privateDir,account+'_ed25519');
 if(!fs.existsSync(key))run('C:/Windows/System32/OpenSSH/ssh-keygen.exe',['-q','-t','ed25519','-N','','-C',`docker-linux-sim-${account}`,'-f',key]);
 if(!fs.existsSync(key+'.pub'))throw new Error('Existing key has no public half; refuse replacement');
 run(docker,['cp',key+'.pub',`${container}:/srv/collaboration/ssh/${account}.pub`]);
}
let source;
try { source=yaml.load(fs.readFileSync('C:/Users/cjh13/.dsh/.credentials.yaml','utf8')); }
catch { throw new Error('Cannot parse source credential store; contents are redacted'); }
const secret=source?.refs?.CODEGO_API_KEY;
if(typeof secret!=='string'||!secret.trim())throw new Error('Codego credential reference is not a portable configured key');
const document=JSON.stringify({version:1,refs:{CODEGO_API_KEY:secret}})+'\n';
const code="const f=require('node:fs'),p='/srv/collaboration/dsh-home/.credentials.yaml';let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>text+=x);process.stdin.on('end',()=>{f.writeFileSync(p,text,{mode:0o600,flag:'wx'});f.chownSync(p,1101,1101);f.chmodSync(p,0o600);console.log('Single Codego credential provisioned privately');});";
run(docker,['exec','-i',container,'node','-e',code],document);
const host=cp.spawnSync(docker,['exec',container,'node','-e',"process.stdout.write(require('node:fs').readFileSync('/srv/collaboration/ssh/ssh_host_ed25519_key.pub','utf8'));"],{encoding:'utf8'});
if(host.error)throw host.error;if(host.status!==0)throw new Error('Cannot retrieve trusted container host PUBLIC key');
const publicKey=host.stdout.trim().split(/\s+/).slice(0,2).join(' ');if(!/^ssh-ed25519 [A-Za-z0-9+/=]+$/.test(publicKey))throw new Error('Invalid host public key');
const hosts={local:'127.0.0.1',lan:'192.168.2.27',zerotier:'10.242.14.211'};
fs.writeFileSync(path.join(privateDir,'known_hosts'),Object.values(hosts).map(ip=>`[${ip}]:22222 ${publicKey}`).join('\n')+'\n');
for(const account of ['alice','bob'])for(const[label,host]of Object.entries(hosts)){
 const config={serviceId:'docker-linux-sim',databasePath:path.join(privateDir,`${account}-${label}-client.sqlite`),ssh:{host,port:22222,account,identityFile:path.join(privateDir,account+'_ed25519'),knownHostsFile:path.join(privateDir,'known_hosts'),sshExecutable:'C:/Windows/System32/OpenSSH/ssh.exe'}};
 fs.writeFileSync(path.join(privateDir,`${account}-${label}.local.json`),JSON.stringify(config,null,2)+'\n');
}
console.log('Dedicated member keys/configs and strict known_hosts generated; no desktop profile modified');
