import { describe, expect, it } from 'vitest';
import { ProtocolError, buildAuthMessage, toBase64Url } from '../src/index.js';

const KEY_ID = toBase64Url(Uint8Array.from({ length: 32 }, (_, i) => i));
const NONCE = toBase64Url(Uint8Array.from({ length: 32 }, (_, i) => 255 - i));

describe('buildAuthMessage', () => {
  it('produces the exact frozen byte layout', () => {
    const bytes = buildAuthMessage(KEY_ID, NONCE);
    const expected = `ghostlink-auth-v1\n${KEY_ID}\n${NONCE}`;
    expect(new TextDecoder().decode(bytes)).toBe(expected);
    expect(bytes).toHaveLength(17 + 1 + 43 + 1 + 43);
    expect(bytes[17]).toBe(0x0a);
    expect(bytes[17 + 1 + 43]).toBe(0x0a);
  });

  it('changes when the serverKeyId changes (binding to the TLS key)', () => {
    const other = toBase64Url(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
    expect(buildAuthMessage(KEY_ID, NONCE)).not.toEqual(buildAuthMessage(other, NONCE));
  });

  it('is not symmetric in its arguments', () => {
    expect(buildAuthMessage(KEY_ID, NONCE)).not.toEqual(buildAuthMessage(NONCE, KEY_ID));
  });

  it.each([
    ['newline smuggled into serverKeyId', `${KEY_ID.slice(0, 42)}\n`, NONCE],
    ['short serverKeyId', KEY_ID.slice(0, 42), NONCE],
    ['padded nonce', KEY_ID, `${NONCE.slice(0, 42)}=`],
    ['empty nonce', KEY_ID, ''],
  ])('rejects %s', (_label, keyId, nonce) => {
    expect(() => buildAuthMessage(keyId, nonce)).toThrow(ProtocolError);
  });
});
