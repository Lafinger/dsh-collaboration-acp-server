/** Whether this acceptance was actually decided, as opposed to still open. */
export function isDecided(a) {
    return a.outcome !== null;
}
export function isAcceptanceDecided(a) {
    return a.outcome !== null;
}
/**
 * Whether a task's latest result has been confirmed complete.
 *
 * Completion is a CONSEQUENCE of confirmation, never of submission (MVP-025).
 */
export function isConfirmedComplete(results) {
    return results.confirmation?.outcome === 'complete';
}
