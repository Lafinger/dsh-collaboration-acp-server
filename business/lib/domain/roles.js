/**
 * The nine roles are a FIXED set. A role is not a creatable entity — it is a slot.
 * See ADR-0004 (one member per role, all roles equal).
 */
export const ROLE_IDS = [
    'pm',
    'product',
    'design',
    'scenemodel',
    'sceneart',
    'data',
    'frontend',
    'backend',
    'ue',
];
/** Directory used when a material belongs to no role (e.g. a client-supplied original). */
export const SHARED_DIR = '_shared';
/** Human-facing labels. These live only in the app; directories use the stable ids above. */
export const ROLE_LABELS = {
    pm: '项目管理',
    product: '产品',
    design: '设计',
    scenemodel: '场景模型',
    sceneart: '场景美术',
    data: '数据',
    frontend: '前端',
    backend: '后端',
    ue: 'UE端',
};
const ROLE_SET = new Set(ROLE_IDS);
export function isRoleId(value) {
    return typeof value === 'string' && ROLE_SET.has(value);
}
export function isRoleDir(value) {
    return value === SHARED_DIR || isRoleId(value);
}
