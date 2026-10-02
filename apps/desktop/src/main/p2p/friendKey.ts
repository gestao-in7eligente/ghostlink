// The friend key (friends spec §2): one Ed25519 key per person, derived from the friend seed.
// Signing and verifying use node:crypto, never a transitive dependency of the P2P stack; the
// public half is the same 32 bytes Hyperswarm derives from that seed (a test asserts it).
import { createHash, createHmac, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { CRYPTO_LABELS, fromBase64Url, toBase64Url, utf8 } from '@ghostlink/shared';
import { AppError } from '../../shared/appErrors.js';
import { serverKeyFromSeed } from '../identity.js';

/** The private half never leaves the closure. */
export interface FriendKey {
  publicKey: Uint8Array;
  sign(message: Uint8Array): Uint8Array;
}

// SPKI DER prefix for a raw 32-byte Ed25519 public key (RFC 8410).
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const KEY_TEXT = /^[A-Za-z0-9_-]{43}$/;
const INBOX_PROOF_PREFIX = utf8(`${CRYPTO_LABELS.friendInbox}\n`);
const REQUEST_PROOF_PREFIX = utf8(`${CRYPTO_LABELS.friendInbox}\nrequest\n`);

export function friendKeyFromSeed(seed: Uint8Array): FriendKey {
  const key = serverKeyFromSeed(seed);
  return { publicKey: key.publicKeyRaw, sign: key.sign };
}

/** False for a wrong signature and for anything malformed; never throws. */
export function verifyFriendSignature(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, publicKey]), format: 'der', type: 'spki' });
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}

/** A friend key as it crosses IPC and sits in JSON: base64url of the 32 bytes. */
export function keyToText(key: Uint8Array): string {
  return toBase64Url(key);
}

export function keyFromText(text: string): Uint8Array {
  if (typeof text !== 'string' || !KEY_TEXT.test(text)) throw new AppError('BAD_REQUEST', 'invalid friend key');
  try {
    return fromBase64Url(text); // also refuses a non-canonical last character
  } catch {
    throw new AppError('BAD_REQUEST', 'invalid friend key');
  }
}

/** hex(SHA-256(raw key))[0:32], the way a server makes a member id of a public key (its userIdFromPublicKey). */
export function userIdOfKey(key: Uint8Array): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

export function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.from(a.buffer, a.byteOffset, a.length).equals(b);
}

/**
 * spec §3.2: whoever holds a friend code also knows the inbox's private key, so the inbox
 * owner proves itself by signing, with the friend key, the handshake hash of that very
 * connection. A relayed or replayed proof belongs to another handshake and fails.
 */
export function signInboxProof(owner: FriendKey, handshakeHash: Uint8Array): Uint8Array {
  return owner.sign(Buffer.concat([INBOX_PROOF_PREFIX, handshakeHash]));
}

export function verifyInboxProof(friendPub: Uint8Array, handshakeHash: Uint8Array, signature: Uint8Array): boolean {
  return verifyFriendSignature(friendPub, Buffer.concat([INBOX_PROOF_PREFIX, handshakeHash]), signature);
}

/**
 * spec §3.2: the inbox key alone is not enough to ask. The DHT nodes that store the inbox's
 * announce see that key, so the asker also proves it holds the whole code: an HMAC, keyed
 * with the invite secret, of the handshake hash of that very connection (never replayable).
 */
export function requestProof(inviteSecret: Uint8Array, handshakeHash: Uint8Array): Uint8Array {
  return createHmac('sha256', inviteSecret).update(REQUEST_PROOF_PREFIX).update(handshakeHash).digest();
}

export function checkRequestProof(inviteSecret: Uint8Array, handshakeHash: Uint8Array, proof: Uint8Array): boolean {
  const expected = requestProof(inviteSecret, handshakeHash);
  return proof.length === expected.length && timingSafeEqual(expected, proof);
}
