/**
 * Tool result envelope.
 *
 * Every tool answers with a plain object carrying `ok`. Failures are normal answers, not
 * exceptions: a rejected write must tell the model WHY, in words it can act on.
 */
import type { JsonObject, JsonValue } from './json.js'
import { isJsonValue } from './json.js'
import { isWorkbenchError } from '../domain/error.js'

export interface ToolFailure extends JsonObject {
  readonly ok: false
  readonly code: string
  readonly message: string
  readonly details?: JsonValue
}

export type ToolResult<T extends JsonObject> = ({ readonly ok: true } & T) | ToolFailure

export function fail(code: string, message: string, details?: JsonValue): ToolFailure {
  return details === undefined ? { ok: false, code, message } : { ok: false, code, message, details }
}

/**
 * Run a tool body, converting a thrown domain error into a structured failure.
 *
 * The returned value is asserted to be deliverable JSON: a result the host would silently
 * drop is a bug we want to surface here, in our own code, rather than as a mystery in the
 * model's transcript.
 */
export async function runTool<T extends JsonObject>(
  body: () => Promise<T> | T,
): Promise<ToolResult<T>> {
  let result: ToolResult<T>
  try {
    const value = await body()
    result = { ok: true, ...value }
  } catch (error) {
    if (isWorkbenchError(error)) {
      result =
        error.details === undefined
          ? fail(error.code, error.message)
          : fail(error.code, error.message, error.details as JsonValue)
    } else {
      result = fail('INTERNAL', error instanceof Error ? error.message : String(error))
    }
  }

  if (!isJsonValue(result)) {
    return fail(
      'INTERNAL',
      'tool produced a result that is not deliverable JSON (check for undefined values)',
    )
  }
  return result
}
