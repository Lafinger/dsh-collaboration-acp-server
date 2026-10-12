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
export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
export type JsonObject = {
    [key: string]: JsonValue;
};
/**
 * Structural guard mirroring the host's lossless-JSON rule, used to assert that a tool
 * result is deliverable before it is handed back.
 */
export declare function isJsonValue(value: unknown): value is JsonValue;
