/**
 * Project business rules (ADR-0002: rules live in service, not in SQL).
 *
 * MVP-001: never invent a missing background or goal.
 * MVP-004: members are mutable labels — changing one is a plain update with no
 *          handover, approval or history requirement.
 * MVP-005: archiving is a one-way stop on writes.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { CreateProjectInput, Project, ProjectId, ProjectView, ProjectWithRolesView, UpdateProjectDetailsInput } from '../domain/project.js';
export interface Clock {
    now(): string;
}
export declare const systemClock: Clock;
export declare function toView(project: Project): ProjectView;
export declare class ProjectService {
    private readonly db;
    private readonly clock;
    private readonly projects;
    constructor(db: DatabaseSync, clock?: Clock);
    create(input: CreateProjectInput): ProjectView;
    get(id: ProjectId): ProjectView;
    getWithRoles(id: ProjectId): ProjectWithRolesView;
    list(includeArchived?: boolean): readonly ProjectView[];
    /**
     * Set or clear the current role assignment; retained decisions are never rewritten.
     * Replacing an assigned member suspends pending affected plans until human revision.
     * Access/administrator eligibility is enforced by the authenticated service boundary.
     */
    setMember(projectId: ProjectId, role: string, member: string | null): void;
    /** Plain explicit details update, not a plan decision or replacement project. */
    updateDetails(input: UpdateProjectDetailsInput): ProjectView;
    archive(projectId: ProjectId): ProjectView;
    private requireProject;
    private requireWritable;
}
