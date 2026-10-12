/**
 * Analysis persistence. Reads and writes only (ADR-0002).
 *
 * Writes always happen as a unit: an analysis is inserted together with its scope, reads
 * and three content kinds, inside one transaction. There is no partial analysis.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Analysis, AnalysisId } from '../domain/analysis.js';
import type { ProjectId } from '../domain/project.js';
export declare class AnalysisRepository {
    private readonly db;
    constructor(db: DatabaseSync);
    insert(analysis: Analysis): void;
    findById(id: AnalysisId): Analysis | null;
    listByProject(projectId: ProjectId): readonly Analysis[];
    private hydrate;
}
