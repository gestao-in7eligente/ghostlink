import { CRYPTO_LABELS } from './constants.js';
import { utf8 } from './encoding.js';
import { ProtocolError } from './errors.js';

const B64U_32_BYTES = /^[A-Za-z0-9_-]{43}$/;

/**
 * The exact bytes a client signs in `auth.proof` (spec §3.3):
 * UTF-8 of "ghostlink-auth-v1\n" + serverKeyId + "\n" + nonce.
 * Both inputs must be base64url of 32 bytes, so neither can smuggle a '\n'
 * and shift the field boundaries.
 */
export function buildAuthMessage(serverKeyId: string, nonceB64u: string): Uint8Array {
  if (!B64U_32_BYTES.test(serverKeyId) || !B64U_32_BYTES.test(nonceB64u)) {
    throw new ProtocolError('BAD_REQUEST', 'serverKeyId and nonce must be base64url of 32 bytes');
  }
  return utf8(`${CRYPTO_LABELS.authPrefix}\n${serverKeyId}\n${nonceB64u}`);
}
