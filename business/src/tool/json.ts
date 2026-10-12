/**
 * JSON types for tool inputs and outputs.
 *
 * Note on `undefined`: a property whose value is `undefined` breaks the host's
 * "lossless JSON" check, and the ENTIRE tool result is discarded — the tool runs, but the
 * model never sees the answer. Verified against the SDK's own `snapshotJsonValue`, which
 * rejects such objects (see the pre-implementation checklist §7.7).
 *
 * So: omit the key, or use `null`. Never assign `undefined`.
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export type JsonObject = { [key: string]: JsonValue }

/**
 * Structural guard mirroring the host's lossless-JSON rule, used to assert that a tool
 * result is deliverable before it is handed back.
 */
export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true
  const t = typeof value
  if (t === 'boolean' || t === 'string') return true
  if (t === 'number') return Number.isFinite(value as number)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (t === 'object') {
    for (const key of Object.keys(value as object)) {
      const child = (value as Record<string, unknown>)[key]
      // An explicit `undefined` is the exact failure mode this guards against.
      if (child === undefined) return false
      if (!isJsonValue(child)) return false
    }
    return true
  }
  return false
}
