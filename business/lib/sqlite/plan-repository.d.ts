/**
 * Plan and confirmation persistence. Reads and writes only (ADR-0002).
 *
 * Every write here happens inside the caller's transaction. The repository never opens one
 * of its own — activation must be able to span several of these calls atomically.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { ConfirmationOutcome, ConfirmationSlot, Plan, PlanId, PlanVersion } from '../domain/plan.js';
import type { RoleId } from '../domain/roles.js';
import type { ProjectId } from '../domain/project.js';
export declare class PlanRepository {
    private readonly db;
    constructor(db: DatabaseSync);
    /**
     * Insert a plan version with its roles, tasks, dependencies and undecided marks.
     *
     * Takes the MAX version + 1 itself rather than trusting a caller-supplied number, the
     * same discipline as material versions: the version must be allocated where the write
     * happens or two concurrent revisions collide.
     */
    nextVersion(planId: PlanId): PlanVersion;
    insertPlan(plan: Plan): void;
    /** The latest version of a plan, which is the only one that can still change. */
    findLatest(planId: PlanId): Plan | null;
    findVersion(planId: PlanId, version: PlanVersion): Plan | null;
    /** Every version, oldest first — the revision history stays visible (MVP-021). */
    listVersions(planId: PlanId): readonly Plan[];
    listByProject(projectId: ProjectId): readonly Plan[];
    slotsOf(planId: PlanId, version: PlanVersion): readonly ConfirmationSlot[];
    /** All slots across all versions — used to prove voided confirmations were kept. */
    allSlots(planId: PlanId): readonly ConfirmationSlot[];
    createSlot(id: string, planId: PlanId, version: PlanVersion, role: RoleId): void;
    /** Void (not delete) every live slot of a version. Returns how many were voided. */
    voidSlots(planId: PlanId, version: PlanVersion, at: string, reason: string): number;
    recordDecision(planId: PlanId, version: PlanVersion, role: RoleId, outcome: ConfirmationOutcome, reason: string | null, submittedBy: string, at: string): void;
    activate(planId: PlanId, version: PlanVersion, at: string, roles: readonly RoleId[]): void;
    activationOf(planId: PlanId): {
        version: number;
        at: string;
        roles: readonly string[];
    } | null;
    private hydrate;
}
