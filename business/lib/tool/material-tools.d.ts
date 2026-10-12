import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { MaterialService } from '../service/material-service.js';
declare const ROLE_ENUM: readonly ["pm", "product", "design", "scenemodel", "sceneart", "data", "frontend", "backend", "ue"];
export declare function materialToolDefinitions(service: MaterialService): ToolDefinition[];
export { ROLE_ENUM };
