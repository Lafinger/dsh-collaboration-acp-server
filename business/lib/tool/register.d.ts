/**
 * Tool registration.
 *
 * `ctx.inject(['tools'], cb)` runs `cb` once the tools service is available, and re-runs
 * it if that service is replaced — so registration must be idempotent per fiber, which the
 * container guarantees by disposing the previous fiber.
 *
 * The callback receives its OWN context; using the outer one would skip the injection
 * guarantee entirely.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { AnalysisService } from '../service/analysis-service.js';
import type { MaterialService } from '../service/material-service.js';
import type { NoticeService } from '../service/notice-service.js';
import type { PlanService } from '../service/plan-service.js';
import type { ProjectService } from '../service/project-service.js';
import type { ResultService } from '../service/result-service.js';
import type { SessionIdentityService } from '../service/session-identity-service.js';
import type { TaskService } from '../service/task-service.js';
import type { TraceService } from '../service/trace-service.js';
export interface Services {
    readonly projects: ProjectService;
    readonly materials: MaterialService;
    readonly analyses: AnalysisService;
    readonly plans: PlanService;
    readonly tasks: TaskService;
    readonly results: ResultService;
    readonly notices: NoticeService;
    readonly traces: TraceService;
    readonly identities: SessionIdentityService;
}
export declare function registerTools(ctx: Context, services: Services, transform?: (definition: ToolDefinition) => ToolDefinition): void;
