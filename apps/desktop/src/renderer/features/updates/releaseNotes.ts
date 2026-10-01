// The "O que mudou" / "What changed" bullets of a release-notes file (release-notes/<version>.md,
// also the body of the GitHub release): `## Português` → `### O que mudou`, `## English` →
// `### What changed`. A small pure parser that returns data, never HTML: bullets, **bold**, `code`
// and links. Any other markup stays as the plain text it is; React renders every string as text.
import type { Locale } from '../../../shared/ipcTypes.js';

export type NoteInline =
  | { k: 'text'; text: string }
  | { k: 'bold'; children: NoteInline[] }
  | { k: 'code'; text: string }
  | { k: 'link'; text: string; url: string };

/** One bullet (or numbered item). */
export type NoteItem = NoteInline[];

const SECTIONS: Readonly<Record<Locale, { language: string; changes: string }>> = {
  'pt-BR': { language: 'português', changes: 'o que mudou' },
  en: { language: 'english', changes: 'what changed' },
};

/** More bullets than this are left out; a release lists about ten. */
export const MAX_NOTE_ITEMS = 50;
/** A longer bullet is cut (the fetched notes are at most 64 KB in all). */
export const MAX_NOTE_LENGTH = 2_000;
const MAX_URL_LENGTH = 2_048;

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const BULLET = /^[ \t]*(?:[-*+]|[0-9]{1,9}[.)])[ \t]+(.*)$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '<', '>', '#', '+', '-', '.', '!', '~', '|']);
const URL_END = /[\s<>"`]/;
const URL_TRAILING = new Set(['.', ',', ':', ';', '!', '?', "'", '"', '*', '_', '~']);

const normalize = (title: string) => title.normalize('NFC').trim().toLowerCase();

/**
 * The bullets of the "O que mudou" (pt-BR) or "What changed" (en) section, or null when the
 * notes have no such section in that language. A bullet's continuation lines join it; other
 * paragraphs and code blocks of the section are left out.
 */
export function releaseChanges(markdown: string, locale: Locale): NoteItem[] | null {
  const want = SECTIONS[locale];
  const items: string[] = [];
  let inLanguage = false;
  let inChanges = false;
  let found = false;
  let fence: string | null = null;
  let current: string | null = null;
  const flush = () => {
    if (current !== null && current.trim() !== '' && items.length < MAX_NOTE_ITEMS) items.push(current.trim());
    current = null;
  };

  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const fenceMark = FENCE.exec(line)?.[1];
    if (fence !== null) {
      if (fenceMark !== undefined && fenceMark[0] === fence[0] && fenceMark.length >= fence.length) fence = null;
      continue;
    }
    if (fenceMark !== undefined) {
      flush();
      fence = fenceMark;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const level = heading[1]!.length;
      const title = normalize(heading[2]!);
      if (level <= 2) {
        inLanguage = level === 2 && title === want.language;
        inChanges = false;
      } else if (level === 3) {
        inChanges = inLanguage && title === want.changes;
        found ||= inChanges;
      }
      continue; // a deeper heading inside the section ends a bullet, nothing more
    }
    if (!inChanges) continue;
    const bullet = BULLET.exec(line);
    if (bullet) {
      flush();
      current = bullet[1]!;
    } else if (line.trim() === '') {
      flush();
    } else if (current !== null) {
      current += ` ${line.trim()}`;
    }
  }
  flush();
  if (!found) return null;
  return items.map((item) => parseInline(item.length > MAX_NOTE_LENGTH ? `${item.slice(0, MAX_NOTE_LENGTH)}…` : item));
}

/** A link target the page may offer: http(s), no credentials, not too long. */
export function safeLinkUrl(raw: string): string | null {
  if (raw.length === 0 || raw.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '' || url.hostname === '') return null;
  return url.href;
}

/** A bare http(s) URL starting at `from`: its end, trailing punctuation and unbalanced ")" left out. */
function bareUrlEnd(text: string, from: number): number {
  let end = from;
  // A longer run is no link anyway (safeLinkUrl): stopping there keeps hostile input linear.
  while (end < text.length && end - from <= MAX_URL_LENGTH && !URL_END.test(text[end]!)) end++;
  for (;;) {
    const last = text[end - 1]!;
    if (URL_TRAILING.has(last)) end--;
    else if (last === ')') {
      const url = text.slice(from, end);
      if (url.split('(').length < url.split(')').length) end--;
      else break;
    } else break;
  }
  return end;
}

