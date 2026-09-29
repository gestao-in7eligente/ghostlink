// Mention autocomplete for the composer. The user sees "@Ana"; the message carries
// the wire tokens `<@userId>`, `<@&roleId>` and `@everyone` (spec §5.2). Only
// mentions picked from the list become tokens, and never inside code.
import { EVERYONE_MENTION, type Member, type Role } from '@ghostlink/shared';

export interface MentionCandidate {
  kind: 'user' | 'role' | 'everyone';
  id: string;
  /** What the composer shows, e.g. "@Ana". */
  display: string;
  /** What is sent, e.g. "<@0123…>". */
  token: string;
}

export const MENTION_QUERY_MAX = 32;
export const MENTION_SUGGESTIONS_MAX = 8;

/** The `@query` right before the caret, when the user is typing a mention. */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const from = Math.max(0, caret - MENTION_QUERY_MAX - 1);
  for (let i = caret - 1; i >= from; i -= 1) {
    const c = text[i]!;
    if (c === '@') {
      const before = text[i - 1];
      if (before !== undefined && !/\s/u.test(before)) return null;
      return { start: i, query: text.slice(i + 1, caret) };
    }
    if (/\s/u.test(c)) return null;
  }
  return null;
}

/** Case- and accent-insensitive key for matching. */
export function fold(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase();
}

export interface SuggestionSource {
  members: readonly Member[];
  roles: readonly Role[];
  /** MENTION_EVERYONE: `@everyone`, and every role even when not mentionable. */
  canMentionEveryone: boolean;
  /** "@todos" in pt-BR, "@everyone" in English. */
  everyoneLabel: string;
}

export function userCandidate(m: Pick<Member, 'userId' | 'nickname'>): MentionCandidate {
  return { kind: 'user', id: m.userId, display: `@${m.nickname}`, token: `<@${m.userId}>` };
}

export function roleCandidate(r: Pick<Role, 'id' | 'name'>): MentionCandidate {
  return { kind: 'role', id: r.id, display: `@${r.name}`, token: `<@&${r.id}>` };
}

export function everyoneCandidate(label: string): MentionCandidate {
  return { kind: 'everyone', id: 'everyone', display: label, token: EVERYONE_MENTION };
}

/** Up to 8 suggestions: names starting with the query first, then names containing it. */
export function mentionSuggestions(query: string, src: SuggestionSource): MentionCandidate[] {
  const q = fold(query);
  const starts: MentionCandidate[] = [];
  const contains: MentionCandidate[] = [];
  const consider = (name: string, candidate: MentionCandidate) => {
    const key = fold(name);
    if (key.startsWith(q)) starts.push(candidate);
    else if (q !== '' && key.includes(q)) contains.push(candidate);
  };
  const members = [...src.members].sort((a, b) => Number(b.online) - Number(a.online) || a.nickname.localeCompare(b.nickname));
  for (const m of members) consider(m.nickname, userCandidate(m));
  for (const r of src.roles) {
    if (!r.isDefault && (r.mentionable || src.canMentionEveryone)) consider(r.name, roleCandidate(r));
  }
  if (src.canMentionEveryone) {
    consider(src.everyoneLabel.replace(/^@/, ''), everyoneCandidate(src.everyoneLabel));
    if (src.everyoneLabel !== EVERYONE_MENTION) consider('everyone', everyoneCandidate(src.everyoneLabel));
  }
  const seen = new Set<string>();
  return [...starts, ...contains].filter((c) => !seen.has(c.token) && seen.add(c.token)).slice(0, MENTION_SUGGESTIONS_MAX);
}

/** Replaces the `@query` being typed with the picked display and a space. */
export function applyMention(text: string, start: number, caret: number, c: MentionCandidate): { text: string; caret: number } {
  const insert = `${c.display} `;
  return { text: text.slice(0, start) + insert + text.slice(caret), caret: start + insert.length };
}

/** [start, end) ranges of ``` blocks and `inline` code (unclosed markers are text), like stripCode. */
function codeRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  let i = 0;
  while (i < text.length) {
    const tick = text.indexOf('`', i);
    if (tick < 0) break;
    if (text.startsWith('```', tick)) {
      const end = text.indexOf('```', tick + 3);
      if (end < 0) break;
      ranges.push([tick, end + 3]);
      i = end + 3;
    } else {
      const end = text.indexOf('`', tick + 1);
      if (end < 0) break;
      ranges.push([tick, end + 1]);
      i = end + 1;
    }
  }
  return ranges;
}

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[\p{L}\p{N}_]/u.test(c);
}

/**
 * One left-to-right pass outside code: at each `@` that starts a word, the longest
 * matching display that ends a word is replaced by `pick(display)`.
 */
function replaceDisplays(text: string, displays: readonly string[], pick: (display: string) => string): string {
  if (displays.length === 0) return text;
  const sorted = [...new Set(displays)].sort((a, b) => b.length - a.length);
  const code = codeRanges(text);
  let out = '';
  let i = 0;
  let r = 0;
  while (i < text.length) {
    while (r < code.length && code[r]![1] <= i) r += 1;
    const inCode = r < code.length && code[r]![0] <= i;
    if (!inCode && text[i] === '@' && !isWordChar(text[i - 1])) {
      const hit = sorted.find((d) => text.startsWith(d, i) && !isWordChar(text[i + d.length]));
      if (hit) {
        out += pick(hit);
        i += hit.length;
        continue;
      }
    }
    out += text[i];
    i += 1;
  }
  return out;
}

/** Turns picked displays into wire tokens before sending. */
export function encodeMentions(text: string, picked: readonly MentionCandidate[]): string {
  const byDisplay = new Map(picked.map((c) => [c.display, c.token]));
  return replaceDisplays(text, [...byDisplay.keys()], (d) => byDisplay.get(d)!);
}

/**
 * For editing: tokens of known members and roles become displays again, and the
 * returned candidates re-encode them on save. Unknown tokens stay as they are.
 */
export function decodeMentions(
  content: string,
  lookup: { member(id: string): Member | undefined; role(id: string): Role | undefined; everyoneLabel: string },
): { text: string; picked: MentionCandidate[] } {
  const picked = new Map<string, MentionCandidate>();
  const code = codeRanges(content);
  let out = '';
  let i = 0;
  let r = 0;
  const USER = /<@([0-9a-f]{32})>/y;
  const ROLE = /<@&([A-Z2-7]{26})>/y;
  while (i < content.length) {
    while (r < code.length && code[r]![1] <= i) r += 1;
    const inCode = r < code.length && code[r]![0] <= i;
    if (!inCode && content[i] === '<') {
      USER.lastIndex = i;
      const u = USER.exec(content);
      const member = u ? lookup.member(u[1]!) : undefined;
      if (u && member) {
        const c = userCandidate(member);
        picked.set(c.display, c);
        out += c.display;
        i += u[0].length;
        continue;
      }
      ROLE.lastIndex = i;
      const ro = ROLE.exec(content);
      const role = ro ? lookup.role(ro[1]!) : undefined;
      if (ro && role) {
        const c = roleCandidate(role);
        picked.set(c.display, c);
        out += c.display;
        i += ro[0].length;
        continue;
      }
    }
    if (!inCode && content.startsWith(EVERYONE_MENTION, i) && !isWordChar(content[i - 1]) && !isWordChar(content[i + EVERYONE_MENTION.length])) {
      const c = everyoneCandidate(lookup.everyoneLabel);
      picked.set(c.display, c);
      out += c.display;
      i += EVERYONE_MENTION.length;
      continue;
    }
    out += content[i];
    i += 1;
  }
  return { text: out, picked: [...picked.values()] };
}
