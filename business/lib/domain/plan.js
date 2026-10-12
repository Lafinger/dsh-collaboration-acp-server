export function isActive(plan) {
    return plan.activatedAt !== null;
}
/**
 * Compute the gate from the slots.
 *
 * A role counts as agreed only if it has a non-voided `agree` slot. Rejection is reported
 * separately: it blocks just as hard as silence, but it is a different fact and a caller
 * needs to be able to tell "nobody looked" from "someone objected".
 */
export function gateStateOf(relevantRoles, slots, memberOf) {
    const live = slots.filter((s) => s.voidedAt === null);
    const agreed = [];
    const rejected = [];
    const pending = [];
    const vacancies = [];
    for (const role of relevantRoles) {
        const slot = live.find((s) => s.role === role);
        if (slot === undefined || slot.outcome === null) {
            pending.push(role);
            if (memberOf(role) === null)
                vacancies.push(role);
        }
        else if (slot.outcome === 'agree') {
            agreed.push(role);
        }
        else {
            rejected.push(role);
        }
    }
    if (pending.length === 0 && rejected.length === 0) {
        return { kind: 'unanimous', agreed };
    }
    return { kind: 'waiting', pending, vacancies, rejected };
}
