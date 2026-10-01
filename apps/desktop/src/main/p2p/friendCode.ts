// The friend code (friends spec §2): what a person shares so that others can send them a request.
//   "GLF1-" + base32( friendPub (32) ‖ inviteSecret (16) ‖ checksum (4) ), in groups of 4
//   checksum = SHA-256("ghostlink/friendcode/v1" ‖ friendPub ‖ inviteSecret)[0:4]
// It lives here and not in @ghostlink/shared because the checksum needs a synchronous hash.
import { createHash } from 'node:crypto';
import { CRYPTO_LABELS, toBase32 } from '@ghostlink/shared';
import { AppError } from '../../shared/appErrors.js';
import { normalizeFriendCode } from '../../shared/friendsTypes.js';
import { friendKeyFromSeed } from './friendKey.js';

export const FRIEND_CODE_PREFIX = 'GLF1-';
export const FRIEND_KEY_BYTES = 32;
export const INVITE_SECRET_BYTES = 16;
const CHECKSUM_BYTES = 4;
const BODY_BYTES = FRIEND_KEY_BYTES + INVITE_SECRET_BYTES + CHECKSUM_BYTES;
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export interface FriendCode {
  friendPub: Uint8Array;
  inviteSecret: Uint8Array;
}

function labelled(label: string, friendPub: Uint8Array, inviteSecret: Uint8Array): Buffer {
  return createHash('sha256').update(label, 'utf8').update(friendPub).update(inviteSecret).digest();
}

function checkSizes(friendPub: Uint8Array, inviteSecret: Uint8Array): void {
  if (friendPub.length !== FRIEND_KEY_BYTES) throw new RangeError('a friend key has 32 bytes');
  if (inviteSecret.length !== INVITE_SECRET_BYTES) throw new RangeError('an invite secret has 16 bytes');
}

export function encodeFriendCode(friendPub: Uint8Array, inviteSecret: Uint8Array): string {
  checkSizes(friendPub, inviteSecret);
  const checksum = labelled(CRYPTO_LABELS.friendCode, friendPub, inviteSecret).subarray(0, CHECKSUM_BYTES);
  const body = toBase32(Buffer.concat([friendPub, inviteSecret, checksum]));
  return FRIEND_CODE_PREFIX + body.match(/.{4}/g)!.join('-');
}

/** Strict RFC 4648 base32 without padding: null for a foreign character or non-zero trailing bits. */
function fromBase32(text: string): Uint8Array | null {
  const out = new Uint8Array(Math.floor((text.length * 5) / 8));
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (const char of text) {
    const value = B32_ALPHABET.indexOf(char);
    if (value < 0) return null;
    buffer = ((buffer << 5) | value) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  return (buffer & ((1 << bits) - 1)) === 0 ? out : null;
}

/** The key and the invite secret of a pasted code (dashes optional), or FRIEND_CODE_INVALID. */
export function decodeFriendCode(input: string): FriendCode {
  const invalid = () => new AppError('FRIEND_CODE_INVALID');
  const code = typeof input === 'string' ? normalizeFriendCode(input) : null;
  if (code === null) throw invalid();
  const bytes = fromBase32(code.slice(FRIEND_CODE_PREFIX.length - 1).replaceAll('-', ''));
  if (bytes === null || bytes.length !== BODY_BYTES) throw invalid();
  const friendPub = bytes.slice(0, FRIEND_KEY_BYTES);
  const inviteSecret = bytes.slice(FRIEND_KEY_BYTES, FRIEND_KEY_BYTES + INVITE_SECRET_BYTES);
  const checksum = labelled(CRYPTO_LABELS.friendCode, friendPub, inviteSecret).subarray(0, CHECKSUM_BYTES);
  if (!checksum.equals(bytes.subarray(BODY_BYTES - CHECKSUM_BYTES))) throw invalid();
  return { friendPub, inviteSecret };
}

/**
 * The first 8 characters of a person's code: 40 bits of the friend key, shown next to a
 * request so both people can compare it out of band (spec §5.1). Also the only form of a
 * key that goes to the log.
 */
export function shortCode(friendPub: Uint8Array): string {
  return toBase32(friendPub.subarray(0, 5));
}

/** spec §3.2: the inbox listens on the Ed25519 key of this seed; only a holder of the whole code can derive it. */
export function inboxSeed(friendPub: Uint8Array, inviteSecret: Uint8Array): Uint8Array {
  checkSizes(friendPub, inviteSecret);
  return labelled(CRYPTO_LABELS.friendInbox, friendPub, inviteSecret);
}

export function inboxPublicKey(friendPub: Uint8Array, inviteSecret: Uint8Array): Uint8Array {
  return friendKeyFromSeed(inboxSeed(friendPub, inviteSecret)).publicKey;
}
