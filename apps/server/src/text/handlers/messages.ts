import {
  CHAT_LIMITS,
  LIMITS,
  PERMISSIONS,
  ProtocolError,
  cleanMessageContent,
  extractMentions,
  has,
  msgDeleteSchema,
  msgEditSchema,
  msgHistorySchema,
  msgReactSchema,
  msgSendSchema,
  typingSchema,
  type Message,
  type MessageMentions,
} from '@ghostlink/shared';
import type { RequestContext } from '../../modules.js';
import type { Subject } from '../access.js';
import type { TextCore } from '../core.js';
import type { ChannelRow, MessageRow } from '../repo.js';

type Handler = (core: TextCore, ctx: RequestContext, payload: unknown) => unknown;

function textChannel(core: TextCore, actor: Subject, channelId: string): { channel: ChannelRow; bits: number } {
  const found = core.access.visibleChannel(actor, channelId);
  // Voice channels have no chat in v0.1 (spec §5.2).
  if (found.channel.type !== 'text') throw new ProtocolError('BAD_REQUEST', 'voice channels have no messages');
  return found;
}

/** A live message the actor can currently see; NOT_FOUND otherwise, even for its author (spec §5.3). */
function visibleMessage(core: TextCore, actor: Subject, id: number): { row: MessageRow; channel: ChannelRow; bits: number } {
  const row = core.repo.message(id);
  if (!row || row.deleted_at !== null) throw new ProtocolError('NOT_FOUND');
  const { channel, bits } = textChannel(core, actor, row.channel_id);
  return { row, channel, bits };
}

function content(raw: string): string {
  const text = cleanMessageContent(raw);
  if (text === '') throw new ProtocolError('BAD_REQUEST', 'empty message');
  return text;
}

/**
 * Mentions that take effect (spec §5.2, §5.3, §7): users who are members;
 * roles that are mentionable (or any role with MENTION_EVERYONE); `@everyone`
 * only with MENTION_EVERYONE. Notification rows go only to members who can
 * see the channel right now, never to the author.
 */
function resolveMentions(core: TextCore, author: string, bits: number, channel: ChannelRow, text: string): { shown: MessageMentions; recipients: string[] } {
  const parsed = extractMentions(text);
  if (parsed.users.length === 0 && parsed.roles.length === 0 && !parsed.everyone) {
    return { shown: { users: [], roles: [], everyone: false }, recipients: [] };
  }
  const members = new Set(core.repo.memberIds());
  const canEveryone = has(bits, PERMISSIONS.MENTION_EVERYONE);
  const users = parsed.users.filter((u) => members.has(u));
  const roles = parsed.roles.filter((id) => {
    const role = core.repo.role(id);
    return role !== undefined && role.is_default === 0 && (role.mentionable === 1 || canEveryone);
  });
  const everyone = parsed.everyone && canEveryone;
  const targets = new Set(everyone ? members : users);
  for (const roleId of roles) for (const u of core.repo.roleMembers(roleId)) targets.add(u);
  targets.delete(author);
  const canView = core.access.audience(channel);
  const recipients = [...targets].filter(canView);
  return { shown: { users, roles, everyone }, recipients };
}

function writeMentions(core: TextCore, messageId: number, m: { shown: MessageMentions; recipients: string[] }): void {
  core.db.run(
    'UPDATE messages SET mention_users = ?, mention_roles = ?, mention_everyone = ? WHERE id = ?',
    JSON.stringify(m.shown.users), JSON.stringify(m.shown.roles), m.shown.everyone ? 1 : 0, messageId,
  );
  core.db.run('DELETE FROM mentions WHERE message_id = ?', messageId);
  for (const u of m.recipients) core.db.run('INSERT INTO mentions (message_id, user_id) VALUES (?, ?)', messageId, u);
}

/** Soft delete (spec §7): the content is cleared at once; reactions and mentions go too. Call inside db.tx. */
export function softDeleteMessage(core: TextCore, id: number): void {
  core.db.run(
    `UPDATE messages SET content = '', deleted_at = ?, mention_users = '[]', mention_roles = '[]', mention_everyone = 0
     WHERE id = ? AND deleted_at IS NULL`,
    core.now(), id,
  );
  core.db.run('DELETE FROM reactions WHERE message_id = ?', id);
  core.db.run('DELETE FROM mentions WHERE message_id = ?', id);
}

