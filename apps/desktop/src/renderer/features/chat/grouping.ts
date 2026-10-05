// Message list rows (spec §11.1 item 5): date separators, and messages grouped by
// author when sent less than 5 minutes apart. Pure, so the list only renders rows.
import { CHAT_LIMITS, type Message } from '@ghostlink/shared';
import type { BotLocal, PendingMessage } from '../../stores/textState.js';

export type Row =
  | { kind: 'date'; key: string; at: number }
  | { kind: 'message'; key: string; message: Message; head: boolean }
  | { kind: 'pending'; key: string; pending: PendingMessage; head: boolean }
  /** An interaction line only this app shows (bots spec §3), right after the message it followed. */
  | { kind: 'bot'; key: string; local: BotLocal; head: true };

/** Local calendar day, so separators follow the user's clock. */
export function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * Rows for a channel: loaded messages (oldest first), with the interaction lines after the
 * message each one followed, then the user's own messages still being sent. A group starts on a
 * new author, a new day, a reply, a bot's answer to a command, after an interaction line, or after
 * a gap of 5 minutes or more.
 */
export function buildRows(items: readonly Message[], pending: readonly PendingMessage[], selfId: string, locals: readonly BotLocal[] = []): Row[] {
  const rows: Row[] = [];
  let lastAuthor: string | null = null;
  let lastAt = 0;
  let lastDay = '';
  const place = (authorId: string, at: number, isReply: boolean): boolean => {
    const day = dayKey(at);
    if (day !== lastDay) rows.push({ kind: 'date', key: `date:${day}`, at });
    const head = day !== lastDay || isReply || authorId !== lastAuthor || at - lastAt >= CHAT_LIMITS.groupWindowMs;
    lastAuthor = authorId;
    lastAt = at;
    lastDay = day;
    return head;
  };
  // Stable: lines after the same message keep the order they appeared in.
  const queue = [...locals].sort((a, b) => a.afterId - b.afterId);
  let q = 0;
  const flush = (beforeId: number) => {
    while (q < queue.length && queue[q]!.afterId < beforeId) {
      const local = queue[q++]!;
      rows.push({ kind: 'bot', key: `b:${local.kind}:${local.id}`, local, head: true });
      lastAuthor = null;
    }
  };
  for (const message of items) {
    flush(message.id);
    const head = place(message.authorId, message.createdAt, message.replyTo !== null || message.interaction !== null);
    rows.push({ kind: 'message', key: `m:${message.id}`, message, head });
  }
  flush(Number.POSITIVE_INFINITY);
  for (const p of pending) {
    const head = place(selfId, Math.max(p.createdAt, lastAt), p.replyTo !== null);
    rows.push({ kind: 'pending', key: `p:${p.clientMsgId}`, pending: p, head });
  }
  return rows;
}

// ---- dates (Intl, spec §11) ----

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(locale: string, key: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const id = `${locale}|${key}`;
  let f = formatters.get(id);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, options);
    formatters.set(id, f);
  }
  return f;
}

/** "19 de setembro de 2026" / "September 19, 2026". */
export function formatDay(at: number, locale: string): string {
  return formatter(locale, 'day', { day: 'numeric', month: 'long', year: 'numeric' }).format(at);
}

/** "09:36". */
export function formatTime(at: number, locale: string): string {
  return formatter(locale, 'time', { hour: '2-digit', minute: '2-digit' }).format(at);
}

/** "19/09/2026 09:36" / "09/19/2026 09:36 AM". */
export function formatStamp(at: number, locale: string): string {
  return `${formatter(locale, 'date', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(at)} ${formatTime(at, locale)}`;
}

/** Full date and time for a tooltip. */
export function formatFull(at: number, locale: string): string {
  return formatter(locale, 'full', { dateStyle: 'full', timeStyle: 'short' }).format(at);
}
