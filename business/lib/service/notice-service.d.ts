/**
 * Todos and notifications (M6, ADR-0011).
 *
 * A todo is a PROJECTION of an undecided slot, not a stored row. This service reads the
 * slots and presents them; it writes nothing except read state.
 *
 * Consequences worth stating plainly:
 *   - there is no "create todo" operation, so MVP-016's ban on automatically creating work
 *     cannot be violated here — this layer never writes a business object
 *   - marking something read changes NO business state (MVP-030); the only way to close a
 *     todo is to submit the corresponding decision
 *   - a todo does not disappear when read
 */
import type { DatabaseSync } from 'node:sqlite';
import { type ItemKind, type Notice, type SlotRef, type Todo, type UnreadCount } from '../domain/notice.js';
import type { ProjectId } from '../domain/project.js';
import { type RoleId } from '../domain/roles.js';
import { type Clock } from './project-service.js';
export interface TodoFilter {
    readonly projectId: ProjectId;
    /** Only these roles. Empty/absent means every role. */
    readonly roles?: readonly RoleId[];
    /** Only these kinds. Empty/absent means both todos and notices. */
    readonly kinds?: readonly ItemKind[];
    /** Only unread items. */
    readonly unreadOnly?: boolean;
}
export declare class NoticeService {
    private readonly clock;
    private readonly notices;
    private readonly projects;
    constructor(db: DatabaseSync, clock?: Clock);
    /** Every undecided slot in a project, as todos. */
    todos(filter: TodoFilter): readonly Todo[];
    /** Informational items. Reading one decides nothing. */
    list(filter: TodoFilter): readonly Notice[];
    /**
     * What each role currently owes.
     *
     * Only todos count. A notice is never "owed", so it never contributes to unread.
     */
    unread(projectId: ProjectId): readonly UnreadCount[];
    /**
     * Mark one slot as read for the role it belongs to.
     *
     * Reading changes NO business state — that is the whole point of MVP-030. It does not
     * approve a plan, complete a task, or accept a result.
     *
     * The slot MUST currently exist, which is checked rather than assumed: without that check,
     * marking a mistyped id read stored a row nothing could ever match while reporting success.
     * A read nobody can observe is worse than a rejection.
     */
    markRead(ref: SlotRef): {
        readonly changed: boolean;
    };
    /**
     * Whether this address corresponds to a slot that currently exists.
     *
     * Checks the SLOT TABLES rather than the derived lists, because a decided or voided slot
     * still exists as a record while correctly no longer being a todo. Deriving existence from
     * the todo list alone would reject a legitimate read of history.
     */
    private slotExists;
    /** Mark everything a role currently owes in a project as read. */
    markAllRead(projectId: ProjectId, role: RoleId): number;
    isRead(ref: SlotRef): boolean;
    private membersOf;
    private requireProject;
}
