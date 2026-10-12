/**
 * Notice storage (M6, ADR-0011).
 *
 * Only READ state is stored. Todos and notices are derived by querying the slot tables that
 * are already the authority, so there is no second copy to keep in sync.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { SlotRef } from '../domain/notice.js';
import { slotKey } from '../domain/notice.js';
interface SlotRow {
    readonly kind: string;
    readonly project_id: string;
    readonly object_id: string;
    readonly version: number;
    readonly role: string;
    readonly task_id: string | null;
    readonly summary: string;
    readonly detail: string | null;
    readonly created_at: string;
}
export declare class NoticeRepository {
    private readonly db;
    constructor(db: DatabaseSync);
    /**
     * Every UNDECIDED slot in a project, as todos.
     *
     * The three branches are unioned because they are three different tables with a common
     * shape: something is waiting for a role to decide. A LEFT JOIN on `reads` marks the ones
     * already looked at.
     *
     * `voided_at IS NULL` is load-bearing for plan confirmations: a revision VOIDS slots
     * rather than deleting them, and a voided slot is not awaiting anyone.
     */
    pendingTodos(projectId: string): readonly SlotRow[];
    /**
     * Notices: things that already happened and need no decision.
     *
     * Only two exist in the MVP, both derived:
     *   - a result was completed (the task's own role has nothing left to do)
     *   - a result was rejected (informational; rejection triggers NOTHING else, MVP-027)
     *
     * The rejection notice is addressed to the UPSTREAM task — the one whose result was turned
     * down — because MVP-027 says the notice goes to "上游任务的主执行人": the point is to tell
     * the producer their work was refused. Addressing it to `a.task_id` (the DECIDING task) sent
     * the notice back to the very role that made the decision, who learns nothing from it.
     * `rv.task_id` is the task that PRODUCED the result under review.
     */
    notices(projectId: string): readonly SlotRow[];
    /** Which of these slot keys the given role has already read. */
    readKeys(keys: readonly string[]): ReadonlySet<string>;
    /**
     * Record a read.
     *
     * `INSERT OR IGNORE` is what makes "reading twice does not count twice" true: it is the
     * primary key doing the work, not counting logic that could drift.
     */
    markRead(ref: SlotRef, at: string, readBy: string | null): boolean;
    isRead(ref: SlotRef): boolean;
    /**
     * Whether the addressed slot exists AT ALL — pending, decided or voided.
     *
     * This asks the SLOT TABLES, not the derived todo lists. A decided slot is still a real
     * record, so reading it is legitimate even though it is no longer work to do: "does this
     * exist" and "is this still a todo" are different questions.
     */
    slotExists(ref: SlotRef): boolean;
    private rowExists;
}
export type { SlotRow };
export { slotKey };
