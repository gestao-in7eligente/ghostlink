// Message list rows (spec §11.1 item 5): date separators, and messages grouped by
// author when sent less than 5 minutes apart. Pure, so the list only renders rows.
import { CHAT_LIMITS, type Message } from '@ghostlink/shared';
import type { PendingMessage } from '../../stores/textState.js';

export type Row =
  | { kind: 'date'; key: string; at: number }
  | { kind: 'message'; key: string; message: Message; head: boolean }
  | { kind: 'pending'; key: string; pending: PendingMessage; head: boolean };

/** Local calendar day, so separators follow the user's clock. */
export function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * Rows for a channel: loaded messages (oldest first), then the user's own
 * messages still being sent. A group starts on a new author, a new day, a reply,
 * or a gap of 5 minutes or more.
 */
export function buildRows(items: readonly Message[], pending: readonly PendingMessage[], selfId: string): Row[] {
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
  for (const message of items) {
    const head = place(message.authorId, message.createdAt, message.replyTo !== null);
    rows.push({ kind: 'message', key: `m:${message.id}`, message, head });
  }
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
