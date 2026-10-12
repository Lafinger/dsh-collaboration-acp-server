/**
 * Material persistence. Reads and writes only — no business judgement (ADR-0002).
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Material, MaterialId, MaterialVersion } from '../domain/material.js';
import type { ProjectId } from '../domain/project.js';
export declare class MaterialRepository {
    private readonly db;
    constructor(db: DatabaseSync);
    insertMaterial(material: Material): void;
    findById(id: MaterialId): Material | null;
    /** Identity is (project, original name, purpose) — so a new purpose starts a new material. */
    findByIdentity(projectId: ProjectId, originalName: string, purpose: string): Material | null;
    listByProject(projectId: ProjectId): readonly Material[];
    /** Highest existing version for a material, or 0 when it has none yet. */
    latestVersion(materialId: MaterialId): number;
    insertVersion(version: MaterialVersion): void;
    versionsOf(materialId: MaterialId): readonly MaterialVersion[];
    findVersion(materialId: MaterialId, version: number): MaterialVersion | null;
    /** Count of version rows per material, used to detect unexpected gaps. */
    countVersions(materialId: MaterialId): number;
}
