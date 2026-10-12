import { ROLE_IDS, ROLE_LABELS } from '../domain/roles.js';
function toProject(row) {
    return {
        id: row.id,
        key: row.key,
        name: row.name,
        background: row.background,
        goal: row.goal,
        archivedAt: row.archived_at,
        createdAt: row.created_at,
    };
}
export class ProjectRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    insert(project) {
        this.db
            .prepare(`INSERT INTO projects (id, key, name, background, goal, archived_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(project.id, project.key, project.name, project.background, project.goal, project.archivedAt, project.createdAt);
    }
    findById(id) {
        const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
        return row === undefined ? null : toProject(row);
    }
    findByKey(key) {
        const row = this.db.prepare('SELECT * FROM projects WHERE key = ?').get(key);
        return row === undefined ? null : toProject(row);
    }
    list(includeArchived) {
        const sql = includeArchived
            ? 'SELECT * FROM projects ORDER BY created_at DESC, id DESC'
            : 'SELECT * FROM projects WHERE archived_at IS NULL ORDER BY created_at DESC, id DESC';
        const rows = this.db.prepare(sql).all();
        return rows.map(toProject);
    }
    /**
     * All nine roles, with the member label joined in. Roles without a row in
     * project_roles are reported as vacant rather than omitted — the caller always needs
     * the full picture to decide whether a plan can be confirmed (ADR-0004).
     */
    rolesOf(projectId) {
        const rows = this.db
            .prepare('SELECT role, member_label FROM project_roles WHERE project_id = ?')
            .all(projectId);
        const byRole = new Map(rows.map((r) => [r.role, r.member_label]));
        return ROLE_IDS.map((role) => ({
            role,
            label: ROLE_LABELS[role],
            member: byRole.get(role) ?? null,
        }));
    }
    setMember(projectId, role, member, at) {
        this.db
            .prepare(`INSERT INTO project_roles (project_id, role, member_label, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (project_id, role)
         DO UPDATE SET member_label = excluded.member_label, updated_at = excluded.updated_at`)
            .run(projectId, role, member, at);
    }
    archive(projectId, at) {
        this.db.prepare('UPDATE projects SET archived_at = ? WHERE id = ?').run(at, projectId);
    }
}
