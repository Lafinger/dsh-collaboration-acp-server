import {createHash} from 'node:crypto';

/** Shared original administrator/decision fingerprint, including monotonic A→B→A revision. */
export function projectRoleRevision(identities,projects,projectId){
  const roles=projects.getWithRoles(projectId).roles;
  const value=[projectId,identities.db.prepare('SELECT revision FROM mvp_project_revisions WHERE project_id=?').get(projectId)?.revision??1,roles];
  const blocked=roles.filter(slot=>slot.member&&identities.roleNeedsReassignment?.(slot.member,projectId,slot.role)).map(slot=>slot.role);
  // Preserve existing fingerprints until an actual organization revocation blocks a role.
  if(blocked.length)value.push(blocked);
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
