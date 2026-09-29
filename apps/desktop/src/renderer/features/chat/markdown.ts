// Light markdown for chat messages (spec §11.1 item 5): a hand-written parser that
// builds a small AST, rendered to React elements by markdownRender.ts. It never
// produces HTML. Every scan is linear: closing delimiters are found with memoized
// forward searches (each text region is scanned at most once per delimiter), and
// nesting is capped, so hostile input cannot cause catastrophic backtracking.

export type Inline =
  | { k: 'text'; text: string }
  | { k: 'br' }
  | { k: 'bold'; children: Inline[] }
  | { k: 'italic'; children: Inline[] }
  | { k: 'underline'; children: Inline[] }
  | { k: 'strike'; children: Inline[] }
  | { k: 'code'; text: string }
  | { k: 'link'; url: string }
  | { k: 'user'; id: string }
  | { k: 'role'; id: string }
  | { k: 'everyone' };

export type Block =
  | { k: 'paragraph'; children: Inline[] }
  | { k: 'quote'; children: Inline[] }
  | { k: 'codeblock'; lang: string | null; text: string };

export interface MarkdownOptions {
  /** Render `@everyone` as a mention (only when the server accepted it: message.mentions.everyone). */
  everyone?: boolean;
}

/** Deeper formatting than this is shown as plain text. */
const MAX_DEPTH = 4;
/** Longer "links" are plain text; the main process refuses them anyway (externalLinks.ts). */
const MAX_URL_LENGTH = 2048;
const ESCAPABLE = new Set(['\\', '*', '_', '~', '`', '>', '@', '<', '|']);
const URL_STOP = new Set(['<', '>', '"', '`', ' ']);
const URL_TRAILING = new Set(['.', ',', ':', ';', '!', '?', "'", '"', '*', '_', '~']);
const USER_TOKEN = /<@([0-9a-f]{32})>/y;
const ROLE_TOKEN = /<@&([A-Z2-7]{26})>/y;
const LANG_LINE = /^([A-Za-z0-9_+#.-]{1,32})\n/;
const EVERYONE = '@everyone';

function isSpace(c: string | undefined): boolean {
  return c === undefined || c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === ' ';
}

/** Letters, digits and the underscore: `snake_case` and `e@everyone.com` are not markup. */
function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[\p{L}\p{N}_]/u.test(c);
}

/**
 * Finds closing delimiters left to right. For each kind it remembers the last
 * answer (the first valid position at or after `from`), so later searches from a
 * larger `from` reuse it, and fresh searches only scan text never scanned before.
 */
class Closers {
  readonly #memo = new Map<string, { from: number; at: number }>();

  constructor(private readonly text: string) {}

  next(kind: string, delim: string, from: number, valid: (at: number) => boolean): number {
    const memo = this.#memo.get(kind);
    if (memo && memo.from <= from && (memo.at === -1 || memo.at >= from)) return memo.at;
    let at = from;
    for (;;) {
      at = this.text.indexOf(delim, at);
      if (at < 0 || valid(at)) break;
      at += 1;
    }
    this.#memo.set(kind, { from, at });
    return at;
  }
}

/** The end of an http(s) URL starting at `start`, trailing punctuation excluded; -1 when too long. */
function urlEnd(text: string, start: number): number {
  let end = start;
  let open = 0;
  let close = 0;
  while (end < text.length && !isSpace(text[end]) && !URL_STOP.has(text[end]!)) {
    if (text[end] === '(') open += 1;
    else if (text[end] === ')') close += 1;
    end += 1;
    if (end - start > MAX_URL_LENGTH) {
      // Skip the whole run so it is not scanned again from every position.
      while (end < text.length && !isSpace(text[end]) && !URL_STOP.has(text[end]!)) end += 1;
      return -end - 1;
    }
  }
  for (;;) {
    const last = text[end - 1]!;
    if (URL_TRAILING.has(last)) end -= 1;
    else if (last === ')' && close > open) {
      close -= 1;
      end -= 1;
    } else break;
  }
  return end;
}

/** Only plain http(s) links with a host and without credentials become links. */
export function safeLink(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.hostname === '' || url.username !== '' || url.password !== '') return null;
  return raw;
}

