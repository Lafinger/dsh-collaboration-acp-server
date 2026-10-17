import {createHash} from 'node:crypto';

/** Shared original administrator/decision fingerprint, including monotonic A→B→A revision. */
export function projectRoleRevision(identities,projects,projectId){
  return createHash('sha256').update(JSON.stringify([projectId,identities.db.prepare('SELECT revision FROM mvp_project_revisions WHERE project_id=?').get(projectId)?.revision??1,projects.getWithRoles(projectId).roles])).digest('hex');
}
