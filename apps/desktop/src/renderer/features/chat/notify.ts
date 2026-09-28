// Which new messages deserve a desktop notification (spec §11.1 item 8): mentions of
// the user (directly, by role or @everyone) and replies to them. The main process
// shows it only while the window is not focused (main/notifications.ts).
import type { Message } from '@ghostlink/shared';
import type { ChatNotification } from '../../../shared/ipcTypes.js';
import type { Translate } from '../../i18n/index.js';
import { mentionsUser, type TextState } from '../../stores/textState.js';
import { markdownToPlainText, parseMarkdown } from './markdown.js';

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

export function notificationFor(state: TextState, message: Message, t: Translate): ChatNotification | null {
  const self = state.server.selfId;
  if (message.authorId === self) return null;
  if (!Object.hasOwn(state.channels.byId, message.channelId)) return null;
  const roleIds = Object.hasOwn(state.members.byId, self) ? state.members.byId[self]!.roleIds : [];
  const mention = mentionsUser(message, self, roleIds);
  const reply = message.replyTo !== null && message.replyTo.authorId === self;
  if (!mention && !reply) return null;
  const vars = { name: memberName(state, message.authorId, t('chat.formerMember')), channel: state.channels.byId[message.channelId]!.name };
  return {
    title: t(mention ? 'chat.notification.mention' : 'chat.notification.reply', vars),
    body: plainContent(state, message.content, t, message.mentions.everyone),
    channelId: message.channelId,
  };
}