function parseInline(text: string, depth: number, opts: MarkdownOptions): Inline[] {
  const out: Inline[] = [];
  const closers = new Closers(text);
  let buf = '';
  const flush = () => {
    if (buf !== '') out.push({ k: 'text', text: buf });
    buf = '';
  };
  const nested = (kind: 'bold' | 'italic' | 'underline' | 'strike', from: number, to: number) => {
    flush();
    out.push({ k: kind, children: parseInline(text.slice(from, to), depth + 1, opts) });
  };
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i]!;
    const next = text[i + 1];

    if (c === '\\' && next !== undefined && ESCAPABLE.has(next)) {
      buf += next;
      i += 2;
      continue;
    }
    if (c === '\n') {
      flush();
      out.push({ k: 'br' });
      i += 1;
      continue;
    }
    if (c === '`') {
      const end = closers.next('`', '`', i + 1, () => true);
      if (end > i + 1) {
        flush();
        out.push({ k: 'code', text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (depth < MAX_DEPTH) {
      if (c === '*' && next === '*') {
        const end = closers.next('**', '**', i + 2, () => true);
        if (end > i + 2) {
          nested('bold', i + 2, end);
          i = end + 2;
          continue;
        }
      } else if (c === '_' && next === '_') {
        const end = closers.next('__', '__', i + 2, () => true);
        if (end > i + 2) {
          nested('underline', i + 2, end);
          i = end + 2;
          continue;
        }
      } else if (c === '~' && next === '~') {
        const end = closers.next('~~', '~~', i + 2, () => true);
        if (end > i + 2) {
          nested('strike', i + 2, end);
          i = end + 2;
          continue;
        }
      } else if (c === '*' && !isSpace(next)) {
        // A single star, closed by a single star that does not follow a space.
        const end = closers.next('*', '*', i + 1, (at) => text[at + 1] !== '*' && text[at - 1] !== '*' && !isSpace(text[at - 1]));
        if (end > i + 1) {
          nested('italic', i + 1, end);
          i = end + 1;
          continue;
        }
      } else if (c === '_' && !isSpace(next) && !isWordChar(text[i - 1])) {
        // _italic_, but never inside snake_case words.
        const end = closers.next('_', '_', i + 1, (at) => text[at + 1] !== '_' && !isWordChar(text[at + 1]) && !isSpace(text[at - 1]));
        if (end > i + 1) {
          nested('italic', i + 1, end);
          i = end + 1;
          continue;
        }
      }
    }
    if (c === 'h' && !isWordChar(text[i - 1]) && (text.startsWith('https://', i) || text.startsWith('http://', i))) {
      const end = urlEnd(text, i);
      if (end < 0) {
        buf += text.slice(i, -end - 1);
        i = -end - 1;
        continue;
      }
      const url = safeLink(text.slice(i, end));
      if (url !== null) {
        flush();
        out.push({ k: 'link', url });
        i = end;
        continue;
      }
      buf += text.slice(i, end);
      i = end;
      continue;
    }
    if (c === '<' && next === '@') {
      USER_TOKEN.lastIndex = i;
      const user = USER_TOKEN.exec(text);
      if (user) {
        flush();
        out.push({ k: 'user', id: user[1]! });
        i += user[0].length;
        continue;
      }
      ROLE_TOKEN.lastIndex = i;
      const role = ROLE_TOKEN.exec(text);
      if (role) {
        flush();
        out.push({ k: 'role', id: role[1]! });
        i += role[0].length;
        continue;
      }
    }
    if (c === '@' && opts.everyone && text.startsWith(EVERYONE, i)) {
      const before = text[i - 1];
      if (!isWordChar(before) && before !== '@' && before !== '.' && !isWordChar(text[i + EVERYONE.length])) {
        flush();
        out.push({ k: 'everyone' });
        i += EVERYONE.length;
        continue;
      }
    }
    buf += c;
    i += 1;
  }
  flush();
  return out;
}

/** Splits plain (non-code) text into paragraphs and `> ` quotes. */
function textBlocks(text: string, opts: MarkdownOptions, out: Block[]): void {
  if (text === '') return;
  const lines = text.split('\n');
  let run: string[] = [];
  let quoting = false;
  const emit = () => {
    if (run.length === 0) return;
    const children = parseInline(run.join('\n'), 0, opts);
    if (children.length > 0 || quoting) out.push({ k: quoting ? 'quote' : 'paragraph', children });
    run = [];
  };
  for (const line of lines) {
    const quote = line === '>' || line.startsWith('> ');
    if (quote !== quoting) {
      emit();
      quoting = quote;
    }
    run.push(quote ? line.slice(2) : line);
  }
  emit();
}

/** Parses a message into blocks: ``` code blocks first, then paragraphs and quotes. */
export function parseMarkdown(src: string, opts: MarkdownOptions = {}): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('```', i);
    const close = open < 0 ? -1 : src.indexOf('```', open + 3);
    if (close < 0) {
      // No (complete) fence left: the rest is text, an unclosed fence included.
      textBlocks(src.slice(i), opts, out);
      break;
    }
    const before = src.slice(i, open);
    textBlocks(before.endsWith('\n') ? before.slice(0, -1) : before, opts, out);
    let body = src.slice(open + 3, close);
    let lang: string | null = null;
    const langLine = LANG_LINE.exec(body);
    if (langLine) {
      lang = langLine[1]!;
      body = body.slice(langLine[0].length);
    } else if (body.startsWith('\n')) {
      body = body.slice(1);
    }
    if (body.endsWith('\n')) body = body.slice(0, -1);
    out.push({ k: 'codeblock', lang, text: body });
    i = close + 3;
    if (src[i] === '\n') i += 1;
  }
  return out;
}

export interface PlainTextNames {
  user(id: string): string;
  role(id: string): string;
  everyone: string;
}

function inlineText(nodes: readonly Inline[], names: PlainTextNames): string {
  let out = '';
  for (const node of nodes) {
    switch (node.k) {
      case 'text':
        out += node.text;
        break;
      case 'br':
        out += '\n';
        break;
      case 'code':
        out += node.text;
        break;
      case 'link':
        out += node.url;
        break;
      case 'user':
        out += `@${names.user(node.id)}`;
        break;
      case 'role':
        out += `@${names.role(node.id)}`;
        break;
      case 'everyone':
        out += names.everyone;
        break;
      default:
        out += inlineText(node.children, names);
    }
  }
  return out;
}

/** The message as plain text (notifications, reply previews): markup removed, mentions named. */
export function markdownToPlainText(blocks: readonly Block[], names: PlainTextNames): string {
  return blocks.map((b) => (b.k === 'codeblock' ? b.text : inlineText(b.children, names))).join('\n');
}
