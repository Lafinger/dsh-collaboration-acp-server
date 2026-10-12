export function roleDirOf(role) {
    return role ?? '_shared';
}
export function isUnreadable(version) {
    return version.issue !== null;
}
/** Materials are only ever append-only, so a version number is stable once written. */
export function referenceOf(material, version) {
    return { materialId: material.id, version };
}
