import { createHmac, timingSafeEqual } from 'node:crypto';
import { FILE_URL_MAX_AHEAD_S, fileSignatureInput } from '@ghostlink/shared';

const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const EXPIRY = /^[0-9]{1,12}$/;
/** base64url of an HMAC-SHA256, unpadded. */
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Checks the query of a signed file URL (main spec §7):
 * `sid=<sessionId>&e=<expUnix>&s=<base64url(HMAC-SHA256(fileToken, fileSignatureInput(target, sid, e)))>`.
 * The HMAC key is the welcome's `fileToken` string as sent (its UTF-8 bytes), and the
 * session must be current. Refuses an expired `e`, an `e` more than FILE_URL_MAX_AHEAD_S
 * ahead, and any parameter missing, repeated or malformed. Returns the signing session's id,
 * or null.
 */
export function verifySignedQuery(
  query: string,
  target: string,
  nowMs: number,
  fileTokenOf: (sessionId: string) => string | null,
): string | null {
  const params = new URLSearchParams(query);
  const one = (name: string): string | null => {
    const values = params.getAll(name);
    return values.length === 1 ? values[0]! : null;
  };
  const sid = one('sid');
  const e = one('e');
  const s = one('s');
  if (sid === null || e === null || s === null) return null;
  if (!SESSION_ID.test(sid) || !EXPIRY.test(e) || !SIGNATURE.test(s)) return null;
  const exp = Number(e);
  if (exp * 1000 < nowMs || exp * 1000 - nowMs > FILE_URL_MAX_AHEAD_S * 1000) return null;
  const key = fileTokenOf(sid);
  if (key === null) return null;
  const expected = Buffer.from(createHmac('sha256', key).update(fileSignatureInput(target, sid, exp)).digest('base64url'), 'latin1');
  const given = Buffer.from(s, 'latin1');
  return given.length === expected.length && timingSafeEqual(given, expected) ? sid : null;
}
