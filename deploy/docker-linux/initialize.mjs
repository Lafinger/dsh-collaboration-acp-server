import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, chownSync, copyFileSync, symlinkSync, lstatSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
const root = '/srv/collaboration', uid = 1101, members = 1100;
const dir = (path, mode, owner = 0, group = 0) => { mkdirSync(path, { recursive: true, mode }); chownSync(path, owner, group); chmodSync(path, mode); };
const file = (path, content, mode, owner = 0, group = 0) => { writeFileSync(path, content, { mode }); chownSync(path, owner, group); chmodSync(path, mode); };
dir(root, 0o755); dir(join(root, 'dsh-home'), 0o700, uid, uid); dir(join(root, 'dsh-home/sessions'), 0o700, uid, uid);
dir(join(root, 'private-state'), 0o700, uid, uid); dir(join(root, 'workspace'), 0o700, uid, uid); dir(join(root, 'ssh'), 0o700);
// setgid: socket inherits the access group without granting parent write.
dir('/run/collaboration', 0o2750, uid, members);
dir('/run/sshd', 0o755); dir('/etc/collaboration-access', 0o755);
dir('/etc/collaboration-access/connectors', 0o755); dir('/etc/ssh/authorized_keys', 0o755);
const configPath = join(root, 'dsh-home/collaboration-acp-server.json');
let config;
if (existsSync(configPath)) {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (config.serviceId !== 'docker-linux-sim' || config.provider !== 'codego' || config.model !== 'deepseek-v4.1-flash') throw new Error('Refuse unrelated existing simulator configuration');
} else {
  config = { serviceId: 'docker-linux-sim', workspace: join(root, 'workspace'), stateRoot: join(root, 'private-state'), socketPath: '/run/collaboration/service.sock', provider: 'codego', model: 'deepseek-v4.1-flash', accounts: { alice: randomBytes(48).toString('hex'), bob: randomBytes(48).toString('hex') } };
  file(configPath, JSON.stringify(config, null, 2), 0o600, uid, uid);
}
for (const [account, gid] of [['alice', 1102], ['bob', 1103]]) {
  file(`/etc/collaboration-access/connectors/${account}.json`, JSON.stringify({ account, serviceId: config.serviceId, secret: config.accounts[account], socketPath: config.socketPath }), 0o440, 0, gid);
  const publicPath = join(root, `ssh/${account}.pub`);
  if (existsSync(publicPath)) {
    const key = readFileSync(publicPath, 'utf8').trim(); if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: .*?)?$/.test(key)) throw new Error('Invalid member public key');
    file(`/etc/ssh/authorized_keys/${account}`, `restrict ${key}\n`, 0o644);
  }
}
const modePath = join(root, 'private-state/mode.json'); if (!existsSync(modePath)) file(modePath, JSON.stringify({ mode: 'acceptance' }), 0o600, uid, uid);
dir(join(root, 'dsh-home/profiles'), 0o700, uid, uid);
const profile = join(root, 'dsh-home/profiles/collaboration-server'); dir(profile, 0o700, uid, uid);
for (const [source, target] of [['host-profile.json', 'package.json'], ['profile.patch.yml', 'cordis.patch.yml']]) {
  copyFileSync(`/opt/collaboration/${source}`, join(profile, target)); chmodSync(join(profile, target), 0o600); chownSync(join(profile, target), uid, uid);
}
const modules = join(profile, 'node_modules');
if (!existsSync(modules)) symlinkSync('/opt/collaboration/node_modules', modules);
else if (!lstatSync(modules).isSymbolicLink()) throw new Error('Unexpected profile modules directory');
console.log('Simulator paths/accounts initialized; no credential values printed');
