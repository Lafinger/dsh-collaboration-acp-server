import { isJsonValue } from './json.js';
import { isWorkbenchError } from '../domain/error.js';
export function fail(code, message, details) {
    return details === undefined ? { ok: false, code, message } : { ok: false, code, message, details };
}
/**
 * Run a tool body, converting a thrown domain error into a structured failure.
 *
 * The returned value is asserted to be deliverable JSON: a result the host would silently
 * drop is a bug we want to surface here, in our own code, rather than as a mystery in the
 * model's transcript.
 */
export async function runTool(body) {
    let result;
    try {
        const value = await body();
        result = { ok: true, ...value };
    }
    catch (error) {
        if (isWorkbenchError(error)) {
            result =
                error.details === undefined
                    ? fail(error.code, error.message)
                    : fail(error.code, error.message, error.details);
        }
        else {
            result = fail('INTERNAL', error instanceof Error ? error.message : String(error));
        }
    }
    if (!isJsonValue(result)) {
        return fail('INTERNAL', 'tool produced a result that is not deliverable JSON (check for undefined values)');
    }
    return result;
}
