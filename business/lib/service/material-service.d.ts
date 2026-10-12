import type { DatabaseSync } from 'node:sqlite';
import type { Material, MaterialId, MaterialReference, MaterialVersion, MaterialWithVersions, UploadMaterialInput } from '../domain/material.js';
import type { ProjectId } from '../domain/project.js';
import { type Clock } from './project-service.js';
/** Everything a caller needs to act on the result. */
export interface UploadResult {
    readonly material: Material;
    readonly version: MaterialVersion;
    /** True when this upload created a NEW material rather than a new version of one. */
    readonly created: boolean;
    /** Absolute path of the stored file, for the uploader's own confirmation. */
    readonly absolutePath: string;
}
export declare class MaterialService {
    private readonly db;
    private readonly clock;
    private readonly materials;
    private readonly projects;
    private readonly files;
    constructor(db: DatabaseSync, fileRoot: string, clock?: Clock);
    get root(): string;
    /**
     * Upload a file as a new immutable version.
     *
     * MVP-010: the same filename uploaded again appends a version by default — it never
     * silently overwrites. A different `purpose` is a different material.
     */
    upload(input: UploadMaterialInput): UploadResult;
    getWithVersions(materialId: MaterialId): MaterialWithVersions;
    listByProject(projectId: ProjectId): readonly MaterialWithVersions[];
    /**
     * Resolve a fixed reference (MVP-009).
     *
     * A reference names ONE version and this never falls back to the latest — silently
     * substituting a newer version is exactly the failure this rule exists to prevent.
     */
    resolveReference(reference: MaterialReference): {
        material: Material;
        version: MaterialVersion;
    };
    /**
     * Read one version's bytes (MVP-008).
     *
     * MVP-011: when the file cannot be read, say WHY and keep the original retrievable —
     * never report an unreadable material as empty content.
     */
    read(reference: MaterialReference): {
        material: Material;
        version: MaterialVersion;
        absolutePath: string;
        content: string | null;
        issue: string | null;
    };
    absolutePathOf(relPath: string): string;
    /**
     * Read the source file before any store mutation.
     *
     * A file that cannot be read is still accepted IF it exists — the version is recorded
     * with an `issue`, so the failed read is visible rather than hidden as empty content
     * (MVP-011). A file that does not exist at all is refused outright.
     */
    private readSource;
    private requireMaterial;
    private requireWritableProject;
}
