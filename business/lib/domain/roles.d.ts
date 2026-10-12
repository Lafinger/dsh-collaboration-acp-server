/**
 * The nine roles are a FIXED set. A role is not a creatable entity — it is a slot.
 * See ADR-0004 (one member per role, all roles equal).
 */
export declare const ROLE_IDS: readonly ["pm", "product", "design", "scenemodel", "sceneart", "data", "frontend", "backend", "ue"];
export type RoleId = (typeof ROLE_IDS)[number];
/** Directory used when a material belongs to no role (e.g. a client-supplied original). */
export declare const SHARED_DIR = "_shared";
/** Human-facing labels. These live only in the app; directories use the stable ids above. */
export declare const ROLE_LABELS: Readonly<Record<RoleId, string>>;
export declare function isRoleId(value: unknown): value is RoleId;
/**
 * A role slot's member. Deliberately an opaque string: MVP keeps no identity system,
 * so this is a mutable label, never a foreign key (ADR-0004).
 */
export type MemberLabel = string;
/**
 * The member a SESSION has declared itself to be.
 *
 * Distinct from the member of a role slot, and the distinction is load-bearing (ADR-0014):
 * this answers "who is speaking", a role's member answers "who does this slot belong to".
 * They may differ, and must be allowed to, or the model turns circular — "I declare myself
 * pm, therefore I am pm's member".
 */
export interface SessionIdentity {
    readonly sessionId: string;
    readonly member: MemberLabel;
    readonly declaredAt: string;
    readonly updatedAt: string;
}
/** All nine roles of a project, each with an optional member and a resolved directory name. */
export interface RoleAssignment {
    readonly role: RoleId;
    readonly label: string;
    /** Member label, or null when the slot is vacant. */
    readonly member: MemberLabel | null;
}
/** Role directory name for the filesystem layout. `_shared` is not a role. */
export type RoleDir = RoleId | typeof SHARED_DIR;
export declare function isRoleDir(value: unknown): value is RoleDir;
