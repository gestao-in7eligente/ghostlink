import { OWNER_STATUS_LIMITS, buildOwnerStatusMessage, fromBase64Url } from '@ghostlink/shared';
import type { Db } from '../db/database.js';
import { verifyAuthSignature } from '../auth/identity.js';

const TS = /^(?:0|[1-9][0-9]{0,15})$/;
/** base64url of a 64-byte Ed25519 signature, unpadded. */
const SIG = /^[A-Za-z0-9_-]{86}$/;

/** `ts` and `sig`, each exactly once and nothing else, in their canonical forms; null otherwise. */
export function parseOwnerStatusQuery(query: string): { ts: number; signature: Uint8Array } | null {
  const fields = new Map<string, string>();
  for (const part of query.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) return null;
    const key = part.slice(0, eq);
    if ((key !== 'ts' && key !== 'sig') || fields.has(key)) return null;
    fields.set(key, part.slice(eq + 1));
  }
  const ts = fields.get('ts');
  const sig = fields.get('sig');
  if (ts === undefined || sig === undefined || !TS.test(ts) || !SIG.test(sig)) return null;
  const n = Number(ts);
  if (!Number.isSafeInteger(n)) return null;
  try {
    return { ts: n, signature: fromBase64Url(sig) };
  } catch {
    return null;
  }
}

/** The raw public key of the current owner (a member), or null while the server has none. */
export function ownerPublicKey(db: Db): Uint8Array | null {
  const row = db.get<{ public_key: Uint8Array }>(
    'SELECT u.public_key FROM server_meta m JOIN users u ON u.id = m.owner_user_id WHERE m.id = 1 AND u.removed_at IS NULL',
  );
  return row ? new Uint8Array(row.public_key) : null;
}

/**
 * True when `query` is `ts=<unix seconds>&sig=<base64url>`, `ts` is within
 * OWNER_STATUS_LIMITS.maxSkewSeconds of `nowMs`, and `sig` is the owner's Ed25519 signature of
 * buildOwnerStatusMessage(serverKeyId, ts) (servers follow the app, §2). Never throws.
 */
export function verifyOwnerStatusQuery(query: string, deps: { serverKeyId: string; nowMs: number; ownerKey: Uint8Array | null }): boolean {
  if (!deps.ownerKey) return false;
  const parsed = parseOwnerStatusQuery(query);
  if (!parsed) return false;
  if (Math.abs(deps.nowMs / 1000 - parsed.ts) > OWNER_STATUS_LIMITS.maxSkewSeconds) return false;
  let message: Uint8Array;
  try {
    message = buildOwnerStatusMessage(deps.serverKeyId, parsed.ts);
  } catch {
    return false;
  }
  return verifyAuthSignature(deps.ownerKey, message, parsed.signature);
}
