// Pure rules of the direct-message screen (friends spec §8): rows of a conversation,
// the sidebar order, and how events from main change what is on screen.
import { CHAT_LIMITS } from '@ghostlink/shared';
import { dmFileUrl } from '../../../shared/attachmentTypes.js';
import { DM_AUTO_FETCH_MAX_BYTES, type DmAttachment, type DmConversation, type DmFileState, type DmMessage } from '../../../shared/dmTypes.js';
import type { AttachmentView } from '../attachments/attachmentModel.js';
import { dayKey } from '../chat/grouping.js';
import { markdownToPlainText, parseMarkdown } from '../chat/markdown.js';

/** A conversation id (spec §4.1). A server channel id is 26 base32 characters, so the two never mix. */
export const DM_CONV_ID = /^[0-9a-f]{32}$/;

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

/**
 * A file moved (it is coming, it arrived, it failed, it went away): every loaded message that
 * carries it shows the new state. The same array comes back when no message carries it.
 */
export function applyFile(messages: DmMessage[], hash: string, state: DmFileState, received: number): DmMessage[] {
  if (!messages.some((m) => m.attachments.some((a) => a.hash === hash))) return messages;
  return messages.map((m) =>
    m.attachments.some((a) => a.hash === hash) ? { ...m, attachments: m.attachments.map((a) => (a.hash === hash ? { ...a, state, received } : a)) } : m,
  );
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

const NO_MENTIONS = { user: () => '', role: () => '', everyone: '@everyone' };

/** A message as one line of plain text (reply previews): markup removed, whitespace folded. */
export function plainDm(text: string): string {
  return markdownToPlainText(parseMarkdown(text), NO_MENTIONS).replace(/\s+/g, ' ').trim();
}

/** What a file's note says, in the person's language. */
export interface DmFileNotes {
  /** "Chega quando {nome} estiver online". */
  waiting: string;
  /** "Carregando…": an image on its way by itself. */
  arriving: string;
  /** "Recebendo… 40%". */
  loading: (percent: number) => string;
}

/**
 * A message's files as the shared pieces show them (attachments spec §1, §3). A file that is
 * here shows as itself, served at app://ghostlink/_dmfile. One that is not:
 * - while the friend is offline: its note says it arrives when they are online;
 * - an image on its way (by itself up to 5 MB, or asked for): the image's place with its progress;
 * - anything else (a bigger image, video, audio, a document, or one that failed): a card whose
 *   "Baixar" asks the friend for it (a card's button works only with a `src`, so it gets one).
 */
export function dmAttachmentViews(files: readonly DmAttachment[], online: boolean, notes: DmFileNotes): AttachmentView[] {
  return files.map((f) => {
    const base: AttachmentView = { key: f.hash, name: f.name, size: f.size, kind: f.kind, mime: f.mime, width: f.width, height: f.height, src: null };
    if (f.state === 'ready') return { ...base, src: dmFileUrl(f.hash) };
    const percent = f.size > 0 ? Math.floor((100 * f.received) / f.size) : 0;
    if (f.state === 'loading') return f.kind === 'image' ? { ...base, note: notes.loading(percent) } : { ...base, kind: 'file', note: notes.loading(percent) };
    if (!online) return f.kind === 'image' ? { ...base, note: notes.waiting } : { ...base, kind: 'file', note: notes.waiting };
    if (f.state === 'absent' && f.kind === 'image' && f.size <= DM_AUTO_FETCH_MAX_BYTES) return { ...base, note: notes.arriving };
    return { ...base, kind: 'file', src: dmFileUrl(f.hash) };
  });
}

/** A message of files alone has no text; the reply bar and the composer show their names. */
export function dmSummary(message: Pick<DmMessage, 'text' | 'attachments'>): string {
  return message.text !== '' ? plainDm(message.text) : message.attachments.map((f) => f.name).join(', ');
}

/** "Digitando…" lasts this long after the last signal. */
export const TYPING_TTL_MS = 5_000;

/** Whether a typing signal received at `since` still counts at `now`. */
export function isTyping(since: number | undefined, now: number): boolean {
  return since !== undefined && now - since < TYPING_TTL_MS;
}
