import type { DatabaseSync } from 'node:sqlite';
import { type Analysis, type AnalysisId, type ReadRecord, type ScopeEntry, type SubmitAnalysisInput, type Uncovered } from '../domain/analysis.js';
import type { ProjectId } from '../domain/project.js';
import { MaterialService } from './material-service.js';
import { type Clock } from './project-service.js';
/** What the caller gets back from `begin`: the content, and the gaps. */
export interface ScopeReadOutcome {
    readonly projectId: ProjectId;
    readonly scope: readonly ScopeEntry[];
    readonly contents: readonly {
        readonly materialId: string;
        readonly version: number;
        readonly originalName: string;
        readonly content: string;
        readonly sha256: string;
        readonly size: number;
    }[];
    readonly uncovered: readonly Uncovered[];
    readonly reads: readonly ReadRecord[];
}
export interface ReadScopeInput {
    readonly projectId: ProjectId;
    readonly scope: readonly ScopeEntry[];
    readonly limitBytes?: number | undefined;
}
export declare class AnalysisService {
    private readonly db;
    private readonly materials;
    private readonly clock;
    private readonly analyses;
    private readonly projects;
    constructor(db: DatabaseSync, materials: MaterialService, clock?: Clock);
    /**
     * Read the declared scope (MVP-013).
     *
     * Nothing is persisted here: an analysis exists only once submitted. This step is
     * therefore safe to call repeatedly and safe to abandon.
     */
    readScope(input: ReadScopeInput): ScopeReadOutcome;
    /**
     * Persist a completed analysis.
     *
     * The objective gaps are RE-DERIVED here rather than accepted from the caller, so a
     * caller cannot omit one that it did not like.
     */
    submit(input: SubmitAnalysisInput): Analysis;
    get(id: AnalysisId): Analysis;
    listByProject(projectId: ProjectId): readonly Analysis[];
    /** Read one scope entry, classifying WHY it could not be covered. */
    private readOne;
    private requireProject;
}
/** Normalise and de-duplicate the scope, preserving order. */
export declare function normaliseScope(scope: readonly ScopeEntry[]): readonly ScopeEntry[];
