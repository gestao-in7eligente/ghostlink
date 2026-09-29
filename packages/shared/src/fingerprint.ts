import { fromBase64Url, toBase32 } from './encoding.js';
import { ProtocolError } from './errors.js';

/**
 * Human-comparable fingerprint (spec §3.3 TOFU): the first 20 bytes (160 bits)
 * of the serverKeyId in base32, as 4 groups of 8 characters.
 */
export function formatFingerprint(serverKeyId: string): string {
  const bytes = fromBase64Url(serverKeyId);
  if (bytes.length !== 32) throw new ProtocolError('BAD_REQUEST', 'serverKeyId must be 32 bytes');
  const b32 = toBase32(bytes.subarray(0, 20));
  return [b32.slice(0, 8), b32.slice(8, 16), b32.slice(16, 24), b32.slice(24, 32)].join(' ');
}
