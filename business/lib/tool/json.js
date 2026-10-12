/**
 * Structural guard mirroring the host's lossless-JSON rule, used to assert that a tool
 * result is deliverable before it is handed back.
 */
export function isJsonValue(value) {
    if (value === null)
        return true;
    const t = typeof value;
    if (t === 'boolean' || t === 'string')
        return true;
    if (t === 'number')
        return Number.isFinite(value);
    if (Array.isArray(value))
        return value.every(isJsonValue);
    if (t === 'object') {
        for (const key of Object.keys(value)) {
            const child = value[key];
            // An explicit `undefined` is the exact failure mode this guards against.
            if (child === undefined)
                return false;
            if (!isJsonValue(child))
                return false;
        }
        return true;
    }
    return false;
}
