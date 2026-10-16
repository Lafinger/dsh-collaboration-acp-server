import {fileURLToPath} from 'node:url';
import {renderProfile} from './render-profile.mjs';

/** Temporary real-host PC identity probe. Existing backend/data/profile stay untouched. */
export function renderMvpProbeProfile(release){
 if(!/^\/opt\/dsh-collaboration-test\/mvp-candidates\/[a-f0-9]{40}\/runtime$/.test(release))throw Error('Exact verified MVP candidate runtime required');
 // Reuse the pinned official host composition/CPA route; only the isolated profile's gate and paths change.
 const entries=JSON.parse(renderProfile('/opt/dsh-collaboration-test/releases/'+'a'.repeat(40)))[0].insert;
 const home='/srv/dsh-collaboration-test/mvp-pc-probe/dsh-home';
 for(const entry of entries){
  if(entry.id==='attachments')entry.config.dshHome=home;
  if(entry.id==='session-persistence')entry.config.root=home+'/sessions';
  if(entry.id==='model-request-gate')entry.name=release+'/mvp-probe-gate.mjs';
  if(entry.id==='collaboration-server-mount')entry.name=release+'/mvp-probe-mount.mjs';
 }
 // Credential provider keeps its existing private file read-only. No CPA key copied into probe configuration.
 return JSON.stringify([{insert:entries}],null,2)+'\n';
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 if(process.argv.length!==3)throw Error('Usage: node mvp-probe-profile.mjs /opt/dsh-collaboration-test/mvp-candidates/<SHA>/runtime');
 process.stdout.write(renderMvpProbeProfile(process.argv[2]));
}
