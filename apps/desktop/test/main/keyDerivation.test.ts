import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ProtocolError, buildAuthMessage, toBase64Url } from '@ghostlink/shared';
import { verifyAuthSignature } from '../../../server/src/auth/identity.js';
import { makeIdentity } from '../../../server/test/helpers/identity.js';
import { deriveServerSeed, serverKeyFromSeed } from '../../src/main/identity.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const MASTER = Uint8Array.from({ length: 32 }, (_, i) => i);
const KEY_ID_A = toBase64Url(Uint8Array.from({ length: 32 }, (_, i) => 255 - i));
const KEY_ID_B = toBase64Url(new Uint8Array(32).fill(0x42));

/** RFC 5869 written out by hand, so a swapped salt/info in the implementation cannot go unnoticed. */
function rfc5869(ikm: Uint8Array, salt: string, info: string): Uint8Array {
  const prk = createHmac('sha256', salt).update(ikm).digest();
  return createHmac('sha256', prk).update(Buffer.concat([Buffer.from(info, 'utf8'), Buffer.from([1])])).digest().subarray(0, 32);
}

describe('deriveServerSeed (spec §3.2)', () => {
  it('matches the frozen vectors — changing them changes every user id on every server', () => {
    expect(KEY_ID_A).toBe('__79_Pv6-fj39vX08_Lx8O_u7ezr6uno5-bl5OPi4eA');
    expect(hex(deriveServerSeed(MASTER, KEY_ID_A))).toBe('644a260de644a913441f95d5b50362956118ca8cf02b4d3309ce948e58aeb3ae');
    expect(hex(deriveServerSeed(MASTER, KEY_ID_B))).toBe('a587e6f59aeaf40cf0054314d5f1222906051b51bc1b4d539d56027575251fd8');
  });

  it('is HKDF-SHA256 with salt "ghostlink/identity/v1" and info = the serverKeyId string', () => {
    for (let i = 0; i < 5; i++) {
      const master = randomBytes(32);
      const keyId = toBase64Url(randomBytes(32));
      expect(hex(deriveServerSeed(master, keyId))).toBe(hex(rfc5869(master, 'ghostlink/identity/v1', keyId)));
    }
  });

  it('gives unrelated seeds to different servers and different identities', () => {
    const other = Uint8Array.from(MASTER, (b) => b ^ 1);
    const seeds = [deriveServerSeed(MASTER, KEY_ID_A), deriveServerSeed(MASTER, KEY_ID_B), deriveServerSeed(other, KEY_ID_A)];
    expect(new Set(seeds.map(hex)).size).toBe(3);
  });

  it.each([
    ['a short serverKeyId', KEY_ID_A.slice(1)],
    ['a newline', `${KEY_ID_A.slice(0, 42)}\n`],
    ['padding', `${KEY_ID_A.slice(0, 42)}=`],
  ])('rejects %s', (_label, keyId) => {
    expect(() => deriveServerSeed(MASTER, keyId)).toThrow(ProtocolError);
  });

  it('rejects a master seed that is not 32 bytes', () => {
    expect(() => deriveServerSeed(new Uint8Array(31), KEY_ID_A)).toThrow(RangeError);
  });
});

describe('serverKeyFromSeed', () => {
  it('matches the frozen public-key vectors', () => {
    expect(hex(serverKeyFromSeed(deriveServerSeed(MASTER, KEY_ID_A)).publicKeyRaw))
      .toBe('e7fa55eaf92a69801531d7614a9c66722a6215865b763251bf22d3f84d35063f');
    expect(hex(serverKeyFromSeed(deriveServerSeed(MASTER, KEY_ID_B)).publicKeyRaw))
      .toBe('cdfda981888bc7a7c55c0759c4d9668b759744bec7ab52ed2f749e9e3907eb92');
  });

  it('agrees with the server test identities (plan 1a known-answer vector)', () => {
    const seed = new Uint8Array(32).fill(2);
    expect(toBase64Url(serverKeyFromSeed(seed).publicKeyRaw)).toBe('gTl3Dqh9F19Wo1Rmw0x-zMuNipG07jeiXfYPW4_Js5Q');
    const random = randomBytes(32);
    expect(hex(serverKeyFromSeed(random).publicKeyRaw)).toBe(hex(makeIdentity(random).publicKeyRaw));
  });

  it('signs auth proofs that the server verifies, and only for the signed server', () => {
    const key = serverKeyFromSeed(deriveServerSeed(MASTER, KEY_ID_A));
    const nonce = toBase64Url(randomBytes(32));
    const signature = key.sign(buildAuthMessage(KEY_ID_A, nonce));
    expect(signature).toHaveLength(64);
    expect(verifyAuthSignature(key.publicKeyRaw, buildAuthMessage(KEY_ID_A, nonce), signature)).toBe(true);
    expect(verifyAuthSignature(key.publicKeyRaw, buildAuthMessage(KEY_ID_B, nonce), signature)).toBe(false);
  });

  it('rejects a seed that is not 32 bytes', () => {
    expect(() => serverKeyFromSeed(new Uint8Array(33))).toThrow(RangeError);
  });
});
