import { createHash, createPublicKey, verify } from 'node:crypto';
import { ProtocolError } from '@ghostlink/shared';

/**
 * Encodings of the 8 small-order Ed25519 points (plus non-canonical twins),
 * compared with the sign bit cleared — the same blocklist libsodium uses.
 * With such a "public key" nobody holds a private key, yet some forged
 * signatures (e.g. all zeros) verify for a fraction of messages.
 */
const SMALL_ORDER_KEYS: readonly Buffer[] = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
].map((hex) => Buffer.from(hex, 'hex'));

export function isWeakPublicKey(raw: Uint8Array): boolean {
  if (raw.length !== 32) return true;
  const masked = Buffer.from(raw);
  masked[31]! &= 0x7f;
  return SMALL_ORDER_KEYS.some((k) => k.equals(masked));
}

/** userId = hex(SHA-256(raw 32-byte Ed25519 public key))[0:32] — 128 bits (spec §3.2). */
export function userIdFromPublicKey(raw: Uint8Array): string {
  if (raw.length !== 32) throw new ProtocolError('BAD_REQUEST', 'public key must be 32 bytes');
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

/** Ed25519 verification of a raw 32-byte public key (imported as an OKP JWK). Never throws. */
export function verifyAuthSignature(publicKeyRaw: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKeyRaw.length !== 32 || signature.length !== 64 || isWeakPublicKey(publicKeyRaw)) return false;
  try {
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKeyRaw).toString('base64url') },
      format: 'jwk',
    });
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}
