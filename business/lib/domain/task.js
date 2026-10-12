export function isCancelled(task) {
    return task.cancelledAt !== null;
}
export function isCompleted(task) {
    return task.completedAt !== null;
}
/**
 * A task that can no longer be changed.
 *
 * Both terminal states freeze the definition, for the same reason: the record of what was
 * asked must not move under the feet of what was delivered. Restoring means creating a NEW
 * task, not un-cancelling or un-completing this one.
 */
export function isFrozen(task) {
    return isCancelled(task) || isCompleted(task);
}
export function frozenReason(task) {
    if (isCancelled(task))
        return 'cancelled';
    if (isCompleted(task))
        return 'completed';
    return null;
}