/**
 * A history page stays this far under the client's frame cap (spec §5.1: 256 KiB),
 * leaving room for the `res` envelope. 50 messages of 4000 three-byte characters
 * are ~600 KB: a page that big would make the client drop the connection, then
 * reload the same page after reconnecting, forever.
 */
export const HISTORY_PAGE_MAX_BYTES = LIMITS.maxPayloadBytes - 4 * 1024;

const history: Handler = (core, ctx, payload) => {
  const p = msgHistorySchema.parse(payload);
  const actor = core.member(ctx.userId);
  const { channel } = textChannel(core, actor, p.channelId);
  const limit = p.limit ?? CHAT_LIMITS.historyPageMax;
  const rows = core.db.all<MessageRow>(
    `SELECT * FROM messages WHERE channel_id = ? AND deleted_at IS NULL AND id < ? ORDER BY id DESC LIMIT ?`,
    channel.id, p.before ?? Number.MAX_SAFE_INTEGER, limit + 1,
  );
  let hasMore = rows.length > limit;
  // Newest first, until the byte budget is spent; the rest comes with the next page
  // (`before` = the oldest message returned). The newest one always goes, so paging advances.
  const page: Message[] = [];
  let bytes = 0;
  for (const message of core.repo.toMessages(rows.slice(0, limit))) {
    const size = Buffer.byteLength(JSON.stringify(message), 'utf8') + 1;
    if (page.length > 0 && bytes + size > HISTORY_PAGE_MAX_BYTES) {
      hasMore = true;
      break;
    }
    page.push(message);
    bytes += size;
  }
  return { messages: page.reverse(), hasMore };
};

const send: Handler = (core, ctx, payload) => {
  const p = msgSendSchema.parse(payload);
  const actor = core.member(ctx.userId);
  const { channel, bits } = textChannel(core, actor, p.channelId);
  if (!has(bits, PERMISSIONS.SEND_MESSAGES)) throw new ProtocolError('FORBIDDEN');
  // Files arrive in v0.2: no attachment can satisfy the spec §5.3 rules yet.
  if (p.attachmentIds !== undefined && p.attachmentIds.length > 0) throw new ProtocolError('BAD_ATTACHMENT');
  const text = content(p.content);

  // A retry with the same clientMsgId returns the original message (UNIQUE(user_id, client_msg_id)).
  const existing = core.db.get<MessageRow>('SELECT * FROM messages WHERE user_id = ? AND client_msg_id = ?', ctx.userId, p.clientMsgId);
  if (existing) {
    if (existing.channel_id !== channel.id || existing.deleted_at !== null) throw new ProtocolError('BAD_REQUEST', 'clientMsgId reused');
    return { message: core.repo.toMessage(existing) };
  }
  if (!core.limiters.msgSend.take(ctx.userId)) throw new ProtocolError('RATE_LIMITED');

  if (p.replyTo !== undefined) {
    const target = core.repo.message(p.replyTo);
    // A reply must quote a live message of the same channel (spec §5.3).
    if (!target || target.channel_id !== channel.id || target.deleted_at !== null) throw new ProtocolError('NOT_FOUND');
  }
  const mentions = resolveMentions(core, ctx.userId, bits, channel, text);
  const id = core.db.tx(() => {
    const { lastInsertRowid } = core.db.run(
      'INSERT INTO messages (channel_id, user_id, content, reply_to_id, created_at, client_msg_id) VALUES (?, ?, ?, ?, ?, ?)',
      channel.id, ctx.userId, text, p.replyTo ?? null, core.now(), p.clientMsgId,
    );
    writeMentions(core, lastInsertRowid, mentions);
    // Your own message is read by definition.
    core.db.run(
      `INSERT INTO read_states (user_id, channel_id, last_read_message_id) VALUES (?, ?, ?)
       ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_message_id = excluded.last_read_message_id`,
      ctx.userId, channel.id, lastInsertRowid,
    );
    return lastInsertRowid;
  });
  const message = core.repo.toMessage(core.repo.message(id)!);
  core.broadcastChannel(channel, { t: 'msg.new', d: { message } });
  return { message };
};

