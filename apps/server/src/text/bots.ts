import { ProtocolError, cleanMessageContent, type ErrorCode, type Member, type Message, type MessageInteraction } from '@ghostlink/shared';
import type { ServerEvent } from '../modules.js';
import type { TextCore } from './core.js';
import { dropMembership, finishRemoval } from './handlers/members.js';
import { editMessageText, messageBuckets, postMessage } from './handlers/messages.js';

/**
 * What the bots module (src/bots/, bots spec §2) needs from the text module: bot members
 * appear and leave like members, and interaction answers are messages. Everything is read
 * fresh from the database.
 */
export interface BotTextApi {
  /** The member as stored now (null when not a member). */
  member(userId: string): Member | null;
  isMember(userId: string): boolean;
  /**
   * A text channel `userId` can see, with their bits in it: NOT_FOUND when it is missing or
   * hidden from them, BAD_REQUEST for a voice channel (as msg.send).
   */
  textChannel(userId: string, channelId: string): { channelId: string; bits: number };
  /** Bits of `userId` in the channel; 0 when they cannot see it or it does not exist. */
  channelBits(userId: string, channelId: string): number;
  /** A channel's name (text or voice), or null when it does not exist. */
  channelName(channelId: string): string | null;
  /** A text channel id `userId` can see (an interaction's `channel` option). */
  canSeeChannel(userId: string, channelId: string): boolean;
  /**
   * Every text channel `viewerId` can see, in their order, with the bits `userId` has there
   * (0 when it is hidden from them): what a bot may do, as the bot's settings show it.
   */
  textChannelsFor(viewerId: string, userId: string): { channelId: string; bits: number }[];
  /** Sends a channel event to whoever can see the channel now (audience rule, spec §5.3). */
  broadcastChannel(channelId: string, event: ServerEvent): void;
  /** Sends a membership-level event to every member. */
  broadcastMembers(event: ServerEvent): void;
  /** A member just created by the server (a bot): `member.joined` to everyone. */
  memberCreated(userId: string): void;
  /**
   * A system bot (the Ghost DJ) has no session: it counts as online while the server runs.
   * `presence` goes to everyone when it changes.
   */
  setOnline(userId: string, online: boolean): void;
  /**
   * Ends a membership: `update` runs in the same transaction as the removal of roles, read
   * states and mentions (messages stay), then the session closes with `closeWith` and everyone
   * learns `member.left`.
   */
  removeMember(userId: string, update: () => void, closeWith: ErrorCode): void;
  /**
   * A message by `authorId` (a bot) in the channel, under the bot message limit: NOT_FOUND when
   * the channel is gone, BAD_REQUEST when the text is empty, RATE_LIMITED. A `replyTo` that is no
   * longer a live message of the channel is dropped.
   */
  post(m: { channelId: string; authorId: string; content: string; replyTo?: number | null; interaction?: MessageInteraction | null }): Message;
  /** Edits a live message by `authorId`: NOT_FOUND when it is gone, BAD_REQUEST when empty, RATE_LIMITED. */
  edit(messageId: number, authorId: string, content: string): Message;
  /** Counts one message by `authorId` that is not stored (an ephemeral answer); false: over the limit. */
  takeMessage(authorId: string): boolean;
}

function cleaned(raw: string): string {
  const text = cleanMessageContent(raw);
  if (text === '') throw new ProtocolError('BAD_REQUEST', 'empty message');
  return text;
}

export function createBotTextApi(need: () => TextCore): BotTextApi {
  const bitsIn = (core: TextCore, userId: string, channelId: string): number => {
    const row = core.repo.channel(channelId);
    return row ? core.access.channelPerms(core.access.subject(userId), row) : 0;
  };

  return {
    member: (userId) => {
      const core = need();
      return core.repo.member(userId, core.isOnline(userId));
    },

    isMember: (userId) => need().repo.isMember(userId),

    textChannel: (userId, channelId) => {
      const core = need();
      const { channel, bits } = core.access.visibleChannel(core.member(userId), channelId);
      if (channel.type !== 'text') throw new ProtocolError('BAD_REQUEST', 'voice channels have no messages');
      return { channelId: channel.id, bits };
    },

    channelBits: (userId, channelId) => bitsIn(need(), userId, channelId),

    channelName: (channelId) => need().repo.channel(channelId)?.name ?? null,

    canSeeChannel: (userId, channelId) => {
      const core = need();
      const row = core.repo.channel(channelId);
      return row !== undefined && row.type === 'text' && core.access.channelPerms(core.access.subject(userId), row) !== 0;
    },

    textChannelsFor: (viewerId, userId) => {
      const core = need();
      const viewer = core.access.subject(viewerId);
      const subject = core.access.subject(userId);
      const out: { channelId: string; bits: number }[] = [];
      for (const row of core.repo.channels()) {
        if (row.type !== 'text') continue;
        const access = core.access.channelAccess(row);
        if (core.access.channelPerms(viewer, row, access) === 0) continue;
        out.push({ channelId: row.id, bits: core.access.channelPerms(subject, row, access) });
      }
      return out;
    },

    broadcastChannel: (channelId, event) => {
      const core = need();
      const row = core.repo.channel(channelId);
      if (row) core.broadcastChannel(row, event);
    },

    broadcastMembers: (event) => need().broadcastAll(event),

    memberCreated: (userId) => {
      const core = need();
      const member = core.repo.member(userId, core.isOnline(userId));
      if (!member) return;
      core.knownMembers.add(userId);
      core.broadcastAll({ t: 'member.joined', d: { member } }, userId);
    },

    setOnline: (userId, online) => {
      const core = need();
      if (online === core.online.has(userId)) return;
      if (online) core.online.add(userId);
      else core.online.delete(userId);
      core.broadcastAll({ t: 'presence', d: { userId, online } }, userId);
    },

    removeMember: (userId, update, closeWith) => {
      const core = need();
      core.db.tx(() => {
        dropMembership(core, userId);
        update();
      });
      finishRemoval(core, userId, 'left', closeWith);
    },

    post: (m) => {
      const core = need();
      const channel = core.repo.channel(m.channelId);
      if (!channel || channel.type !== 'text') throw new ProtocolError('NOT_FOUND');
      const text = cleaned(m.content);
      if (!messageBuckets(core, m.authorId).send.take(m.authorId)) throw new ProtocolError('RATE_LIMITED');
      let replyTo: number | null = null;
      if (m.replyTo != null) {
        const target = core.repo.message(m.replyTo);
        if (target && target.channel_id === channel.id && target.deleted_at === null) replyTo = Number(target.id);
      }
      const bits = core.access.channelPerms(core.access.subject(m.authorId), channel);
      return postMessage(core, { channel, bits, authorId: m.authorId, text, replyTo, interaction: m.interaction ?? null });
    },

    edit: (messageId, authorId, content) => {
      const core = need();
      const row = core.repo.message(messageId);
      if (!row || row.deleted_at !== null || row.user_id !== authorId) throw new ProtocolError('NOT_FOUND');
      const channel = core.repo.channel(row.channel_id);
      if (!channel) throw new ProtocolError('NOT_FOUND');
      const text = cleaned(content);
      if (text !== row.content && !messageBuckets(core, authorId).edit.take(authorId)) throw new ProtocolError('RATE_LIMITED');
      const bits = core.access.channelPerms(core.access.subject(authorId), channel);
      return editMessageText(core, row, channel, bits, text);
    },

    takeMessage: (authorId) => {
      const core = need();
      return messageBuckets(core, authorId).send.take(authorId);
    },
  };
}
