import { describe, expect, it } from 'vitest';
import { ProtocolError, normalizeNickname, sanitizeLabel } from '../src/index.js';

function rejects(raw: string): void {
  let caught: unknown;
  try {
    normalizeNickname(raw);
  } catch (e) {
    caught = e;
  }
  expect(caught, JSON.stringify(raw)).toBeInstanceOf(ProtocolError);
  expect((caught as ProtocolError).code).toBe('BAD_REQUEST');
}

describe('normalizeNickname', () => {
  it('keeps ordinary names and lowercases the uniqueness key', () => {
    expect(normalizeNickname('Ana')).toEqual({ display: 'Ana', norm: 'ana' });
    expect(normalizeNickname('João Silva')).toEqual({ display: 'João Silva', norm: 'joão silva' });
    expect(normalizeNickname('幽霊')).toEqual({ display: '幽霊', norm: '幽霊' });
  });

  it('applies NFKC so compatibility look-alikes collide', () => {
    expect(normalizeNickname('ＡＤＭＩＮ').norm).toBe('admin'); // fullwidth letters
    expect(normalizeNickname('ﬁsh').display).toBe('fish'); // ligature
    expect(normalizeNickname('é').display).toBe('é'); // decomposed accent is composed
    expect(normalizeNickname('Café').norm).toBe(normalizeNickname('Café').norm);
  });

  it('strips bidi controls (U+202A–202E, U+2066–2069, LRM/RLM, ALM)', () => {
    for (const cp of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c]) {
      const c = String.fromCodePoint(cp);
      expect(normalizeNickname(`ad${c}min`).display, cp.toString(16)).toBe('admin');
    }
    // The classic "RLO" spoof: displays as "admin" reversed tail, must normalize to plain text.
    expect(normalizeNickname('‮nimda').display).toBe('nimda');
  });

  it('strips zero-width and other invisible characters', () => {
    for (const cp of [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad, 0x034f, 0x180e, 0x2061, 0xe0041]) {
      const c = String.fromCodePoint(cp);
      expect(normalizeNickname(`ad${c}min`).norm, cp.toString(16)).toBe('admin');
    }
  });

  it('strips control characters (C0 and C1)', () => {
    expect(normalizeNickname('a\u0000b\u0007c\u009fd').display).toBe('abcd');
    expect(normalizeNickname('a\nb').display).toBe('ab');
  });

  it('removes lone surrogates', () => {
    expect(normalizeNickname('ab\uD800c').display).toBe('abc');
  });

  it('collapses and trims whitespace, including exotic spaces', () => {
    expect(normalizeNickname('  Ana   Maria  ').display).toBe('Ana Maria');
    expect(normalizeNickname('Ana 　Maria').display).toBe('Ana Maria');
    expect(normalizeNickname('Ana Maria').display).toBe('Ana Maria');
  });

  it('is idempotent on tricky inputs', () => {
    const inputs = ['e‍́', 'ＡＤＭＩＮ', '  x‮ y ', 'ﬁ­sh', 'Anaㅤ', '각'];
    for (const raw of inputs) {
      const once = normalizeNickname(raw).display;
      expect(normalizeNickname(once).display, JSON.stringify(raw)).toBe(once);
    }
  });

  it('composes characters that become adjacent after stripping (look-alike loophole)', () => {
    // "e" + ZWJ + combining acute: without the second NFKC pass this would be
    // "é" and not collide with "é".
    expect(normalizeNickname('e‍́').norm).toBe(normalizeNickname('é').norm);
  });

  it('counts graphemes, not UTF-16 code units', () => {
    expect(normalizeNickname('👻'.repeat(32)).display).toBe('👻'.repeat(32)); // 64 code units, 32 graphemes
    expect(normalizeNickname('🇧🇷'.repeat(32)).display).toBe('🇧🇷'.repeat(32)); // flags are 1 grapheme each
    expect(normalizeNickname('a'.repeat(32)).display).toHaveLength(32);
    rejects('a'.repeat(33));
    rejects('👻'.repeat(33));
  });

  it('splits emoji ZWJ sequences because U+200D is stripped (documented trade-off)', () => {
    // 👨‍👩‍👧 becomes three separate emoji: 3 graphemes.
    expect(normalizeNickname('👨‍👩‍👧').display).toBe('👨👩👧');
  });

  it.each([
    ['empty', ''],
    ['only spaces', '    '],
    ['only zero-width', '​‌‍'],
    ['only bidi controls', '‮⁦'],
    ['only Hangul filler (invisible name trick)', 'ㅤ'],
    ['only Braille blank', '⠀⠀'],
    ['only a variation selector', '️'],
    ['only combining marks', '́̂'],
    ['Zalgo stack', `a${'́'.repeat(20)}`],
    ['longer than 256 raw chars', 'a'.repeat(257)],
  ])('rejects %s', (_label, raw) => {
    rejects(raw);
  });

  it('rejects non-string input', () => {
    rejects(42 as unknown as string);
  });
});

describe('sanitizeLabel', () => {
  it('cleans like a nickname and truncates by graphemes', () => {
    expect(sanitizeLabel('  Meu‮ Servidor  ', 64)).toBe('Meu Servidor');
    expect(sanitizeLabel('👻'.repeat(10), 3)).toBe('👻👻👻');
    expect(sanitizeLabel('abc   def', 4)).toBe('abc');
  });

  it('returns an empty string when nothing visible is left', () => {
    expect(sanitizeLabel('​ㅤ ', 64)).toBe('');
    expect(sanitizeLabel(123 as unknown as string, 64)).toBe('');
  });
});
