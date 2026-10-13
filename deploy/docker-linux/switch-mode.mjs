// Docker administrator only. Does not reset counters, copy credentials, or replay work.
import { readFileSync, writeFileSync, renameSync, chmodSync, chownSync } from 'node:fs';
const target='/srv/collaboration/private-state/mode.json';
const mode=process.argv[2];if(!['acceptance','daily'].includes(mode))throw new Error('Choose acceptance or daily explicitly');
const previous=JSON.parse(readFileSync(target,'utf8'));
writeFileSync(`${target}.tmp`,JSON.stringify({mode,previousMode:previous.mode,changedAt:new Date().toISOString()},null,2),{mode:0o600});
chownSync(`${target}.tmp`,1101,1101);chmodSync(`${target}.tmp`,0o600);renameSync(`${target}.tmp`,target);
console.log(JSON.stringify({mode,countsReset:false,dailyExtraRequestTimeTokenLimits:false}));
