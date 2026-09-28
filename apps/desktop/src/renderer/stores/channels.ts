// The `channels` store (spec §11.2): visible channels, read marks and which one is open.
import type { Channel, ChannelType, Message } from '@ghostlink/shared';
import { mentionsUser, type ChannelsState, type ReadMark, type TextAction, type TextState } from './textState.js';

export const initialChannels: ChannelsState = { byId: {}, reads: {}, activeId: null, stageId: null, attentive: false };

const NO_READS: ReadMark = { lastReadMessageId: 0, mentionCount: 0 };

/** Channels of one type in sidebar order. */
export function sortedChannels(byId: Readonly<Record<string, Channel>>, type: ChannelType): Channel[] {
  return Object.values(byId)
    .filter((c) => c.type === type)
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

/** The first text channel, where a new member lands (spec: "#geral"). */
export function firstTextChannelId(byId: Readonly<Record<string, Channel>>): string | null {
  return sortedChannels(byId, 'text')[0]?.id ?? null;
}

export function readMark(s: ChannelsState, channelId: string): ReadMark {
  return Object.hasOwn(s.reads, channelId) ? s.reads[channelId]! : NO_READS;
}

/** Unread = the newest message is past the read mark (spec §7). */
export function isUnread(channel: Channel, mark: ReadMark): boolean {
  return channel.type === 'text' && channel.lastMessageId > mark.lastReadMessageId;
}

function has<T>(record: Readonly<Record<string, T>>, key: string | null): key is string {
  return key !== null && Object.hasOwn(record, key);
}

function knownMessage(root: TextState, channelId: string, id: number): Message | undefined {
  const log = Object.hasOwn(root.messages.logs, channelId) ? root.messages.logs[channelId] : undefined;
  return log?.items.find((m) => m.id === id);
}

function myRoleIds(root: TextState): readonly string[] {
  const me = root.server.selfId;
  return Object.hasOwn(root.members.byId, me) ? root.members.byId[me]!.roleIds : [];
}

/** Would this message count as an unread mention for the current user? */
function countsAsMention(root: TextState, s: ChannelsState, m: Message): boolean {
  const me = root.server.selfId;
  return m.authorId !== me && m.id > readMark(s, m.channelId).lastReadMessageId && mentionsUser(m, me, myRoleIds(root));
}

function withMentionDelta(s: ChannelsState, channelId: string, delta: number): ChannelsState {
  if (delta === 0) return s;
  const mark = readMark(s, channelId);
  return { ...s, reads: { ...s.reads, [channelId]: { ...mark, mentionCount: Math.max(0, mark.mentionCount + delta) } } };
}

/**
 * Pure reducer of the channels slice. `root` is the whole state before this
 * action (the current user, their roles and the loaded messages).
 */
export function channelsSlice(s: ChannelsState, a: TextAction, root: TextState): ChannelsState {
  switch (a.type) {
    case 'reset': {
      const { snapshot } = a;
      const byId = Object.fromEntries(snapshot.text.channels.map((c) => [c.id, c]));
      const reads: Record<string, ReadMark> = {};
      for (const r of snapshot.text.readStates) {
        if (Object.hasOwn(byId, r.channelId)) reads[r.channelId] = { lastReadMessageId: r.lastReadMessageId, mentionCount: r.mentionCount };
      }
      // A reconnect to the same server keeps the open channel when it is still visible.
      const sameServer = root.server.serverId === snapshot.serverId;
      const keepActive = sameServer && has(byId, s.activeId) && byId[s.activeId]!.type === 'text';
      const keepStage = sameServer && has(byId, s.stageId) && byId[s.stageId]!.type === 'voice';
      return {
        byId,
        reads,
        activeId: keepActive ? s.activeId : firstTextChannelId(byId),
        stageId: keepStage ? s.stageId : null,
        attentive: s.attentive,
      };
    }
    case 'select':
      if (!has(s.byId, a.channelId) || s.byId[a.channelId]!.type !== 'text') return s;
      return { ...s, activeId: a.channelId, stageId: null };
    case 'stage':
      if (a.channelId === null) return s.stageId === null ? s : { ...s, stageId: null };
      if (!has(s.byId, a.channelId) || s.byId[a.channelId]!.type !== 'voice') return s;
      return { ...s, stageId: a.channelId };
    case 'attention':
      return s.attentive === a.attentive ? s : { ...s, attentive: a.attentive };
    case 'read': {
      const r = a.readState;
      if (!has(s.byId, r.channelId)) return s;
      const mark = readMark(s, r.channelId);
      const next: ReadMark = { lastReadMessageId: Math.max(mark.lastReadMessageId, r.lastReadMessageId), mentionCount: r.mentionCount };
      if (next.lastReadMessageId === mark.lastReadMessageId && next.mentionCount === mark.mentionCount) return s;
      return { ...s, reads: { ...s.reads, [r.channelId]: next } };
    }
    case 'message.upsert':
      return onMessage(s, a.message, root);
    case 'event':
      break;
    default:
      return s;
  }

  const e = a.event;
  switch (e.t) {
    case 'channel.created': {
      const { channel } = e;
      const mark = e.readState
        ? { lastReadMessageId: e.readState.lastReadMessageId, mentionCount: e.readState.mentionCount }
        : { lastReadMessageId: channel.lastMessageId, mentionCount: 0 };
      const byId = { ...s.byId, [channel.id]: channel };
      const activeId = s.activeId ?? (channel.type === 'text' ? channel.id : null);
      return { ...s, byId, reads: { ...s.reads, [channel.id]: mark }, activeId };
    }
    case 'channel.updated': {
      // An update never reveals a channel: visibility changes arrive as channel.created (spec §5.3).
      if (!has(s.byId, e.channel.id)) return s;
      return { ...s, byId: { ...s.byId, [e.channel.id]: e.channel } };
    }
    case 'channel.deleted': {
      if (!has(s.byId, e.id)) return s;
      const byId = { ...s.byId };
      delete byId[e.id];
      const reads = { ...s.reads };
      delete reads[e.id];
      return {
        ...s,
        byId,
        reads,
        activeId: s.activeId === e.id ? firstTextChannelId(byId) : s.activeId,
        stageId: s.stageId === e.id ? null : s.stageId,
      };
    }
    case 'msg.new':
      return onMessage(s, e.message, root);
    case 'msg.updated': {
      // An edit can add or remove a mention of an unread message.
      const before = knownMessage(root, e.message.channelId, e.message.id);
      if (!before) return s;
      const delta = Number(countsAsMention(root, s, e.message)) - Number(countsAsMention(root, s, before));
      return withMentionDelta(s, e.message.channelId, delta);
    }
    case 'msg.deleted': {
      const before = knownMessage(root, e.channelId, e.id);
      return before && countsAsMention(root, s, before) ? withMentionDelta(s, e.channelId, -1) : s;
    }
    default:
      return s;
  }
}

/** A new (or returned) message moves lastMessageId, and the read mark or the mention count. */
function onMessage(s: ChannelsState, m: Message, root: TextState): ChannelsState {
  if (!has(s.byId, m.channelId)) return s;
  const channel = s.byId[m.channelId]!;
  const isNew = m.id > channel.lastMessageId;
  const byId = isNew ? { ...s.byId, [m.channelId]: { ...channel, lastMessageId: m.id } } : s.byId;
  const mark = readMark(s, m.channelId);
  const mine = m.authorId === root.server.selfId;
  const watching = s.activeId === m.channelId && s.stageId === null && s.attentive;
  let next = mark;
  if (mine || watching) {
    // Your own message is read by definition (the server agrees); one on screen is read now.
    if (m.id > mark.lastReadMessageId) next = { ...mark, lastReadMessageId: m.id };
  } else if (isNew && countsAsMention(root, s, m)) {
    next = { ...mark, mentionCount: mark.mentionCount + 1 };
  }
  if (byId === s.byId && next === mark) return s;
  return { ...s, byId, reads: next === mark ? s.reads : { ...s.reads, [m.channelId]: next } };
}
