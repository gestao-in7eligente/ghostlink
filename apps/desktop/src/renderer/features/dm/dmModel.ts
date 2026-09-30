// Pure rules of the direct-message screen (friends spec §8): rows of a conversation,
// the sidebar order, and how events from main change what is on screen.
import { CHAT_LIMITS } from '@ghostlink/shared';
import type { DmConversation, DmMessage } from '../../../shared/dmTypes.js';
import { dayKey } from '../chat/grouping.js';

export type DmRow =
  | { kind: 'date'; key: string; at: number }
  /** `head` starts a group: the avatar, the name and the time show. */
  | { kind: 'message'; key: string; message: DmMessage; head: boolean };

/**
 * Rows of a conversation, messages oldest first. As in server channels, a group starts on
 * a new author, a new day, a reply, or a gap of 5 minutes or more.
 */
export function buildDmRows(messages: readonly DmMessage[]): DmRow[] {
  const rows: DmRow[] = [];
  let lastAuthor: string | null = null;
  let lastAt = 0;
  let lastDay = '';
  for (const message of messages) {
    const day = dayKey(message.ts);
    if (day !== lastDay) rows.push({ kind: 'date', key: `date:${day}`, at: message.ts });
    const head = day !== lastDay || message.replyTo !== null || message.author !== lastAuthor || message.ts - lastAt >= CHAT_LIMITS.groupWindowMs;
    rows.push({ kind: 'message', key: `m:${message.id}`, message, head });
    lastAuthor = message.author;
    lastAt = message.ts;
    lastDay = day;
  }
  return rows;
}

const byTime = (a: DmMessage, b: DmMessage) => a.ts - b.ts || a.id.localeCompare(b.id);

/** A message arrived or changed: replaces it by id, or puts it in its place in time. */
export function applyMessage(messages: readonly DmMessage[], message: DmMessage): DmMessage[] {
  const at = messages.findIndex((m) => m.id === message.id);
  if (at >= 0) return messages.map((m, i) => (i === at ? message : m));
  return [...messages, message].sort(byTime);
}

/** An older page loaded on scroll: joins it without repeating what is already there. */
export function mergeHistory(messages: readonly DmMessage[], page: readonly DmMessage[]): DmMessage[] {
  const known = new Set(messages.map((m) => m.id));
  return [...page.filter((m) => !known.has(m.id)), ...messages].sort(byTime);
}

/** A conversation appeared or its summary changed. */
export function applyConversation(list: readonly DmConversation[], conversation: DmConversation): DmConversation[] {
  return list.some((c) => c.id === conversation.id) ? list.map((c) => (c.id === conversation.id ? conversation : c)) : [...list, conversation];
}

/** The sidebar: conversations not closed, the most recent first, the empty ones last. */
export function sidebarConversations(list: readonly DmConversation[]): DmConversation[] {
  return list.filter((c) => !c.hidden).sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0) || a.id.localeCompare(b.id));
}

/** Unread messages over every conversation (the Home button's badge). */
export function totalUnread(list: readonly DmConversation[]): number {
  return list.reduce((sum, c) => sum + c.unread, 0);
}

/** The message a reply points to, among the loaded ones; null when it is older than what is loaded. */
export function repliedMessage(messages: readonly DmMessage[], replyTo: string | null): DmMessage | null {
  return replyTo === null ? null : (messages.find((m) => m.id === replyTo) ?? null);
}

/** "Digitando…" lasts this long after the last signal. */
export const TYPING_TTL_MS = 5_000;

/** Whether a typing signal received at `since` still counts at `now`. */
export function isTyping(since: number | undefined, now: number): boolean {
  return since !== undefined && now - since < TYPING_TTL_MS;
}