const startsUrl = (text: string, i: number) => /^https?:\/\//i.test(text.slice(i, i + 8));
const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}_]/u.test(c);

/**
 * `text.indexOf(needle, from)` that remembers its last answer per needle: a search from a later
 * index reuses it while it still lies ahead, so each part of the text is scanned once per needle
 * however many openers there are (hostile input stays linear).
 */
function finder(text: string): (needle: string, from: number) => number {
  const memo = new Map<string, { from: number; at: number }>();
  return (needle, from) => {
    const last = memo.get(needle);
    if (last && last.from <= from && (last.at === -1 || last.at >= from)) return last.at;
    const at = text.indexOf(needle, from);
    memo.set(needle, { from, at });
    return at;
  };
}

/**
 * Inline markup of one bullet: `**bold**` (one level, with code and links inside), `` `code` ``,
 * `[text](https://…)`, `<https://…>` and bare https:// URLs. A link to anything but http(s) keeps
 * its text only; everything else (italics, strike-through, images, HTML) stays as written.
 */
export function parseInline(text: string, nested = false): NoteInline[] {
  const out: NoteInline[] = [];
  const find = finder(text);
  let plain = '';
  const push = (node: NoteInline) => {
    if (plain !== '') out.push({ k: 'text', text: plain });
    plain = '';
    out.push(node);
  };

  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '\\' && ESCAPABLE.has(text[i + 1] ?? '')) {
      plain += text[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      let ticks = 1;
      while (text[i + ticks] === '`') ticks++;
      const end = find('`'.repeat(ticks), i + ticks);
      const code = end === -1 ? '' : text.slice(i + ticks, end).trim();
      if (code !== '') {
        push({ k: 'code', text: code });
        i = end + ticks;
      } else {
        plain += '`'.repeat(ticks);
        i += ticks;
      }
      continue;
    }
    if (c === '*' && text[i + 1] === '*' && !nested) {
      const end = find('**', i + 2);
      const inner = end === -1 ? '' : text.slice(i + 2, end);
      if (inner.trim() !== '' && inner === inner.trim()) {
        push({ k: 'bold', children: parseInline(inner, true) });
        i = end + 2;
        continue;
      }
    }
    if (c === '!' && text[i + 1] === '[') {
      // An image stays as written, its address included.
      const close = find(']', i + 2);
      const end = close !== -1 && text[close + 1] === '(' ? find(')', close + 2) : -1;
      const stop = end === -1 ? i + 2 : end + 1;
      plain += text.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '[') {
      const close = find(']', i + 1);
      const label = close === -1 ? '' : text.slice(i + 1, close);
      if (close !== -1 && text[close + 1] === '(' && label.trim() !== '' && !label.includes('[')) {
        const end = find(')', close + 2);
        const target = end === -1 ? '' : text.slice(close + 2, end).trim();
        if (end !== -1 && !/\s/.test(target)) {
          const url = safeLinkUrl(target);
          if (url !== null) push({ k: 'link', text: label, url });
          else plain += label; // "[English below](#english)": the words, not the anchor
          i = end + 1;
          continue;
        }
      }
    }
    if (c === '<' && startsUrl(text, i + 1)) {
      const end = find('>', i + 1);
      const raw = end === -1 || end - i > MAX_URL_LENGTH + 1 ? '' : text.slice(i + 1, end);
      const url = /\s/.test(raw) ? null : safeLinkUrl(raw);
      if (url !== null) {
        push({ k: 'link', text: raw, url });
        i = end + 1;
        continue;
      }
    }
    if ((c === 'h' || c === 'H') && startsUrl(text, i) && !isWordChar(text[i - 1])) {
      const end = bareUrlEnd(text, i);
      const raw = text.slice(i, end);
      const url = safeLinkUrl(raw);
      if (url !== null) {
        push({ k: 'link', text: raw, url });
        i = end;
        continue;
      }
    }
    plain += c;
    i++;
  }
  if (plain !== '') out.push({ k: 'text', text: plain });
  return out;
}
