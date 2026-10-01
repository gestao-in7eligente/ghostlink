import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildOwnerStatusMessage, toBase64Url } from '@ghostlink/shared';
import { parseOwnerStatusQuery, verifyOwnerStatusQuery } from '../src/status/index.js';
import { makeIdentity } from './helpers/identity.js';

const SERVER = randomBytes(32).toString('base64url');
const NOW_MS = 1_790_000_000_500;
const owner = makeIdentity();

function query(ts: number, o: { signer?: typeof owner; serverKeyId?: string } = {}): string {
  const sig = (o.signer ?? owner).sign(buildOwnerStatusMessage(o.serverKeyId ?? SERVER, ts));
  return `ts=${ts}&sig=${toBase64Url(sig)}`;
}

const verify = (q: string, ownerKey: Uint8Array | null = owner.publicKeyRaw) =>
  verifyOwnerStatusQuery(q, { serverKeyId: SERVER, nowMs: NOW_MS, ownerKey });

describe('verifyOwnerStatusQuery', () => {
  it('accepts the owner within 60 s of the server clock, either way', () => {
    const now = Math.floor(NOW_MS / 1000);
    expect(verify(query(now))).toBe(true);
    expect(verify(query(now - 59))).toBe(true);
    expect(verify(query(now + 60))).toBe(true);
    expect(verify(query(now - 61))).toBe(false);
    expect(verify(query(now + 61))).toBe(false);
    expect(verify(query(0))).toBe(false);
  });

  it('refuses another key, another server text, and a server without owner', () => {
    const now = Math.floor(NOW_MS / 1000);
    expect(verify(query(now, { signer: makeIdentity() }))).toBe(false);
    expect(verify(query(now, { serverKeyId: randomBytes(32).toString('base64url') }))).toBe(false);
    expect(verify(query(now), null)).toBe(false);
  });
});

describe('parseOwnerStatusQuery', () => {
  const sig = toBase64Url(new Uint8Array(64).fill(1));
  it('reads ts and a 64-byte sig, once each and nothing else', () => {
    expect(parseOwnerStatusQuery(`ts=5&sig=${sig}`)).toEqual({ ts: 5, signature: new Uint8Array(64).fill(1) });
    expect(parseOwnerStatusQuery(`sig=${sig}&ts=5`)?.ts).toBe(5);
  });

  it.each([
    '',
    'ts=5',
    `sig=${sig}`,
    `ts=5&sig=${sig}&ts=5`,
    `ts=5&sig=${sig}&x=1`,
    `ts=5&sig=${sig}&`,
    `ts=05&sig=${sig}`,
    `ts=-5&sig=${sig}`,
    `ts=5.0&sig=${sig}`,
    `ts=99999999999999999&sig=${sig}`,
    `ts=5&sig=${sig}==`,
    `ts=5&sig=${sig.slice(1)}`,
    `ts=5&sig=${sig.replace(/^./, '+')}`,
    `ts=5&sig=${sig.slice(0, -1)}B`, // non-canonical trailing bits
    `ts=%35&sig=${sig}`,
  ])('refuses %j', (q) => {
    expect(parseOwnerStatusQuery(q)).toBeNull();
  });
});
