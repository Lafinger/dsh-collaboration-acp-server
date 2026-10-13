/**
 * Project identity and lifecycle.
 *
 * MVP-001: name, short id, background and goal. Unfilled background/goal stay absent —
 * they are NEVER invented.
 * MVP-005: archiving stops writes but keeps everything readable.
 */
import { CollaborationError } from './error.js';
export function isArchived(project) {
    return project.archivedAt !== null;
}
/**
 * The single archive gate (MVP-005).
 *
 * "归档后业务只读，不再接受新的资料、方案、任务或成果写入" — so EVERY write path must ask
 * this question, and each service answering it separately is how a path gets missed: three of
 * five write paths originally had no check at all, and an archived project happily accepted a
 * new analysis, progress note and result.
 *
 * Kept here rather than in a service because the rule belongs to the project, not to whichever
 * service happens to be writing.
 */
export function assertWritable(project, projectId) {
    if (project === null) {
        throw new CollaborationError('PROJECT_NOT_FOUND', `no project with id ${projectId}`, {
            id: projectId,
        });
    }
    if (isArchived(project)) {
        throw new CollaborationError('PROJECT_ARCHIVED', `project "${project.key}" is archived`, {
            id: projectId,
            key: project.key,
        });
    }
    return project;
}
/** Fields the MVP deliberately leaves blank rather than guessing at. */
export function pendingFields(project) {
    const missing = [];
    if (project.background === null || project.background.trim() === '')
        missing.push('background');
    if (project.goal === null || project.goal.trim() === '')
        missing.push('goal');
    return missing;
}
/**
 * The single eligibility gate for acting AS a role (MVP-019, ADR-0014).
 *
 * MVP-019: a plan is confirmed "由该角色的成员". Before this, the code only asked whether the
 * SLOT had a member and then accepted any name the caller passed — so an agent that had been
 * told nothing invented nine members and every role confirmed itself. The requirement was
 * effectively unimplemented.
 *
 * Deliberately ONE function, for the same reason `assertWritable` is one function (ADR-0013):
 * the rule is asked in three places (`plan_confirm`, `result_review`, `result_accept`) and a
 * rule with three copies has three chances to disagree.
 *
 * Both failure modes are reported with an actionable next step, because a model that cannot see
 * why it failed tends to invent an answer or retry blindly — which is how the fabricated
 * members happened in the first place.
 *
 * NOT applied to `todo_mark_read`: MVP-030 records reads BY ROLE SLOT, and a read changes no
 * business state. NOT applied to uploads/registrations either — the nine roles are equal
 * (ADR-0004), so requiring an identity there would invent a permission the MVP does not have.
 */
export function assertCanActAsRole(input) {
    const { role, memberOfRole, declaredMember } = input;
    if (declaredMember === null) {
        throw new CollaborationError('MEMBER_NOT_DECLARED', `this session has not declared who it is, so it cannot act as role "${role}"; ` +
            `declare a member first (session_declare_member), then decide again`, { role });
    }
    if (memberOfRole === null) {
        throw new CollaborationError('VACANT_ROLE_CANNOT_CONFIRM', `role "${role}" has no member, so it cannot decide; ` +
            `assign a member to the role (project_set_role_member), then decide again`, { role });
    }
    if (memberOfRole !== declaredMember) {
        throw new CollaborationError('NOT_ROLE_MEMBER', `role "${role}" belongs to "${memberOfRole}", but this session declared itself as ` +
            `"${declaredMember}"; either declare as "${memberOfRole}", or reassign the role to ` +
            `"${declaredMember}" (project_set_role_member)`, { role, memberOfRole, declaredMember });
    }
    return declaredMember;
}
