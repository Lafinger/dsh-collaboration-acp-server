import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { PlanService } from '../service/plan-service.js';
export declare function planToolDefinitions(service: PlanService, declaredMemberOf?: (exec: unknown) => string | null): ToolDefinition[];
