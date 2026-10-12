import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { JsonObject } from './json.js';
import type { TaskWithVersions } from '../domain/task.js';
import type { TaskService } from '../service/task-service.js';
import type { ProjectService } from '../service/project-service.js';
type Json = JsonObject;
/**
 * Exported for tests. The tool OUTPUT is the contract a caller actually sees, and two MVP-022
 * fields were once stored but missing from it — so the projection is worth testing on its own
 * rather than only through `execute`, which needs host plumbing.
 */
export declare function taskToJson(t: TaskWithVersions, projects: ProjectService): Json;
/** The `task_get` projection, exported for tests. See `taskToJson` above. */
export declare function taskDetailToJson(t: TaskWithVersions, projects: ProjectService): Json;
export declare function taskToolDefinitions(service: TaskService, projects: ProjectService): ToolDefinition[];
export {};
