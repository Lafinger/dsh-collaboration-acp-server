import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { SessionIdentityService } from '../service/session-identity-service.js';
/**
 * The session id comes from the execution context, never from the model.
 *
 * If it came from a parameter, a caller could claim to be a different session and inherit
 * someone else's declared identity — which would make the whole check decorative.
 */
export declare function sessionToolDefinitions(identities: SessionIdentityService, sessionIdOf: (exec: ToolRunContext) => string | null): ToolDefinition[];
