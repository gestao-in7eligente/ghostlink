import { LIMITS } from './constants.js';
import { ProtocolError } from './errors.js';

/**
 * Characters removed from user-visible labels:
 * - \p{Cc}: C0/C1 controls;
 * - \p{Cf}: format characters — includes every bidi control (U+061C, U+200E/F,
 *   U+202A–202E, U+2066–2069), zero-width characters (U+200B–200D, U+2060, U+FEFF),
 *   the soft hyphen, invisible operators and tag characters;
 * - \p{Cs}: lone surrogates (JSON can carry them; SQLite would turn them into U+FFFD);
 * - blank-looking letters/marks that are not Cf: U+034F (combining grapheme joiner),
 *   Hangul fillers (U+115F, U+1160, U+3164, U+FFA0), Khmer inherent vowels
 *   (U+17B4, U+17B5) and the Braille blank (U+2800).
 */
// The combining marks live outside the class: inside it they would trip no-misleading-character-class.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}ᅟᅠ⠀ㅤﾠ]|͏|឴|឵/gu;
/** A label must contain at least one letter, number, punctuation or symbol (emoji are symbols). */
const HAS_VISIBLE = /[\p{L}\p{N}\p{P}\p{S}]/u;
/** Longest raw input we are willing to normalize (NFKC can expand text up to 18x). */
const MAX_RAW_LENGTH = 256;
/** Caps "Zalgo" stacks of combining marks; real scripts stay well below this. */
const MAX_CODE_POINTS_PER_GRAPHEME = 10;

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

function cleanLabel(raw: string): string {
  // The second NFKC pass composes sequences that only become adjacent once
  // invisible characters are removed (e.g. "e" + ZWJ + U+0301 -> "é"), which
  // makes the result idempotent and closes a look-alike loophole.
  return raw
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .normalize('NFKC');
}

function graphemes(s: string): string[] {
  return Array.from(segmenter.segment(s), (seg) => seg.segment);
}

/**
 * Normalizes a nickname (spec §7): NFKC, strips controls, bidi and zero-width
 * characters, collapses whitespace and requires 1..32 visible graphemes.
 * `norm` is the uniqueness key stored in users.nickname_norm.
 */
export function normalizeNickname(raw: string): { display: string; norm: string } {
  if (typeof raw !== 'string' || raw.length > MAX_RAW_LENGTH) {
    throw new ProtocolError('BAD_REQUEST', 'nickname too long');
  }
  const display = cleanLabel(raw);
  const parts = graphemes(display);
  if (parts.length < 1 || parts.length > LIMITS.nicknameMaxVisible || !HAS_VISIBLE.test(display)) {
    throw new ProtocolError('BAD_REQUEST', 'nickname must have 1 to 32 visible characters');
  }
  if (parts.some((g) => [...g].length > MAX_CODE_POINTS_PER_GRAPHEME)) {
    throw new ProtocolError('BAD_REQUEST', 'nickname has too many combining marks');
  }
  return { display, norm: display.toLocaleLowerCase('en-US') };
}

/**
 * Cleans a free-form label (server name, invite name hint) the same way as a
 * nickname, then truncates it to `maxGraphemes`. Returns '' when nothing
 * visible is left. Never throws on content.
 */
export function sanitizeLabel(raw: string, maxGraphemes: number): string {
  if (typeof raw !== 'string') return '';
  const cleaned = cleanLabel(raw.slice(0, MAX_RAW_LENGTH * 4));
  if (!HAS_VISIBLE.test(cleaned)) return '';
  return graphemes(cleaned).slice(0, maxGraphemes).join('').trim();
}
