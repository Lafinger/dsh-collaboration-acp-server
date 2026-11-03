import {createHash} from 'node:crypto';

/** Shared original administrator/decision fingerprint, including monotonic A→B→A revision. */
export function projectRoleRevision(identities,projects,projectId){
  const roles=projects.getWithRoles(projectId).roles;
  // Qualification is not a role assignment: a revoked historical slot must not change
  // every healthy recipient's notice key. Member/peer revisions and explicit role
  // fences invalidate their decision contexts; an administrator's acknowledgement
  // still bumps the monotonic assignment revision, including same-account restoration.
  const value=[projectId,identities.db.prepare('SELECT revision FROM mvp_project_revisions WHERE project_id=?').get(projectId)?.revision??1,roles];
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
