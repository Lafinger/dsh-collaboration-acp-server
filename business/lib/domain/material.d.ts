/**
 * Materials and their immutable versions (M2).
 *
 * A material is a named work input inside a project. Uploading it again does NOT modify
 * it — it appends a new immutable version (MVP-007). A reference always names a specific
 * version and is never silently upgraded to the latest (MVP-009).
 */
import type { ProjectId } from './project.js';
import type { RoleDir, RoleId } from './roles.js';
export type MaterialId = string;
/**
 * What the material is for (MVP-006). Free text, but recorded explicitly so two uploads of
 * the same filename with different purposes stay distinguishable (MVP-010).
 */
export type Purpose = string;
/** Filing category, set at upload time and NOT changed by later uploads. */
export interface Material {
    readonly id: MaterialId;
    readonly projectId: ProjectId;
    readonly originalName: string;
    readonly purpose: Purpose;
    /** Name of the uploader, recorded as a snapshot at upload time (MVP-006). */
    readonly submittedBy: string;
    /**
     * The role this material belongs to. Materials that belong to no role are filed under
     * the shared directory. Fixed at creation: a later member change moves no files.
     */
    readonly role: RoleId | null;
    readonly createdAt: string;
}
/** One immutable upload. Never edited in place. */
export interface MaterialVersion {
    readonly materialId: MaterialId;
    /** 1-based, per material. Assigned inside the write transaction. */
    readonly version: number;
    /** Path relative to the storage root, always with `/` separators. */
    readonly relPath: string;
    readonly size: number;
    readonly sha256: string;
    /** Set when the bytes could not be read/parsed. The original stays retrievable (MVP-011). */
    readonly issue: string | null;
    readonly createdAt: string;
}
export interface MaterialWithVersions extends Material {
    readonly versions: readonly MaterialVersion[];
    readonly latestVersion: number;
}
/** A reference to one specific version. Resolving it never returns a different version. */
export interface MaterialReference {
    readonly materialId: MaterialId;
    readonly version: number;
}
export interface UploadMaterialInput {
    readonly projectId: ProjectId;
    /** Absolute path to the file to read. */
    readonly sourcePath: string;
    /** Overrides the filename taken from `sourcePath`. Used when the caller knows better. */
    readonly originalName?: string | undefined;
    readonly purpose: Purpose;
    readonly submittedBy: string;
    readonly role?: RoleId | null | undefined;
}
export declare function roleDirOf(role: RoleId | null): RoleDir;
export declare function isUnreadable(version: MaterialVersion): boolean;
/** Materials are only ever append-only, so a version number is stable once written. */
export declare function referenceOf(material: Material, version: number): MaterialReference;
