import { describe, expect, it } from 'vitest';
import { ProtocolError, fromBase64Url, fromUtf8, toBase32, toBase64Url, utf8 } from '../src/index.js';

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

describe('base64url', () => {
  // RFC 4648 §10 vectors (base64url and base64 agree on these, minus padding).
  const vectors: Array<[string, string]> = [
    ['', ''], ['f', 'Zg'], ['fo', 'Zm8'], ['foo', 'Zm9v'], ['foob', 'Zm9vYg'], ['fooba', 'Zm9vYmE'], ['foobar', 'Zm9vYmFy'],
  ];
  it.each(vectors)('encodes %j as %j and back', (plain, encoded) => {
    expect(toBase64Url(ascii(plain))).toBe(encoded);
    expect(Array.from(fromBase64Url(encoded))).toEqual(Array.from(ascii(plain)));
  });

  it('uses the URL-safe alphabet (- and _ instead of + and /)', () => {
    expect(toBase64Url(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
    expect(toBase64Url(new Uint8Array([0xff, 0xff, 0xff]))).toBe('____');
    expect(Array.from(fromBase64Url('-_8'))).toEqual([0xfb, 0xff]);
  });

  it('round-trips every byte value and every length up to 70', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(Array.from(fromBase64Url(toBase64Url(all)))).toEqual(Array.from(all));
    for (let len = 0; len <= 70; len++) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37 + len) & 0xff);
      expect(Array.from(fromBase64Url(toBase64Url(bytes)))).toEqual(Array.from(bytes));
    }
  });

  it('encodes 32 bytes as 43 chars and 64 bytes as 86 chars', () => {
    expect(toBase64Url(new Uint8Array(32))).toHaveLength(43);
    expect(toBase64Url(new Uint8Array(64))).toHaveLength(86);
  });

  it.each([
    ['padding', 'Zg=='],
    ['standard alphabet +', 'a+b/'],
    ['whitespace', 'Zm9v Zg'],
    ['newline', 'Zm9v\n'],
    ['impossible length', 'Zm9vY'],
    ['non-ASCII', 'Zm9é'],
    ['non-canonical trailing bits ("Zh" vs canonical "Zg")', 'Zh'],
    ['non-canonical trailing bits ("Zm9" vs canonical "Zm8")', 'Zm9'],
  ])('rejects %s', (_label, input) => {
    expect(() => fromBase64Url(input)).toThrow(ProtocolError);
    try {
      fromBase64Url(input);
    } catch (e) {
      expect((e as ProtocolError).code).toBe('BAD_REQUEST');
    }
  });

  it('rejects non-string input', () => {
    expect(() => fromBase64Url(123 as unknown as string)).toThrow(ProtocolError);
  });
});

describe('base32 (RFC 4648 §6, no padding)', () => {
  const vectors: Array<[string, string]> = [
    ['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI'],
  ];
  it.each(vectors)('encodes %j as %j', (plain, encoded) => {
    expect(toBase32(ascii(plain))).toBe(encoded);
  });

  it('only emits A-Z and 2-7', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(toBase32(all)).toMatch(/^[A-Z2-7]+$/);
    expect(toBase32(new Uint8Array(20))).toHaveLength(32);
  });
});

describe('utf8', () => {
  it('encodes multi-byte characters', () => {
    expect(Array.from(utf8('é'))).toEqual([0xc3, 0xa9]);
    expect(Array.from(utf8('👻'))).toEqual([0xf0, 0x9f, 0x91, 0xbb]);
  });

  it('fromUtf8 round-trips and refuses malformed bytes', () => {
    expect(fromUtf8(utf8('olá 👻'))).toBe('olá 👻');
    expect(() => fromUtf8(new Uint8Array([0xc3]))).toThrow(ProtocolError);
    expect(() => fromUtf8(new Uint8Array([0xed, 0xa0, 0x80]))).toThrow(ProtocolError); // encoded surrogate
    expect(() => fromUtf8(new Uint8Array([0xc0, 0xaf]))).toThrow(ProtocolError); // overlong '/'
  });

  it('keeps a BOM as a character instead of silently dropping it', () => {
    expect(fromUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toBe('﻿A');
  });
});
