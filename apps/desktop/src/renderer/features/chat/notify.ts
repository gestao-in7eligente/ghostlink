// Which new messages deserve a desktop notification (spec 2026-10-02-notificacoes-design.md §1),
// following the server's mode: every message from someone else ('all'), only mentions of the user
// (directly, by role or @everyone) and replies to them ('mentions', the default), or none. The main
// process shows it only while the window is not focused (main/notifications.ts).
import { AVATAR_HASH, type Message } from '@ghostlink/shared';
import type { ChatNotification, NotifyMode } from '../../../shared/ipcTypes.js';
import type { Translate } from '../../i18n/index.js';
import { mentionsUser, type TextState } from '../../stores/textState.js';
import { markdownToPlainText, parseMarkdown } from './markdown.js';

/** Main keeps 200 characters of the text; this only keeps a huge message off the IPC. */
const BODY_MAX = 1_000;

export function memberName(state: Pick<TextState, 'members'>, userId: string | null, fallback: string): string {
  if (userId === null || !Object.hasOwn(state.members.byId, userId)) return fallback;
  return state.members.byId[userId]!.nickname;
}

/** The message as one line of plain text, mentions named (for notifications and reply previews). */
export function plainContent(state: Pick<TextState, 'members' | 'server'>, content: string, t: Translate, everyone = true): string {
  const roles = state.server.roles;
  return markdownToPlainText(parseMarkdown(content, { everyone }), {
    user: (id) => memberName(state, id, t('chat.formerMember')),
    role: (id) => (Object.hasOwn(roles, id) ? roles[id]!.name : t('chat.unknownRole').replace(/^@/, '')),
    everyone: t('chat.everyone'),
  });
}

/** A mention of me (or of a role of mine, or @everyone), or a reply to one of my messages. */
function concernsMe(state: TextState, message: Message): boolean {
  const self = state.server.selfId;
  const roleIds = Object.hasOwn(state.members.byId, self) ? state.members.byId[self]!.roleIds : [];
  return mentionsUser(message, self, roleIds) || (message.replyTo !== null && message.replyTo.authorId === self);
}

export function notificationFor(state: TextState, message: Message, t: Translate, mode: NotifyMode): ChatNotification | null {
  if (mode === 'none' || message.authorId === state.server.selfId) return null;
  if (!Object.hasOwn(state.channels.byId, message.channelId)) return null;
  const channel = state.channels.byId[message.channelId]!;
  if (channel.type !== 'text') return null;
  if (mode === 'mentions' && !concernsMe(state, message)) return null;
  const text = plainContent(state, message.content, t, message.mentions.everyone).slice(0, BODY_MAX);
  const files = message.attachments.length;
  const icon = state.server.icon;
  return {
    server: state.server.name,
    channel: channel.name,
    author: memberName(state, message.authorId, t('chat.formerMember')),
    // Files alone: "enviou um arquivo".
    body: text !== '' || files === 0 ? text : files === 1 ? t('notifications.file') : t('notifications.files', { count: files }),
    serverIcon: icon !== null && AVATAR_HASH.test(icon) ? icon : null,
    channelId: message.channelId,
  };
}
