/**
 * Plan confirmation (M4). The MVP's only gate.
 *
 * The rule is one sentence: every relevant role must agree, and until it does, nothing
 * happens. Everything below exists to keep that sentence true under pressure:
 *
 *   - A confirmation belongs to a ROLE, never to a person. One person holding two roles
 *     must submit twice, or "all roles agreed" would be vacuously satisfiable.
 *   - A vacant role WAITS. It never passes, and no other role may stand in for it.
 *   - Activation happens in ONE transaction, so there is no half-active plan.
 *   - A revision VOIDS prior confirmations rather than deleting them. The history of what
 *     was agreed before the change is what makes the change auditable.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { ProjectId } from '../domain/project.js';
import { type ConfirmInput, type ConfirmationSlot, type GateState, type Plan, type PlanId, type PlannedTask, type PlanWithSlots, type RegisterPlanInput, type RevisePlanInput } from '../domain/plan.js';
import { type Clock } from './project-service.js';
/**
 * What the plan layer needs from the task layer: apply this plan's proposals.
 *
 * Declared structurally so `plan-service` does not import `task-service`, avoiding a cycle
 * while still letting the plan layer drive task creation.
 */
export interface TaskActivator {
    applyActivation(plan: Plan): unknown;
    /** Project id owning a task, or null if there is no such task. Used to validate deps. */
    findTask(taskId: string): string | null;
}
export declare class PlanService {
    private readonly db;
    private readonly clock;
    /**
     * Turns this plan's proposals into real tasks at activation (ADR-0009).
     *
     * Injected rather than constructed here so the direction of dependency stays one-way:
     * the plan layer drives task creation, the task layer knows nothing about plans.
     * Optional so the M4 tests that predate tasks keep working unchanged.
     */
    private readonly tasks;
    private readonly plans;
    private readonly projects;
    constructor(db: DatabaseSync, clock?: Clock,
    /**
     * Turns this plan's proposals into real tasks at activation (ADR-0009).
     *
     * Injected rather than constructed here so the direction of dependency stays one-way:
     * the plan layer drives task creation, the task layer knows nothing about plans.
     * Optional so the M4 tests that predate tasks keep working unchanged.
     */
    tasks?: TaskActivator | null);
    /**
     * Register a plan from an analysis.
     *
     * Dependency cycles are rejected HERE, at registration, before any confirmation has been
     * collected — which is the cheapest possible moment to find them (MVP-017).
     */
    register(input: RegisterPlanInput): PlanWithSlots;
    /**
     * Revise a plan into a NEW version.
     *
     * Allowed at any time, including with confirmations already collected (MVP-021):
     * forbidding it while the gate is open would freeze the plan exactly when it most needs
     * correcting. The cost is that every prior confirmation is voided.
     */
    revise(input: RevisePlanInput): PlanWithSlots;
    /**
     * Record one role's decision on the latest version.
     *
     * MVP-019 says a plan is confirmed "由该角色的成员" — by THAT ROLE'S MEMBER. So this asks two
     * things, not one: that the role has a member, AND that the caller IS that member (ADR-0014).
     *
     * `submittedBy` remains a snapshot for the record, but it must agree with what the session
     * declared. Keeping the parameter while checking it stops a caller from silently recording a
     * decision under a name it invented, which is exactly how nine fabricated members once
     * confirmed a nine-role plan.
     */
    confirm(input: ConfirmInput): PlanWithSlots;
    /**
     * Close the gate: mark the plan active and record the formal plan.
     *
     * MUST run inside the caller's transaction. Splitting any part of this out would create
     * the half-active state MVP-020 forbids.
     *
     * Task creation is part of THIS transaction (ADR-0009). The order matters: tasks are
     * created first, so that if the resolver refuses — a target completed while the plan
     * waited, a dependency that no longer resolves — the plan is left untouched and still
     * awaiting activation. Marking the plan active first would strand a plan that claims to
     * be in effect while producing no tasks.
     */
    private activate;
    get(planId: PlanId): PlanWithSlots;
    /** Every version, oldest first. Voided confirmations remain visible. */
    history(planId: PlanId): readonly PlanWithSlots[];
    listByProject(projectId: ProjectId): readonly PlanWithSlots[];
    private view;
    private suspension;
    private memberOf;
    private requireProject;
}
/**
 * Depth-first cycle detection over task refs.
 *
 * Returns the cycle path so the error can name it — "there is a cycle somewhere" is not
 * actionable, whereas "a -> b -> a" tells the caller exactly what to break.
 */
export declare function findCycle(tasks: readonly PlannedTask[]): readonly string[] | null;
export type { ConfirmationSlot, GateState };
