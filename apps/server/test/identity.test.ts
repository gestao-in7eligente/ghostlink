import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ProtocolError, buildAuthMessage, toBase64Url } from '@ghostlink/shared';
import { isWeakPublicKey, userIdFromPublicKey, verifyAuthSignature } from '../src/auth/identity.js';
import { makeIdentity } from './helpers/identity.js';

const KEY_ID = toBase64Url(new Uint8Array(32).fill(9));
const NONCE = toBase64Url(new Uint8Array(32).fill(4));

describe('userIdFromPublicKey', () => {
  it('is the first 32 hex chars (128 bits) of SHA-256(raw key)', () => {
    const id = makeIdentity(new Uint8Array(32).fill(1));
    const expected = createHash('sha256').update(id.publicKeyRaw).digest('hex').slice(0, 32);
    expect(userIdFromPublicKey(id.publicKeyRaw)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{32}$/);
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => userIdFromPublicKey(new Uint8Array(31))).toThrow(ProtocolError);
  });
});

describe('verifyAuthSignature', () => {
  const id = makeIdentity(new Uint8Array(32).fill(2));
  const message = buildAuthMessage(KEY_ID, NONCE);
  const signature = id.sign(message);

  it('matches a known-answer vector (seed 0x02×32, PKCS#8 prefix from spec §3.2)', () => {
    // Ed25519 is deterministic: a change here means desktop and server disagree on key derivation.
    expect(id.publicKey).toBe('gTl3Dqh9F19Wo1Rmw0x-zMuNipG07jeiXfYPW4_Js5Q');
    expect(Buffer.from(signature).toString('base64url'))
      .toBe('96sonYXPGBB46leSsN_GzWb2S3nqAdeTWpzo9I66DsLE2flRlj9WUm699OUv4wBWNkRRjrg6XTPr022gYEG6Dw');
    expect(verifyAuthSignature(id.publicKeyRaw, message, signature)).toBe(true);
  });

  it('rejects a signature over another serverKeyId (proof relayed to a different server)', () => {
    const otherServer = buildAuthMessage(toBase64Url(new Uint8Array(32).fill(8)), NONCE);
    expect(verifyAuthSignature(id.publicKeyRaw, otherServer, signature)).toBe(false);
  });

  it('rejects a signature by another key, a flipped bit, and wrong lengths', () => {
    const other = makeIdentity(new Uint8Array(32).fill(3));
    expect(verifyAuthSignature(other.publicKeyRaw, message, signature)).toBe(false);
    const flipped = Uint8Array.from(signature);
    flipped[10]! ^= 1;
    expect(verifyAuthSignature(id.publicKeyRaw, message, flipped)).toBe(false);
    expect(verifyAuthSignature(id.publicKeyRaw, message, signature.subarray(0, 63))).toBe(false);
    expect(verifyAuthSignature(id.publicKeyRaw.subarray(0, 31), message, signature)).toBe(false);
  });

  it('rejects the all-zero key even with a forged all-zero signature that OpenSSL alone would accept', () => {
    // For this exact message, crypto.verify(zero key, zero signature) returns true:
    // the zero key is a small-order point, so the blocklist is what stops it.
    expect(verifyAuthSignature(new Uint8Array(32), message, new Uint8Array(64))).toBe(false);
  });
});

describe('isWeakPublicKey', () => {
  it('flags every small-order encoding, with or without the sign bit', () => {
    const hex = [
      '0000000000000000000000000000000000000000000000000000000000000000',
      '0100000000000000000000000000000000000000000000000000000000000000',
      '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
      'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
      'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
      'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
      'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
    ];
    for (const h of hex) {
      const key = Buffer.from(h, 'hex');
      expect(isWeakPublicKey(key), h).toBe(true);
      key[31]! |= 0x80;
      expect(isWeakPublicKey(key), `${h} with sign bit`).toBe(true);
    }
  });

  it('accepts real keys', () => {
    for (let i = 0; i < 20; i++) expect(isWeakPublicKey(makeIdentity().publicKeyRaw)).toBe(false);
  });
});
