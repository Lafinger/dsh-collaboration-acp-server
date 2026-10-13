/**
 * Project persistence. No business judgement here — this layer only reads and writes
 * (ADR-0002). Uniqueness of `key` is enforced by the schema, not by a pre-check.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Project, ProjectId } from '../domain/project.js';
import type { RoleAssignment, RoleId } from '../domain/roles.js';
export declare class ProjectRepository {
    private readonly db;
    constructor(db: DatabaseSync);
    insert(project: Project): void;
    findById(id: ProjectId): Project | null;
    findByKey(key: string): Project | null;
    list(includeArchived: boolean): readonly Project[];
    /**
     * All nine roles, with the member label joined in. Roles without a row in
     * project_roles are reported as vacant rather than omitted — the caller always needs
     * the full picture to decide whether a plan can be confirmed (ADR-0004).
     */
    rolesOf(projectId: ProjectId): readonly RoleAssignment[];
    setMember(projectId: ProjectId, role: RoleId, member: string | null, at: string): void;
    updateDetails(projectId: ProjectId, background: string | null, goal: string | null): void;
    archive(projectId: ProjectId, at: string): void;
}
