import { CollaborationError } from '../domain/error.js';
import { slotKey, unreadOf, } from '../domain/notice.js';
import { ROLE_IDS } from '../domain/roles.js';
import { NoticeRepository } from '../sqlite/notice-repository.js';
import { ProjectRepository } from '../sqlite/project-repository.js';
import { systemClock } from './project-service.js';
export class NoticeService {
    clock;
    notices;
    projects;
    constructor(db, clock = systemClock) {
        this.clock = clock;
        this.notices = new NoticeRepository(db);
        this.projects = new ProjectRepository(db);
    }
    /** Every undecided slot in a project, as todos. */
    todos(filter) {
        this.requireProject(filter.projectId);
        const members = this.membersOf(filter.projectId);
        const kinds = filter.kinds;
        const roles = filter.roles;
        const rows = this.notices.pendingTodos(filter.projectId).filter((r) => {
            if (kinds !== undefined && kinds.length > 0 && !kinds.includes(r.kind))
                return false;
            if (roles !== undefined && roles.length > 0 && !roles.includes(r.role))
                return false;
            return true;
        });
        const read = this.notices.readKeys(rows.map((r) => slotKeyOf(r)));
        const todos = rows.map((r) => {
            const ref = slotRefOf(r);
            const isRead = read.has(slotKey(ref));
            return {
                kind: r.kind,
                projectId: r.project_id,
                objectId: r.object_id,
                version: Number(r.version),
                role: r.role,
                taskId: r.task_id,
                summary: r.summary,
                createdAt: r.created_at,
                member: members.get(r.role) ?? null,
                read: isRead,
            };
        });
        return filter.unreadOnly === true ? todos.filter((t) => !t.read) : todos;
    }
    /** Informational items. Reading one decides nothing. */
    list(filter) {
        this.requireProject(filter.projectId);
        const members = this.membersOf(filter.projectId);
        const kinds = filter.kinds;
        const roles = filter.roles;
        const rows = this.notices.notices(filter.projectId).filter((r) => {
            if (kinds !== undefined && kinds.length > 0 && !kinds.includes(r.kind))
                return false;
            if (roles !== undefined && roles.length > 0 && !roles.includes(r.role))
                return false;
            return true;
        });
        const read = this.notices.readKeys(rows.map((r) => slotKeyOf(r)));
        const notices = rows.map((r) => {
            const ref = slotRefOf(r);
            return {
                kind: r.kind,
                projectId: r.project_id,
                objectId: r.object_id,
                version: Number(r.version),
                role: r.role,
                taskId: r.task_id,
                summary: r.summary,
                detail: r.detail,
                createdAt: r.created_at,
                member: members.get(r.role) ?? null,
                read: read.has(slotKey(ref)),
            };
        });
        return filter.unreadOnly === true ? notices.filter((n) => !n.read) : notices;
    }
    /**
     * What each role currently owes.
     *
     * Only todos count. A notice is never "owed", so it never contributes to unread.
     */
    unread(projectId) {
        this.requireProject(projectId);
        const members = this.membersOf(projectId);
        const rows = this.notices.pendingTodos(projectId);
        const read = this.notices.readKeys(rows.map((r) => slotKeyOf(r)));
        return ROLE_IDS.map((role) => {
            const mine = rows.filter((r) => r.role === role);
            const alreadyRead = mine.filter((r) => read.has(slotKey(slotRefOf(r)))).length;
            const member = members.get(role) ?? null;
            return {
                role,
                pending: mine.length,
                read: alreadyRead,
                unread: unreadOf(mine.length, alreadyRead, member),
            };
        });
    }
    /**
     * Mark one slot as read for the role it belongs to.
     *
     * Reading changes NO business state — that is the whole point of MVP-030. It does not
     * approve a plan, complete a task, or accept a result.
     *
     * The slot MUST currently exist, which is checked rather than assumed: without that check,
     * marking a mistyped id read stored a row nothing could ever match while reporting success.
     * A read nobody can observe is worse than a rejection.
     */
    markRead(ref) {
        this.requireProject(ref.projectId);
        if (!this.slotExists(ref)) {
            throw new CollaborationError('NOTICE_NOT_FOUND', `no todo or notice at ${ref.kind} ${ref.objectId} v${ref.version} for role ${ref.role}`, {
                kind: ref.kind,
                objectId: ref.objectId,
                version: ref.version,
                role: ref.role,
            });
        }
        const changed = this.notices.markRead(ref, this.clock.now(), null);
        return { changed };
    }
    /**
     * Whether this address corresponds to a slot that currently exists.
     *
     * Checks the SLOT TABLES rather than the derived lists, because a decided or voided slot
     * still exists as a record while correctly no longer being a todo. Deriving existence from
     * the todo list alone would reject a legitimate read of history.
     */
    slotExists(ref) {
        return this.notices.slotExists(ref);
    }
    /** Mark everything a role currently owes in a project as read. */
    markAllRead(projectId, role) {
        this.requireProject(projectId);
        const at = this.clock.now();
        let changed = 0;
        for (const t of this.todos({ projectId, roles: [role] })) {
            if (this.notices.markRead(slotRefOfTodo(t), at, null))
                changed++;
        }
        return changed;
    }
    isRead(ref) {
        return this.notices.isRead(ref);
    }
    membersOf(projectId) {
        const map = new Map();
        for (const slot of this.projects.rolesOf(projectId)) {
            map.set(slot.role, slot.member);
        }
        return map;
    }
    requireProject(projectId) {
        if (this.projects.findById(projectId) === null) {
            throw new CollaborationError('PROJECT_NOT_FOUND', `no project with id ${projectId}`, {
                projectId,
            });
        }
    }
}
function slotRefOf(row) {
    return {
        kind: row.kind,
        projectId: '',
        objectId: row.object_id,
        version: Number(row.version),
        role: row.role,
        taskId: row.task_id,
    };
}
function slotRefOfTodo(t) {
    return {
        kind: t.kind,
        projectId: t.projectId,
        objectId: t.objectId,
        version: t.version,
        role: t.role,
        taskId: t.taskId,
    };
}
function slotKeyOf(row) {
    return slotKey(slotRefOf(row));
}
