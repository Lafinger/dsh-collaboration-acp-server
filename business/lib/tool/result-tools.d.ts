import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { Services } from './register.js';
export declare function resultToolDefinitions(services: Services, declaredMemberOf?: (exec: unknown) => string | null): readonly ToolDefinition[];
