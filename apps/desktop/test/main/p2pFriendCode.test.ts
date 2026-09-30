import { createHash, randomBytes } from 'node:crypto';
import DHT from 'hyperdht';
import { describe, expect, it } from 'vitest';
import { toBase32 } from '@ghostlink/shared';
import { AppError } from '../../src/shared/appErrors.js';
import { FRIEND_CODE_SHAPE, normalizeFriendCode } from '../../src/shared/friendsTypes.js';
import { decodeFriendCode, encodeFriendCode, inboxPublicKey, inboxSeed, shortCode } from '../../src/main/p2p/friendCode.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const PUB = Uint8Array.from({ length: 32 }, (_, i) => i);
const SECRET = Uint8Array.from({ length: 16 }, (_, i) => 0xf0 + i);
const CODE = 'GLF1-AAAQ-EAYE-AUDA-OCAJ-BIFQ-YDIO-B4IB-CEQT-CQKR-MFYY-DENB-WHA5-DYP7-B4PS-6P2P-L5XX-7D47-V674-7X7P-7OSD-VNOA';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return (e as AppError).code;
  }
  return undefined;
}

/** Replaces the base32 character at `index` (dashes and the prefix not counted). */
function withChar(code: string, index: number, char: string): string {
  const body = code.slice(5).replaceAll('-', '');
  const next = body.slice(0, index) + char + body.slice(index + 1);
  return `GLF1-${next.match(/.{4}/g)!.join('-')}`;
}

describe('friend code (friends spec §2)', () => {
  it('matches the frozen vector: GLF1- and 21 groups of base32', () => {
    expect(encodeFriendCode(PUB, SECRET)).toBe(CODE);
    expect(CODE).toMatch(FRIEND_CODE_SHAPE);
    expect(CODE.slice(5).split('-')).toHaveLength(21);
  });

  it('is base32 of friendPub ‖ inviteSecret ‖ SHA-256("ghostlink/friendcode/v1" ‖ friendPub ‖ inviteSecret)[0:4]', () => {
    for (let i = 0; i < 5; i++) {
      const pub = randomBytes(32);
      const secret = randomBytes(16);
      const checksum = createHash('sha256').update('ghostlink/friendcode/v1').update(pub).update(secret).digest().subarray(0, 4);
      const body = toBase32(Buffer.concat([pub, secret, checksum]));
      expect(body).toHaveLength(84);
      expect(encodeFriendCode(pub, secret)).toBe(`GLF1-${body.match(/.{4}/g)!.join('-')}`);
    }
  });

  it('round-trips', () => {
    for (let i = 0; i < 20; i++) {
      const pub = randomBytes(32);
      const secret = randomBytes(16);
      const decoded = decodeFriendCode(encodeFriendCode(pub, secret));
      expect(hex(decoded.friendPub)).toBe(hex(pub));
      expect(hex(decoded.inviteSecret)).toBe(hex(secret));
    }
  });

  it('accepts what people paste: no dashes, lower case, spaces and line breaks around and inside', () => {
    const bare = CODE.replaceAll('-', '');
    for (const pasted of [bare, CODE.toLowerCase(), `  ${CODE}\n`, CODE.replaceAll('-', ' - '), `${CODE.slice(0, 40)}\r\n${CODE.slice(40)}`, `GLF1${CODE.slice(5)}`]) {
      expect(hex(decodeFriendCode(pasted).friendPub), pasted).toBe(hex(PUB));
      expect(normalizeFriendCode(pasted), pasted).not.toBeNull();
    }
  });

  it.each<[string, string]>([
    ['nothing', ''],
    ['another prefix', `GLF2-${CODE.slice(5)}`],
    ['a server invite prefix', `GL1-${CODE.slice(5)}`],
    ['no prefix', CODE.slice(5)],
    ['one group too few', CODE.slice(0, -5)],
    ['one group too many', `${CODE}-AAAA`],
    ['one character too few', CODE.slice(0, -1)],
    ['a character outside base32 (1)', withChar(CODE, 10, '1')],
    ['a character outside base32 (8)', withChar(CODE, 10, '8')],
    ['a character outside base32 (=)', withChar(CODE, 83, '=')],
    ['a dash in the wrong place', `GLF1-A-AAQEAYE${CODE.slice(14)}`],
    ['a link instead of a code', `ghostlink://amigo/${CODE}`],
    ['a changed key character', withChar(CODE, 3, 'B')],
    ['a changed secret character', withChar(CODE, 60, 'B')],
    ['a changed checksum character', withChar(CODE, 80, 'B')],
    ['two swapped groups', CODE.replace('AAAQ-EAYE', 'EAYE-AAAQ')],
    ['non-zero padding bits in the last character', withChar(CODE, 83, 'Z')],
  ])('refuses %s with FRIEND_CODE_INVALID', (_label, code) => {
    expect(codeOf(() => decodeFriendCode(code))).toBe('FRIEND_CODE_INVALID');
  });

  it('refuses anything that is not a string', () => {
    expect(codeOf(() => decodeFriendCode(undefined as unknown as string))).toBe('FRIEND_CODE_INVALID');
  });

  it('refuses keys and secrets of the wrong size when encoding', () => {
    expect(() => encodeFriendCode(new Uint8Array(31), SECRET)).toThrow(RangeError);
    expect(() => encodeFriendCode(PUB, new Uint8Array(15))).toThrow(RangeError);
  });
});

describe('short code', () => {
  it('is the first 8 characters of the code, and depends on the friend key alone', () => {
    expect(shortCode(PUB)).toBe('AAAQEAYE');
    expect(shortCode(PUB)).toBe(CODE.slice(5).replaceAll('-', '').slice(0, 8));
    const pub = randomBytes(32);
    expect(shortCode(pub)).toBe(encodeFriendCode(pub, randomBytes(16)).slice(5).replaceAll('-', '').slice(0, 8));
  });
});

describe('inbox key (friends spec §3.2)', () => {
  it('is the Ed25519 key of seed SHA-256("ghostlink/inbox/v1" ‖ friendPub ‖ inviteSecret)', () => {
    const seed = createHash('sha256').update('ghostlink/inbox/v1').update(PUB).update(SECRET).digest();
    expect(hex(inboxSeed(PUB, SECRET))).toBe(hex(seed));
    expect(hex(inboxPublicKey(PUB, SECRET))).toBe(hex(DHT.keyPair(seed).publicKey));
  });

  it('changes with the invite secret, so a new code moves the inbox', () => {
    expect(hex(inboxPublicKey(PUB, SECRET))).not.toBe(hex(inboxPublicKey(PUB, randomBytes(16))));
    expect(hex(inboxPublicKey(PUB, SECRET))).not.toBe(hex(PUB));
  });
});
