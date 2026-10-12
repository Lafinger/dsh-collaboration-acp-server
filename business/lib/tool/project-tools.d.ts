import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { JsonValue } from './json.js';
import type { ProjectService } from '../service/project-service.js';
import type { PlanService } from '../service/plan-service.js';
/**
 * MVP-003 wants the overview to show the project's 当前正式计划. A project CAN have more than one
 * activated plan — each activation creates its own tasks and nothing retires the previous one —
 * so this reports EVERY active plan rather than silently picking one. With a single active plan
 * the caller sees a one-element list, which is the ordinary case.
 *
 * Exported for tests: the overview's plan field is exactly what MVP-003's acceptance criterion
 * names, so it is tested directly rather than only through `execute`.
 */
export declare function activePlansToJson(plans: PlanService, projectId: string): readonly JsonValue[];
export declare function projectToolDefinitions(service: ProjectService, plans: PlanService): ToolDefinition[];
