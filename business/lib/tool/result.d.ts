/**
 * Tool result envelope.
 *
 * Every tool answers with a plain object carrying `ok`. Failures are normal answers, not
 * exceptions: a rejected write must tell the model WHY, in words it can act on.
 */
import type { JsonObject, JsonValue } from './json.js';
export interface ToolFailure extends JsonObject {
    readonly ok: false;
    readonly code: string;
    readonly message: string;
    readonly details?: JsonValue;
}
export type ToolResult<T extends JsonObject> = ({
    readonly ok: true;
} & T) | ToolFailure;
export declare function fail(code: string, message: string, details?: JsonValue): ToolFailure;
/**
 * Run a tool body, converting a thrown domain error into a structured failure.
 *
 * The returned value is asserted to be deliverable JSON: a result the host would silently
 * drop is a bug we want to surface here, in our own code, rather than as a mystery in the
 * model's transcript.
 */
export declare function runTool<T extends JsonObject>(body: () => Promise<T> | T): Promise<ToolResult<T>>;
