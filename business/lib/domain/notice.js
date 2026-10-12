export const TODO_KINDS = [
    'plan_confirmation',
    'result_review',
    'result_acceptance',
];
export const NOTICE_KINDS = ['result_rejected', 'task_completed'];
export function isTodoKind(kind) {
    return TODO_KINDS.includes(kind);
}
/** `kind:objectId:version:role:taskId` — one string, so it can be a primary key. */
export function slotKey(ref) {
    return [ref.kind, ref.objectId, ref.version, ref.role, ref.taskId ?? ''].join(':');
}
export function unreadOf(pending, read, member) {
    if (member === null)
        return 0;
    return Math.max(0, pending - read);
}
