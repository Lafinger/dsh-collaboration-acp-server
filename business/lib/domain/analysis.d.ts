/**
 * Analysis (M3).
 *
 * An analysis reads a SET OF FIXED VERSIONS and produces advice. Two properties are the
 * whole point, both enforced by the server rather than trusted (ADR-0006):
 *
 *   1. Scope is an INPUT, not a promise. Content outside the scope never reaches the
 *      model, so "only read the scope" needs no self-discipline.
 *   2. "Not covered" has objective parts (named but unreadable, version absent, over the
 *      size cap). The server records those itself — an objective fact must not be
 *      self-reported by the party being checked.
 *
 * An analysis exists only once submitted (ADR: no "in progress" state).
 */
import type { MaterialId } from './material.js';
import type { ProjectId } from './project.js';
export type AnalysisId = string;
/** One fixed version the analysis is allowed to read. */
export interface ScopeEntry {
    readonly materialId: MaterialId;
    readonly version: number;
}
/** Why the analysis was requested. Required — it is the one thing not derivable later. */
export type Trigger = string;
/**
 * A requirement the material states explicitly.
 *
 * `sources` is what separates this from an inference: if it cannot point at the version
 * that supports it, it is not "explicit". Sources must lie inside the analysis scope.
 */
export interface Requirement {
    readonly text: string;
    readonly sources: readonly ScopeEntry[];
}
/** Something the material raises but does not settle. No status, no owner, never "solved". */
export type Undecided = string;
/** Something the analysis believes but the material does not directly support. */
export type Inference = string;
/** A part of the scope that could NOT be covered, with the reason. */
export interface Uncovered {
    readonly text: string;
    /** Present when the gap is about one specific version. */
    readonly entry: ScopeEntry | null;
    /** Machine-readable reason, so the cause is never guessed at from prose. */
    readonly reason: UncoveredReason;
}
export type UncoveredReason =
/** The analysis named it but the bytes could not be read. */
'unreadable'
/** The material has no such version. */
 | 'version_missing'
/** The material itself does not exist. */
 | 'material_missing'
/** The version exists and is readable but exceeds the size cap. */
 | 'too_large'
/** The reader could not understand part of the content. Reported by the analysis. */
 | 'not_understood'
/** A basis the analysis expected but that was not supplied. */
 | 'basis_missing';
/** What the server actually did while reading the scope. Not the model's claim. */
export interface ReadRecord {
    readonly entry: ScopeEntry;
    readonly originalName: string | null;
    readonly sha256: string | null;
    readonly size: number | null;
    readonly ok: boolean;
    readonly reason: UncoveredReason | null;
    readonly readAt: string;
}
/** One complete analysis. Immutable: to change anything, run a new analysis. */
export interface Analysis {
    readonly id: AnalysisId;
    readonly projectId: ProjectId;
    readonly trigger: Trigger;
    readonly scope: readonly ScopeEntry[];
    /** Server-produced record of what was actually read. */
    readonly reads: readonly ReadRecord[];
    readonly requirements: readonly Requirement[];
    readonly undecided: readonly Undecided[];
    readonly inferences: readonly Inference[];
    /** Objective gaps (server) merged with subjective ones (analysis). */
    readonly uncovered: readonly Uncovered[];
    readonly createdAt: string;
}
export interface ScopeContent {
    readonly entry: ScopeEntry;
    readonly originalName: string;
    readonly content: string;
    readonly sha256: string;
    readonly size: number;
}
/** Result of reading a scope: what came back, and what did not. */
export interface ScopeReadResult {
    readonly contents: readonly ScopeContent[];
    /** Objective gaps discovered while reading. The server owns these. */
    readonly uncovered: readonly Uncovered[];
    readonly reads: readonly ReadRecord[];
}
export interface SubmitAnalysisInput {
    readonly projectId: ProjectId;
    readonly trigger: Trigger;
    readonly scope: readonly ScopeEntry[];
    readonly requirements: readonly {
        text: string;
        sources: readonly ScopeEntry[];
    }[];
    readonly undecided: readonly string[];
    readonly inferences: readonly string[];
    /** Only the subjective gaps; the server adds the objective ones. */
    readonly notUnderstood: readonly string[];
    readonly basisMissing: readonly string[];
}
/** Default cap for a single file fed into an analysis. */
export declare const DEFAULT_CONTENT_LIMIT_BYTES: number;