const edit: Handler = (core, ctx, payload) => {
  const p = msgEditSchema.parse(payload);
  const actor = core.member(ctx.userId);
  const { row, channel, bits } = visibleMessage(core, actor, p.id);
  if (row.user_id !== ctx.userId) throw new ProtocolError('FORBIDDEN');
  const text = content(p.content);
  if (text !== row.content) {
    // Only a real change is broadcast, so only a real change is counted.
    if (!core.limiters.msgEdit.take(ctx.userId)) throw new ProtocolError('RATE_LIMITED');
    const mentions = resolveMentions(core, ctx.userId, bits, channel, text);
    core.db.tx(() => {
      core.db.run('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?', text, core.now(), row.id);
      writeMentions(core, Number(row.id), mentions);
    });
  }
  const message = core.repo.toMessage(core.repo.message(Number(row.id))!);
  if (text !== row.content) core.broadcastChannel(channel, { t: 'msg.updated', d: { message } });
  return { message };
};

const remove: Handler = (core, ctx, payload) => {
  const p = msgDeleteSchema.parse(payload);
  const actor = core.member(ctx.userId);
  const { row, channel, bits } = visibleMessage(core, actor, p.id);
  if (row.user_id !== ctx.userId && !has(bits, PERMISSIONS.MANAGE_MESSAGES)) throw new ProtocolError('FORBIDDEN');
  core.db.tx(() => softDeleteMessage(core, Number(row.id)));
  core.broadcastChannel(channel, { t: 'msg.deleted', d: { id: Number(row.id), channelId: channel.id } });
  return {};
};

function reactionChange(add: boolean): Handler {
  return (core, ctx, payload) => {
    const p = msgReactSchema.parse(payload);
    const actor = core.member(ctx.userId);
    const { row, channel, bits } = visibleMessage(core, actor, p.id);
    if (!has(bits, PERMISSIONS.ADD_REACTIONS)) throw new ProtocolError('FORBIDDEN');
    if (!core.limiters.react.hit(ctx.userId)) throw new ProtocolError('RATE_LIMITED');
    const id = Number(row.id);
    const changed = core.db.tx(() => {
      if (!add) return core.db.run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', id, ctx.userId, p.emoji).changes > 0;
      const present = core.db.get('SELECT 1 AS x FROM reactions WHERE message_id = ? AND emoji = ? LIMIT 1', id, p.emoji);
      if (!present) {
        const distinct = core.db.get<{ n: number }>('SELECT COUNT(DISTINCT emoji) AS n FROM reactions WHERE message_id = ?', id);
        if (Number(distinct?.n ?? 0) >= CHAT_LIMITS.maxReactionsPerMessage) throw new ProtocolError('BAD_REQUEST', 'too many distinct reactions');
      }
      return core.db.run(
        'INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)',
        id, ctx.userId, p.emoji, core.now(),
      ).changes > 0;
    });
    const reactions = core.repo.reactions(id);
    if (changed) core.broadcastChannel(channel, { t: 'msg.reactions', d: { id, channelId: channel.id, reactions } });
    return { reactions };
  };
}

const typing: Handler = (core, ctx, payload) => {
  const p = typingSchema.parse(payload);
  const actor = core.member(ctx.userId);
  const { channel, bits } = textChannel(core, actor, p.channelId);
  if (!has(bits, PERMISSIONS.SEND_MESSAGES)) throw new ProtocolError('FORBIDDEN');
  if (!core.limiters.typing.hit(ctx.userId)) throw new ProtocolError('RATE_LIMITED');
  core.broadcastChannel(channel, { t: 'typing', d: { channelId: channel.id, userId: ctx.userId } }, ctx.userId);
  return {};
};

export const messageHandlers: Record<string, Handler> = {
  'msg.history': history,
  'msg.send': send,
  'msg.edit': edit,
  'msg.delete': remove,
  'msg.react': reactionChange(true),
  'msg.unreact': reactionChange(false),
  typing,
};
