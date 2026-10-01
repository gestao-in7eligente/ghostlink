import { describe, expect, it } from 'vitest';
import {
  OWNER_STATUS_LABEL,
  OWNER_STATUS_LIMITS,
  OWNER_STATUS_PATH,
  ProtocolError,
  buildAuthMessage,
  buildOwnerStatusMessage,
  ownerStatusPath,
  ownerStatusSchemaClient,
  toBase64Url,
} from '../src/index.js';

const KEY_ID = toBase64Url(Uint8Array.from({ length: 32 }, (_, i) => i));

describe('buildOwnerStatusMessage', () => {
  it('produces the exact layout the owner signs', () => {
    expect(OWNER_STATUS_LABEL).toBe('ghostlink-owner-status-v1');
    const text = new TextDecoder().decode(buildOwnerStatusMessage(KEY_ID, 1_790_000_000));
    expect(text).toBe(`ghostlink-owner-status-v1\n${KEY_ID}\n1790000000`);
  });

  it('binds the server and the time', () => {
    const other = toBase64Url(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
    expect(buildOwnerStatusMessage(KEY_ID, 5)).not.toEqual(buildOwnerStatusMessage(other, 5));
    expect(buildOwnerStatusMessage(KEY_ID, 5)).not.toEqual(buildOwnerStatusMessage(KEY_ID, 6));
  });

  it('can never be read as an auth proof (another domain label)', () => {
    const nonce = toBase64Url(Uint8Array.from({ length: 32 }, () => 7));
    expect(new TextDecoder().decode(buildOwnerStatusMessage(KEY_ID, 5))).not.toContain('ghostlink-auth-v1');
    expect(buildAuthMessage(KEY_ID, nonce)).not.toEqual(buildOwnerStatusMessage(KEY_ID, 5));
  });

  it.each([
    ['newline smuggled into serverKeyId', `${KEY_ID.slice(0, 42)}\n`, 5],
    ['short serverKeyId', KEY_ID.slice(0, 42), 5],
    ['negative ts', KEY_ID, -1],
    ['fractional ts', KEY_ID, 1.5],
    ['NaN ts', KEY_ID, Number.NaN],
    ['unsafe ts', KEY_ID, 2 ** 53],
  ])('rejects %s', (_label, keyId, ts) => {
    expect(() => buildOwnerStatusMessage(keyId, ts)).toThrow(ProtocolError);
  });
});

describe('ownerStatusPath', () => {
  it('puts ts and the base64url signature in the query', () => {
    const sig = Uint8Array.from({ length: 64 }, (_, i) => 255 - i);
    expect(ownerStatusPath(42, sig)).toBe(`${OWNER_STATUS_PATH}?ts=42&sig=${toBase64Url(sig)}`);
    expect(OWNER_STATUS_PATH).toBe('/owner/status');
    expect(() => ownerStatusPath(-1, sig)).toThrow(ProtocolError);
  });

  it('matches the spec limits', () => {
    expect(OWNER_STATUS_LIMITS).toEqual({ maxSkewSeconds: 60, requestsPerMinute: 30 });
  });
});

describe('ownerStatusSchemaClient', () => {
  it('reads the 200 answer and refuses anything else', () => {
    expect(ownerStatusSchemaClient.parse({ version: '0.2.2', voiceActive: false })).toEqual({ version: '0.2.2', voiceActive: false });
    expect(ownerStatusSchemaClient.safeParse({ version: '0.2.2' }).success).toBe(false);
    expect(ownerStatusSchemaClient.safeParse({ version: '0.2.2', voiceActive: 'no' }).success).toBe(false);
  });
});
