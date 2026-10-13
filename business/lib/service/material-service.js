/**
 * Material business rules (M2).
 *
 * The two properties that matter most here, both established by real defects during
 * pre-implementation verification:
 *
 *   1. Version allocation and the row insert happen in ONE transaction, using MAX+1 on the
 *      material's own versions. A `COUNT(*)+1` outside a transaction let two uploads both
 *      claim version 1, producing identical filenames — one file silently overwrote the
 *      other, breaking the immutability guarantee (MVP-007).
 *
 *   2. The destination path is resolved and checked against the storage root BEFORE any
 *      bytes are written. A crafted project id wrote a real file outside fileRoot
 *      (ADR-0004).
 *
 * A refusal must leave NOTHING behind: no file, no row.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { CollaborationError } from '../domain/error.js';
import { newId } from '../domain/ids.js';
import { roleDirOf } from '../domain/material.js';
import { assertWritable } from '../domain/project.js';
import { isRoleId } from '../domain/roles.js';
import { MaterialRepository } from '../sqlite/material-repository.js';
import { ProjectRepository } from '../sqlite/project-repository.js';
import { inTransaction } from '../sqlite/schema.js';
import { FileRoot, versionFileName } from './file-root.js';
import { systemClock } from './project-service.js';
const MAX_NAME_LENGTH = 300;
const MAX_PURPOSE_LENGTH = 200;
export class MaterialService {
    db;
    clock;
    materials;
    projects;
    files;
    constructor(db, fileRoot, clock = systemClock) {
        this.db = db;
        this.clock = clock;
        this.materials = new MaterialRepository(db);
        this.projects = new ProjectRepository(db);
        this.files = new FileRoot(fileRoot);
    }
    get root() {
        return this.files.root;
    }
    /**
     * Upload a file as a new immutable version.
     *
     * MVP-010: the same filename uploaded again appends a version by default — it never
     * silently overwrites. A different `purpose` is a different material.
     */
    upload(input) {
        const project = this.requireWritableProject(input.projectId);
        const originalName = requireText(input.originalName ?? basename(input.sourcePath), 'original name', MAX_NAME_LENGTH);
        const purpose = requireText(input.purpose, 'purpose', MAX_PURPOSE_LENGTH);
        const submittedBy = requireText(input.submittedBy, 'submittedBy', MAX_NAME_LENGTH);
        let role = null;
        if (input.role !== undefined && input.role !== null) {
            if (!isRoleId(input.role)) {
                throw new CollaborationError('ROLE_UNKNOWN', `unknown role "${input.role}"`, { role: input.role });
            }
            role = input.role;
        }
        // Read the source BEFORE touching the store, so a missing or unreadable source cannot
        // leave a half-written version behind.
        const source = this.readSource(input.sourcePath);
        const existing = this.materials.findByIdentity(project.id, originalName, purpose);
        const materialId = existing?.id ?? newId();
        const now = this.clock.now();
        const material = existing ?? {
            id: materialId,
            projectId: project.id,
            originalName,
            purpose,
            submittedBy,
            role,
            createdAt: now,
        };
        // Allocate the version and record it in one transaction. The file is copied inside it
        // too: a duplicate version number would be caught by the unique index and rolled back,
        // so the copy must be undoable as well (we remove the file on failure).
        const payload = source;
        let writtenPath = null;
        try {
            const version = inTransaction(this.db, () => {
                if (existing === null)
                    this.materials.insertMaterial(material);
                const next = this.materials.latestVersion(materialId) + 1;
                const dir = this.files.resolve(project.key, roleDirOf(role), 'materials', materialId);
                const target = this.files.resolve(project.key, roleDirOf(role), 'materials', materialId, versionFileName(next, originalName));
                mkdirSync(dir, { recursive: true });
                copyFileSync(payload.path, target);
                writtenPath = target;
                const row = {
                    materialId,
                    version: next,
                    relPath: this.files.relativeOf(target),
                    size: payload.size,
                    sha256: payload.sha256,
                    issue: payload.issue,
                    createdAt: now,
                };
                this.materials.insertVersion(row);
                return row;
            });
            return {
                material,
                version,
                created: existing === null,
                absolutePath: this.files.resolve(project.key, roleDirOf(role), 'materials', materialId, versionFileName(version.version, originalName)),
            };
        }
        catch (error) {
            // Never leave an orphan file behind a failed transaction.
            if (writtenPath !== null) {
                try {
                    unlinkSync(writtenPath);
                }
                catch {
                    // Best effort: the row was rolled back, which is what correctness depends on.
                }
            }
            throw error;
        }
    }
    getWithVersions(materialId) {
        const material = this.requireMaterial(materialId);
        const versions = this.materials.versionsOf(materialId);
        return {
            ...material,
            versions,
            latestVersion: versions.length === 0 ? 0 : (versions[versions.length - 1]?.version ?? 0),
        };
    }
    listByProject(projectId) {
        return this.materials.listByProject(projectId).map((m) => this.getWithVersions(m.id));
    }
    /**
     * Resolve a fixed reference (MVP-009).
     *
     * A reference names ONE version and this never falls back to the latest — silently
     * substituting a newer version is exactly the failure this rule exists to prevent.
     */
    resolveReference(reference) {
        const material = this.requireMaterial(reference.materialId);
        const version = this.materials.findVersion(reference.materialId, reference.version);
        if (version === null) {
            throw new CollaborationError('VERSION_NOT_FOUND', `material "${material.originalName}" has no version ${reference.version}`, { materialId: reference.materialId, version: reference.version });
        }
        return { material, version };
    }
    /**
     * Read one version's bytes (MVP-008).
     *
     * MVP-011: when the file cannot be read, say WHY and keep the original retrievable —
     * never report an unreadable material as empty content.
     */
    read(reference) {
        const { material, version } = this.resolveReference(reference);
        const absolutePath = this.absolutePathOf(version.relPath);
        if (!existsSync(absolutePath)) {
            return {
                material,
                version,
                absolutePath,
                content: null,
                issue: `stored file is missing at ${version.relPath}`,
            };
        }
        try {
            const buf = readFileSync(absolutePath);
            return { material, version, absolutePath, content: buf.toString('utf8'), issue: null };
        }
        catch (error) {
            return {
                material,
                version,
                absolutePath,
                content: null,
                issue: `stored file could not be read: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
    }
    absolutePathOf(relPath) {
        // relPath came from us, but re-validate anyway: a corrupted row must not become a
        // read outside the root.
        return this.files.resolve(...relPath.split('/'));
    }
    /**
     * Read the source file before any store mutation.
     *
     * A file that cannot be read is still accepted IF it exists — the version is recorded
     * with an `issue`, so the failed read is visible rather than hidden as empty content
     * (MVP-011). A file that does not exist at all is refused outright.
     */
    readSource(sourcePath) {
        const path = resolve(sourcePath);
        if (!existsSync(path)) {
            throw new CollaborationError('SOURCE_NOT_FOUND', `source file does not exist: ${path}`, { path });
        }
        let stat;
        try {
            stat = statSync(path);
        }
        catch (error) {
            throw new CollaborationError('SOURCE_NOT_FOUND', `source file could not be inspected: ${error instanceof Error ? error.message : String(error)}`, { path });
        }
        if (!stat.isFile()) {
            throw new CollaborationError('SOURCE_NOT_A_FILE', `source is not a regular file: ${path}`, { path });
        }
        try {
            const buf = readFileSync(path);
            return {
                path,
                size: buf.byteLength,
                sha256: createHash('sha256').update(buf).digest('hex'),
                issue: null,
            };
        }
        catch (error) {
            // Keep the original: record the failure, do not pretend the file was empty.
            return {
                path,
                size: stat.size,
                sha256: '',
                issue: `could not read source: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
    }
    requireMaterial(materialId) {
        const material = this.materials.findById(materialId);
        if (material === null) {
            throw new CollaborationError('MATERIAL_NOT_FOUND', `no material with id ${materialId}`, {
                materialId,
            });
        }
        return material;
    }
    requireWritableProject(projectId) {
        // Delegates to the shared gate so "archived is read-only" has exactly ONE definition.
        return assertWritable(this.projects.findById(projectId), projectId);
    }
}
function requireText(value, field, max) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new CollaborationError('INVALID_ARGUMENT', `${field} is required`, { field });
    }
    const trimmed = value.trim();
    if (trimmed.length > max) {
        throw new CollaborationError('INVALID_ARGUMENT', `${field} exceeds ${max} characters`, { field });
    }
    return trimmed;
}
