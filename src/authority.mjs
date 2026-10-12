import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { AccessError, requireText } from './protocol.mjs';

function mac(secret, payload) { return createHmac('sha256', secret).update(payload).digest('hex'); }
export function issueTicket({ account, serviceId, secret }, now = Date.now()) {
  const claims = { account, serviceId, issuedAt: now, expiresAt: now + 30000, nonce: randomUUID() };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return { payload, signature: mac(secret, payload) };
}
/** One different secret per SSH account. No shared signing key is exposed to members. */
export class AccountAuthority {
  constructor({ serviceId, accounts, now = Date.now }) {
    this.serviceId = requireText(serviceId, 'serviceId', 200); this.now = now; this.used = new Map();
    this.accounts = new Map();
    const secrets = new Set();
    for (const [account, secret] of Object.entries(accounts ?? {})) {
      requireText(account, 'account', 200); requireText(secret, 'account secret', 1024);
      if (secret.length < 64 || secrets.has(secret)) throw new Error('Require distinct secrets of at least 64 characters per account');
      secrets.add(secret); this.accounts.set(account, secret);
    }
    if (!this.accounts.size) throw new Error('No configured member accounts');
  }
  verify(ticket) {
    const deny = () => { throw new AccessError(-32003, 'Connection authentication failed'); };
    if (!ticket || typeof ticket.payload !== 'string' || ticket.payload.length > 4096 || !/^[a-f0-9]{64}$/.test(ticket.signature ?? '')) return deny();
    let claims;
    try { claims = JSON.parse(Buffer.from(ticket.payload, 'base64url').toString('utf8')); } catch { return deny(); }
    const secret = this.accounts.get(claims?.account);
    if (!secret || !timingSafeEqual(Buffer.from(mac(secret, ticket.payload), 'hex'), Buffer.from(ticket.signature, 'hex'))) return deny();
    const now = this.now();
    if (claims.serviceId !== this.serviceId || !Number.isSafeInteger(claims.issuedAt) || !Number.isSafeInteger(claims.expiresAt)
      || claims.expiresAt <= now || claims.issuedAt > now + 5000 || claims.expiresAt - claims.issuedAt !== 30000
      || typeof claims.nonce !== 'string' || !/^[0-9a-f-]{36}$/.test(claims.nonce)) return deny();
    for (const [nonce, expiry] of this.used) if (expiry <= now) this.used.delete(nonce);
    if (this.used.has(claims.nonce)) return deny();
    this.used.set(claims.nonce, claims.expiresAt);
    return Object.freeze({ account: claims.account, serviceId: claims.serviceId });
  }
}
