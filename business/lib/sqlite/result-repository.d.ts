/**
 * Result persistence (M5 result layer, ADR-0010).
 *
 * All three tables hang off a task version. Reads and writes only (ADR-0002); every write
 * happens inside the caller's transaction.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { RoleId } from '../domain/roles.js';
import type { Acceptance, AcceptanceOutcome, ProgressEntry, ResultConfirmation, ResultId, ResultVersion, ResultVersionRecord, ReviewOutcome } from '../domain/result.js';
import type { TaskId, TaskVersion } from '../domain/task.js';
export declare class ResultRepository {
    private readonly db;
    constructor(db: DatabaseSync);
    insertProgress(entry: ProgressEntry): void;
    progressOf(taskId: TaskId): readonly ProgressEntry[];
    /** Highest existing version for a task's result, or 0 when it has none. */
    latestResultVersion(taskId: TaskId): number;
    insertResult(record: ResultVersionRecord): void;
    /** An open confirmation slot for a freshly submitted result. */
    createConfirmationSlot(resultId: ResultId, version: ResultVersion, role: RoleId): void;
    recordReview(resultId: ResultId, version: ResultVersion, outcome: ReviewOutcome, reason: string | null, submittedBy: string, at: string): void;
    confirmationOf(resultId: ResultId, version: ResultVersion): ResultConfirmation | null;
    findResultVersion(resultId: ResultId, version: ResultVersion): ResultVersionRecord | null;
    /**
     * Every result version of a task, oldest first.
     *
     * A returned submission is still here: it is the basis for the correction, so discarding
     * it would destroy the record of what was rejected.
     */
    resultsOf(taskId: TaskId): readonly ResultVersionRecord[];
    createAcceptanceSlot(resultId: ResultId, version: ResultVersion, taskId: TaskId): void;
    recordAcceptance(resultId: ResultId, version: ResultVersion, taskId: TaskId, outcome: AcceptanceOutcome, reason: string | null, submittedBy: string, at: string,
    /**
     * The versions this decision pins down (ADR-0012). Recorded HERE, at decision time,
     * rather than when the slot opened: a revision in between would otherwise make the
     * record describe a definition that was never used.
     *
     * A REJECTION records them too, which keeps "refused" distinguishable from "never
     * decided" — traceability needs that difference.
     */
    acceptedTaskVersion: TaskVersion, acceptedResultTaskVersion: TaskVersion): void;
    /**
     * The task that owns a result id, or null when no such result exists.
     *
     * A result id is minted per submission, so its owner is a lookup rather than something
     * encoded in the id.
     */
    ownerOf(resultId: ResultId): TaskId | null;
    acceptancesOf(resultId: ResultId, version: ResultVersion): readonly Acceptance[];
    /** Every acceptance decision made BY a task, so a task can see what it decided. */
    acceptancesByTask(taskId: TaskId): readonly Acceptance[];
    /**
     * One hydrator, so the two acceptance readers cannot drift apart.
     *
     * They were separate copies until M7 added two columns; had they stayed separate, adding a
     * field to one and not the other would have produced two subtly different objects for the
     * same row.
     */
    private hydrateAcceptances;
    private hydrate;
    private filesOf;
}
export type { TaskId, TaskVersion };
