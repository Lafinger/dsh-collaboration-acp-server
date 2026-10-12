import { WorkbenchError } from '../domain/error.js';
import { newId } from '../domain/ids.js';
import { assertWritable, isArchived, pendingFields } from '../domain/project.js';
import { isRoleId } from '../domain/roles.js';
import { ProjectRepository } from '../sqlite/project-repository.js';
import { inTransaction } from '../sqlite/schema.js';
import { isUniqueViolation } from '../sqlite/errors.js';
const MAX_KEY_LENGTH = 64;
const MAX_NAME_LENGTH = 200;
export const systemClock = { now: () => new Date().toISOString() };
export function toView(project) {
    return { ...project, pendingFields: pendingFields(project) };
}
export class ProjectService {
    db;
    clock;
    projects;
    constructor(db, clock = systemClock) {
        this.db = db;
        this.clock = clock;
        this.projects = new ProjectRepository(db);
    }
    create(input) {
        const key = normaliseKey(input.key);
        const name = requireText(input.name, 'name', MAX_NAME_LENGTH);
        // Absent stays absent. An empty string is normalised to null so "not provided" has
        // exactly one representation downstream (MVP-001).
        const background = optionalText(input.background, MAX_NAME_LENGTH * 10);
        const goal = optionalText(input.goal, MAX_NAME_LENGTH * 10);
        const project = {
            id: newId(),
            key,
            name,
            background,
            goal,
            archivedAt: null,
            createdAt: this.clock.now(),
        };
        try {
            this.projects.insert(project);
        }
        catch (error) {
            if (isUniqueViolation(error)) {
                throw new WorkbenchError('PROJECT_EXISTS', `project key "${key}" is already in use`, { key });
            }
            throw error;
        }
        return toView(project);
    }
    get(id) {
        return toView(this.requireProject(id));
    }
    getWithRoles(id) {
        const project = this.requireProject(id);
        return { ...toView(project), roles: this.projects.rolesOf(id) };
    }
    list(includeArchived = false) {
        return this.projects.list(includeArchived).map(toView);
    }
    /**
     * Set or clear a role's member. No approval, no history — by design (ADR-0004).
     * `null` vacates the slot, which later blocks plan confirmation.
     */
    setMember(projectId, role, member) {
        this.requireWritable(projectId);
        if (!isRoleId(role)) {
            throw new WorkbenchError('ROLE_UNKNOWN', `unknown role "${role}"`, { role });
        }
        const label = member === null ? null : requireText(member, 'member', 120);
        this.projects.setMember(projectId, role, label, this.clock.now());
    }
    archive(projectId) {
        const project = this.requireProject(projectId);
        if (isArchived(project))
            return toView(project);
        inTransaction(this.db, () => this.projects.archive(projectId, this.clock.now()));
        return this.get(projectId);
    }
    requireProject(id) {
        const project = this.projects.findById(id);
        if (project === null) {
            throw new WorkbenchError('PROJECT_NOT_FOUND', `no project with id ${id}`, { id });
        }
        return project;
    }
    requireWritable(id) {
        // The shared gate, so every service refuses an archived project identically.
        return assertWritable(this.requireProject(id), id);
    }
}
function requireText(value, field, max) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new WorkbenchError('INVALID_ARGUMENT', `${field} is required`, { field });
    }
    const trimmed = value.trim();
    if (trimmed.length > max) {
        throw new WorkbenchError('INVALID_ARGUMENT', `${field} exceeds ${max} characters`, { field });
    }
    return trimmed;
}
function optionalText(value, max) {
    if (value === undefined || value === null)
        return null;
    if (typeof value !== 'string') {
        throw new WorkbenchError('INVALID_ARGUMENT', 'expected a string', {});
    }
    const trimmed = value.trim();
    if (trimmed === '')
        return null;
    if (trimmed.length > max) {
        throw new WorkbenchError('INVALID_ARGUMENT', `value exceeds ${max} characters`, {});
    }
    return trimmed;
}
/** Project keys appear in paths and queries, so restrict them to a safe alphabet. */
function normaliseKey(value) {
    const raw = requireText(value, 'key', MAX_KEY_LENGTH);
    const key = raw.toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(key)) {
        throw new WorkbenchError('INVALID_ARGUMENT', 'key must start with a letter or digit and contain only letters, digits, "-" or "_"', { key: raw });
    }
    return key;
}
