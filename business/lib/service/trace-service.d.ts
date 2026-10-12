/**
 * Traceability (M7, MVP-031).
 *
 * The requirement asks one question: "who, on which version, decided what, when, and why".
 * So this layer is a READER — it creates nothing, and it is the only layer in the MVP that
 * writes no rows at all.
 *
 * Why an object is the entry point rather than a timeline: a timeline answers "what happened
 * when", but MVP-031 asks "on which version", and a caller would have to reassemble that
 * from a stream. Asking per object answers it directly.
 *
 * Version discipline is the point:
 *   - CURRENT vs HISTORICAL are distinguished, never blended
 *   - history is read-only; changing something means a NEW version, never an edit
 *   - an archived project still reads
 *
 * The chain is stitched from records that already exist. M7 added no business object; the
 * only thing it needed that was missing was WHICH INPUT VERSION was consumed (ADR-0012).
 */
import type { DatabaseSync } from 'node:sqlite';
import type { ProjectId } from '../domain/project.js';
import type { TaskId } from '../domain/task.js';
import type { ResultId, ResultVersion } from '../domain/result.js';
/** One thing that happened, with everything MVP-031 asks for. */
export interface TraceDecision {
    /** What kind of record this is. */
    readonly kind: 'plan_confirmation' | 'result_review' | 'result_acceptance' | 'plan_activation' | 'task_version' | 'result_version';
    /** Which version this decision was made against. */
    readonly version: number;
    readonly role: string | null;
    readonly outcome: string | null;
    readonly reason: string | null;
    /** Who submitted it. A SNAPSHOT, not a credential. */
    readonly submittedBy: string | null;
    readonly at: string | null;
    /** The input version consumed, where the record pins one (ADR-0012). */
    readonly basedOn: {
        readonly kind: string;
        readonly version: number;
    } | null;
    readonly detail: string | null;
}
/** Everything knowable about one object, split into current and history. */
export interface Trace {
    readonly object: {
        readonly type: string;
        readonly id: string;
        readonly projectId: ProjectId;
    };
    /** The version in force now, or null when nothing is current. */
    readonly currentVersion: number | null;
    /** Up to and including the current version. */
    readonly decisions: readonly TraceDecision[];
    /** Superseded versions, kept readable. Never blended into `decisions`. */
    readonly history: readonly TraceDecision[];
    /** What this object consumed, and what consumed it. */
    readonly chain: {
        readonly inputs: readonly {
            readonly taskId: TaskId;
            readonly version: number | null;
            readonly resultVersion: number | null;
        }[];
        readonly consumers: readonly {
            readonly taskId: TaskId;
            readonly outcome: string;
            readonly version: number;
        }[];
    };
}
export declare class TraceService {
    private readonly plans;
    private readonly tasks;
    private readonly results;
    constructor(db: DatabaseSync);
    /** Trace one task: its versions, the decisions on them, and what it consumed. */
    traceTask(taskId: TaskId): Trace;
    /**
     * The latest version of a result, or null when it has none.
     *
     * Lets a caller ask "trace this result" without having to know its version number first.
     */
    latestResultVersion(resultId: ResultId): ResultVersion | null;
    /** Trace one result version: how it was produced, and every decision made on it. */
    traceResult(resultId: ResultId, version: ResultVersion): Trace;
    /** Trace one plan: every confirmation, whether it is still in force, and when it activated. */
    tracePlan(planId: string): Trace;
    /**
     * What a task consumed, per required input.
     *
     * Reads ACCEPTANCES rather than dependency rows, because the dependency only names a task
     * while the acceptance pins the version (ADR-0012). An input with no accepted version
     * reports nulls — that is the honest answer, and it is what blocks completion.
     */
    private inputsOf;
    /** Which tasks consumed this one, and how they decided. */
    private consumersOf;
}
