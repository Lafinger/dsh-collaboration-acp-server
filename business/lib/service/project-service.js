import { CollaborationError } from '../domain/error.js';
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
                throw new CollaborationError('PROJECT_EXISTS', `project key "${key}" is already in use`, { key });
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
     * Set or clear the current role assignment; retained decisions are never rewritten.
     * Replacing an assigned member suspends pending affected plans until human revision.
     * Access/administrator eligibility is enforced by the authenticated service boundary.
     */
    setMember(projectId, role, member) {
        this.requireWritable(projectId);
        if (!isRoleId(role)) {
            throw new CollaborationError('ROLE_UNKNOWN', `unknown role "${role}"`, { role });
        }
        const label = member === null ? null : requireText(member, 'member', 120);
        inTransaction(this.db, () => {
            const previous = this.projects.rolesOf(projectId).find((r) => r.role === role)?.member ?? null;
            if (previous !== null && previous !== label) {
                this.db.prepare(`INSERT OR IGNORE INTO plan_suspensions(plan_id,plan_version,at,reason)
          SELECT p.id,p.version,?,? FROM plans p JOIN plan_roles r ON r.plan_id=p.id AND r.version=p.version
          WHERE p.project_id=? AND r.role=? AND p.activated_at IS NULL
            AND p.version=(SELECT MAX(q.version) FROM plans q WHERE q.id=p.id)`)
                    .run(this.clock.now(), `Role ${role} assignment changed; explicitly revise and collect all decisions again`, projectId, role);
            }
            this.projects.setMember(projectId, role, label, this.clock.now());
        });
    }
    /** Plain explicit details update, not a plan decision or replacement project. */
    updateDetails(input) {
        const allowed = new Set(['projectId', 'background', 'goal']);
        if (Object.keys(input).some((key) => !allowed.has(key))) {
            throw new CollaborationError('INVALID_ARGUMENT', 'Only projectId, background and goal may be supplied', {});
        }
        const hasBackground = input.background !== undefined;
        const hasGoal = input.goal !== undefined;
        if (!hasBackground && !hasGoal) {
            throw new CollaborationError('INVALID_ARGUMENT', 'Provide at least one of background or goal; omitted fields remain unchanged', {});
        }
        const background = hasBackground ? requireText(input.background, 'background', MAX_NAME_LENGTH * 10) : undefined;
        const goal = hasGoal ? requireText(input.goal, 'goal', MAX_NAME_LENGTH * 10) : undefined;
        // Acquire the write lock before reading old values: an omitted field must retain the
        // latest stored value, and the archive gate and update form one atomic operation.
        return inTransaction(this.db, () => {
            const project = this.requireWritable(input.projectId);
            this.projects.updateDetails(project.id, background ?? project.background, goal ?? project.goal);
            return this.get(project.id);
        });
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
            throw new CollaborationError('PROJECT_NOT_FOUND', `no project with id ${id}`, { id });
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
        throw new CollaborationError('INVALID_ARGUMENT', `${field} is required`, { field });
    }
    const trimmed = value.trim();
    if (trimmed.length > max) {
        throw new CollaborationError('INVALID_ARGUMENT', `${field} exceeds ${max} characters`, { field });
    }
    return trimmed;
}
function optionalText(value, max) {
    if (value === undefined || value === null)
        return null;
    if (typeof value !== 'string') {
        throw new CollaborationError('INVALID_ARGUMENT', 'expected a string', {});
    }
    const trimmed = value.trim();
    if (trimmed === '')
        return null;
    if (trimmed.length > max) {
        throw new CollaborationError('INVALID_ARGUMENT', `value exceeds ${max} characters`, {});
    }
    return trimmed;
}
/** Project keys appear in paths and queries, so restrict them to a safe alphabet. */
function normaliseKey(value) {
    const raw = requireText(value, 'key', MAX_KEY_LENGTH);
    const key = raw.toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(key)) {
        throw new CollaborationError('INVALID_ARGUMENT', 'key must start with a letter or digit and contain only letters, digits, "-" or "_"', { key: raw });
    }
    return key;
}
