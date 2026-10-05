import { describe, expect, it } from 'vitest';
import { ProtocolError, formatFingerprint, toBase32, toBase64Url } from '../src/index.js';

describe('formatFingerprint', () => {
  it('shows the first 20 bytes in base32 as 4 groups of 8', () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => i);
    const fp = formatFingerprint(toBase64Url(bytes));
    expect(fp).toMatch(/^[A-Z2-7]{8} [A-Z2-7]{8} [A-Z2-7]{8} [A-Z2-7]{8}$/);
    expect(fp.replaceAll(' ', '')).toBe(toBase32(bytes.subarray(0, 20)));
  });

  it('matches a fixed vector', () => {
    const zeros = toBase64Url(new Uint8Array(32));
    expect(formatFingerprint(zeros)).toBe('AAAAAAAA AAAAAAAA AAAAAAAA AAAAAAAA');
    const ff = toBase64Url(new Uint8Array(32).fill(0xff));
    expect(formatFingerprint(ff)).toBe('77777777 77777777 77777777 77777777');
  });

  it('ignores bytes 20..31 (only 160 bits are shown)', () => {
    const a = new Uint8Array(32);
    const b = new Uint8Array(32);
    b[31] = 1;
    expect(formatFingerprint(toBase64Url(a))).toBe(formatFingerprint(toBase64Url(b)));
    const c = new Uint8Array(32);
    c[19] = 1;
    expect(formatFingerprint(toBase64Url(a))).not.toBe(formatFingerprint(toBase64Url(c)));
  });

  it.each([
    ['31 bytes', toBase64Url(new Uint8Array(31))],
    ['33 bytes', toBase64Url(new Uint8Array(33))],
    ['not base64url', '!'.repeat(43)],
  ])('rejects %s', (_label, id) => {
    expect(() => formatFingerprint(id)).toThrow(ProtocolError);
  });
});
