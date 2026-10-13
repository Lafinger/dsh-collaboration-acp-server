/**
 * Analysis business rules (M3).
 *
 * Two things this service does that the model cannot do for itself (ADR-0006):
 *
 *   1. It READS the scope. The caller supplies references; the content is fetched here and
 *      handed back. Content outside the scope is never fetched, so it never reaches the
 *      model — "only read the scope" is structural, not a promise.
 *
 *   2. It RECORDS the objective gaps itself: named-but-unreadable, version absent, over the
 *      size cap. Whether a file could be read is a fact, and a fact must not be
 *      self-reported by the party being checked.
 *
 * An analysis is written once, whole. An abandoned attempt leaves no trace.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { DEFAULT_CONTENT_LIMIT_BYTES, } from '../domain/analysis.js';
import { CollaborationError } from '../domain/error.js';
import { newId } from '../domain/ids.js';
import { assertWritable } from '../domain/project.js';
import { AnalysisRepository } from '../sqlite/analysis-repository.js';
import { ProjectRepository } from '../sqlite/project-repository.js';
import { inTransaction } from '../sqlite/schema.js';
import { MaterialService } from './material-service.js';
import { systemClock } from './project-service.js';
const MAX_TRIGGER_LENGTH = 500;
const MAX_TEXT_LENGTH = 2000;
const MAX_ENTRIES = 200;
export class AnalysisService {
    db;
    materials;
    clock;
    analyses;
    projects;
    constructor(db, materials, clock = systemClock) {
        this.db = db;
        this.materials = materials;
        this.clock = clock;
        this.analyses = new AnalysisRepository(db);
        this.projects = new ProjectRepository(db);
    }
    /**
     * Read the declared scope (MVP-013).
     *
     * Nothing is persisted here: an analysis exists only once submitted. This step is
     * therefore safe to call repeatedly and safe to abandon.
     */
    readScope(input) {
        const project = this.requireProject(input.projectId);
        const scope = normaliseScope(input.scope);
        const limit = input.limitBytes ?? DEFAULT_CONTENT_LIMIT_BYTES;
        const readAt = this.clock.now();
        const contents = [];
        const uncovered = [];
        const reads = [];
        for (const entry of scope) {
            const outcome = this.readOne(entry, limit);
            if (outcome.content === null) {
                // `readOne` returns null content only together with a reason; the invariant is
                // asserted rather than cast, so a future change cannot silently drop the cause.
                if (outcome.reason === null) {
                    throw new CollaborationError('INTERNAL', 'a scope entry failed without a reason', { entry });
                }
                uncovered.push({
                    text: outcome.explanation,
                    entry,
                    reason: outcome.reason,
                });
            }
            else {
                contents.push({
                    materialId: entry.materialId,
                    version: entry.version,
                    originalName: outcome.originalName,
                    content: outcome.content,
                    sha256: outcome.sha256,
                    size: outcome.size,
                });
            }
            reads.push({
                entry,
                originalName: outcome.originalName,
                sha256: outcome.sha256,
                size: outcome.size,
                ok: outcome.content !== null,
                reason: outcome.reason,
                readAt,
            });
        }
        return { projectId: project.id, scope, contents, uncovered, reads };
    }
    /**
     * Persist a completed analysis.
     *
     * The objective gaps are RE-DERIVED here rather than accepted from the caller, so a
     * caller cannot omit one that it did not like.
     */
    submit(input) {
        const project = this.requireProject(input.projectId);
        // An analysis is a new write, so an archived project must not accept one (MVP-005).
        assertWritable(project, input.projectId);
        const trigger = requireText(input.trigger, 'trigger', MAX_TRIGGER_LENGTH);
        const scope = normaliseScope(input.scope);
        // Read the scope again: this is the record of what was actually read, not a claim.
        const outcome = this.readScope({ projectId: project.id, scope });
        const scopeIndex = new Set(scope.map(keyOf));
        const requirements = input.requirements.map((r) => {
            const text = requireText(r.text, 'requirement text', MAX_TEXT_LENGTH);
            const sources = r.sources.map((s) => ({
                materialId: requireText(s.materialId, 'source material id', 200),
                version: requirePositiveInt(s.version, 'source version'),
            }));
            if (sources.length === 0) {
                throw new CollaborationError('SOURCE_REQUIRED', `an explicit requirement must cite the version that supports it: "${truncate(text)}"`, { text });
            }
            // A source outside the scope is a fabricated basis (MVP-014).
            for (const s of sources) {
                if (!scopeIndex.has(keyOf(s))) {
                    throw new CollaborationError('SOURCE_OUT_OF_SCOPE', `source ${s.materialId} v${s.version} is not in this analysis scope`, { materialId: s.materialId, version: s.version });
                }
            }
            return { text, sources };
        });
        const undecided = input.undecided.map((t) => requireText(t, 'undecided', MAX_TEXT_LENGTH));
        const inferences = input.inferences.map((t) => requireText(t, 'inference', MAX_TEXT_LENGTH));
        // Objective gaps come from the server; subjective ones from the analysis. The caller
        // cannot drop the objective ones.
        const uncovered = [
            ...outcome.uncovered,
            ...input.notUnderstood.map((t) => ({
                text: requireText(t, 'not understood', MAX_TEXT_LENGTH),
                entry: null,
                reason: 'not_understood',
            })),
            ...input.basisMissing.map((t) => ({
                text: requireText(t, 'missing basis', MAX_TEXT_LENGTH),
                entry: null,
                reason: 'basis_missing',
            })),
        ];
        const analysis = {
            id: newId(),
            projectId: project.id,
            trigger,
            scope,
            reads: outcome.reads,
            requirements,
            undecided,
            inferences,
            uncovered,
            createdAt: this.clock.now(),
        };
        return inTransaction(this.db, () => {
            this.analyses.insert(analysis);
            return analysis;
        });
    }
    get(id) {
        const analysis = this.analyses.findById(id);
        if (analysis === null) {
            throw new CollaborationError('ANALYSIS_NOT_FOUND', `no analysis with id ${id}`, { id });
        }
        return analysis;
    }
    listByProject(projectId) {
        return this.analyses.listByProject(projectId);
    }
    /** Read one scope entry, classifying WHY it could not be covered. */
    readOne(entry, limitBytes) {
        const empty = { content: null, originalName: '', sha256: '', size: 0 };
        let resolved;
        try {
            resolved = this.materials.resolveReference(entry);
        }
        catch (error) {
            if (error instanceof CollaborationError && error.code === 'MATERIAL_NOT_FOUND') {
                return {
                    ...empty,
                    reason: 'material_missing',
                    explanation: `material ${entry.materialId} does not exist`,
                };
            }
            if (error instanceof CollaborationError && error.code === 'VERSION_NOT_FOUND') {
                return {
                    ...empty,
                    reason: 'version_missing',
                    explanation: `material ${entry.materialId} has no version ${entry.version}`,
                };
            }
            throw error;
        }
        const { material, version } = resolved;
        const base = { originalName: material.originalName, sha256: version.sha256, size: version.size };
        // Over the cap: record it as uncovered rather than truncating. A half-read file that
        // looks whole is worse than an admitted gap.
        if (version.size > limitBytes) {
            return {
                ...base,
                content: null,
                reason: 'too_large',
                explanation: `${material.originalName} v${version.version} is ${version.size} bytes, over the ${limitBytes}-byte limit`,
            };
        }
        const absolute = this.materials.absolutePathOf(version.relPath);
        if (!existsSync(absolute)) {
            return {
                ...base,
                content: null,
                reason: 'unreadable',
                explanation: `${material.originalName} v${version.version} is missing from storage`,
            };
        }
        try {
            if (!statSync(absolute).isFile()) {
                return {
                    ...base,
                    content: null,
                    reason: 'unreadable',
                    explanation: `${material.originalName} v${version.version} is not a regular file`,
                };
            }
            const content = readFileSync(absolute, 'utf8');
            return { ...base, content, reason: null, explanation: '' };
        }
        catch (error) {
            return {
                ...base,
                content: null,
                reason: 'unreadable',
                explanation: `${material.originalName} v${version.version} could not be read: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
    }
    requireProject(projectId) {
        const project = this.projects.findById(projectId);
        if (project === null) {
            throw new CollaborationError('PROJECT_NOT_FOUND', `no project with id ${projectId}`, { id: projectId });
        }
        return project;
    }
}
function keyOf(entry) {
    return `${entry.materialId}@${entry.version}`;
}
/** Normalise and de-duplicate the scope, preserving order. */
export function normaliseScope(scope) {
    if (!Array.isArray(scope) || scope.length === 0) {
        throw new CollaborationError('SCOPE_REQUIRED', 'an analysis needs an explicit non-empty scope', {});
    }
    if (scope.length > MAX_ENTRIES) {
        throw new CollaborationError('INVALID_ARGUMENT', `scope exceeds ${MAX_ENTRIES} entries`, {
            count: scope.length,
        });
    }
    const seen = new Set();
    const result = [];
    for (const raw of scope) {
        const materialId = requireText(raw?.materialId, 'scope material id', 200);
        const version = requirePositiveInt(raw?.version, 'scope version');
        const entry = { materialId, version };
        const key = keyOf(entry);
        if (seen.has(key))
            continue;
        seen.add(key);
        result.push(entry);
    }
    return result;
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
function requirePositiveInt(value, field) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        throw new CollaborationError('INVALID_ARGUMENT', `${field} must be a positive integer`, { field });
    }
    return value;
}
function truncate(text) {
    return text.length <= 60 ? text : `${text.slice(0, 57)}...`;
}
