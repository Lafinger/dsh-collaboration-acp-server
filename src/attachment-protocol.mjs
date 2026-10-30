import { AccessError } from './protocol.mjs';
export const ATTACHMENT_PROTOCOL_VERSION = 2;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENTS = 5;
export const ATTACHMENT_CHUNK_BYTES = 48 * 1024;
export const MAX_ATTACHMENT_TEXT_BYTES = 256 * 1024;
export const attachmentCapability = () => ({ version: ATTACHMENT_PROTOCOL_VERSION });
export function requireAttachmentCapability(value) {
  if (value?.version !== ATTACHMENT_PROTOCOL_VERSION) throw new AccessError(-32012, 'Matching attachment-capable client and server required; no upload downgrade or prompt replay');
}
export function safeAttachmentName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 240 || /[\\/\x00-\x1f\x7f]/.test(value) || value === '.' || value === '..') throw new AccessError(-32602, 'Invalid attachment display name');
  if (/\.gif$/i.test(value)) throw new AccessError(-32602, 'GIF uploads are not allowed; select a PNG, JPEG or WebP original instead');
  return value;
}
/** Attachments are an inventory, not an authorization: bytes are ingested at prompt time
 * and the model decides read/archive in conversation. No per-action client grants. */
export function validateAttachmentManifest(value) {
  if (!Array.isArray(value) || value.length > MAX_MESSAGE_ATTACHMENTS) throw new AccessError(-32602, 'Too many attachments');
  const ids = new Set(); let total = 0;
  for (const item of value) {
    if (!item || typeof item !== 'object' || !/^[a-f0-9]{64}$/.test(item.handle ?? '') || ids.has(item.handle)) throw new AccessError(-32602, 'Invalid attachment handle');
    ids.add(item.handle); safeAttachmentName(item.name);
    if (!/^[a-f0-9]{64}$/.test(item.sha256 ?? '') || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > MAX_ATTACHMENT_BYTES) throw new AccessError(-32602, 'Invalid attachment size/digest');
    if (!/^[a-f0-9]{32}$/.test(item.projectId ?? '')) throw new AccessError(-32602, 'Explicit current-message project_id required');
    if (!['local-path', 'file-attachment', 'normalized-image'].includes(item.sourceKind)) throw new AccessError(-32602, 'Invalid attachment source kind');
    if (Object.keys(item).some(key => !['handle','name','sha256','bytes','projectId','sourceKind'].includes(key))) throw new AccessError(-32602, 'Unexpected attachment metadata');
    total += item.bytes;
  }
  if (total > MAX_ATTACHMENT_BYTES) throw new AccessError(-32602, 'Attachment message exceeds 20MiB total');
  return value;
}
