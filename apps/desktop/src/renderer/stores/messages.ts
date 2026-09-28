// The `messages` store (spec §11.2): loaded history per channel, local sends and typing.
import { CHAT_LIMITS, type Message } from '@ghostlink/shared';
import type { ChannelLog, MessagesState, PendingMessage, TextAction, TextState } from './textState.js';

export const initialMessages: MessagesState = { logs: {}, typing: {} };

/** A channel that is not open keeps only its newest messages in memory. */
export const INACTIVE_KEEP = 100;

const EMPTY_LOG: ChannelLog = { items: [], hasMore: false, status: 'loading', older: 'idle', pending: [] };

function logOf(s: MessagesState, channelId: string): ChannelLog | undefined {
  return Object.hasOwn(s.logs, channelId) ? s.logs[channelId] : undefined;
}

function withLog(s: MessagesState, channelId: string, log: ChannelLog): MessagesState {
  return { ...s, logs: { ...s.logs, [channelId]: log } };
}

/** Merges two id-sorted lists; on a duplicate id the entry from `incoming` wins. */
export function mergeById(current: readonly Message[], incoming: readonly Message[]): Message[] {
  const byId = new Map<number, Message>();
  for (const m of current) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** Inserts or replaces one message, keeping the id order (usually an append). */
function upsert(items: readonly Message[], m: Message): Message[] {
  const last = items.at(-1);
  if (!last || last.id < m.id) return [...items, m];
  const index = items.findIndex((x) => x.id >= m.id);
  if (items[index]!.id === m.id) return items.map((x, i) => (i === index ? m : x));
  return [...items.slice(0, index), m, ...items.slice(index)];
}

/** Reply previews quoting `id` follow its edits and deletion. */
function refreshQuotes(items: readonly Message[], id: number, quoted: Message | null): readonly Message[] {
  if (!items.some((m) => m.replyTo?.id === id)) return items;
  return items.map((m) => {
    if (m.replyTo?.id !== id) return m;
    const replyTo = quoted
      ? { ...m.replyTo, content: quoted.content.slice(0, CHAT_LIMITS.replyPreviewLength), deleted: false }
      : { ...m.replyTo, content: '', deleted: true };
    return { ...m, replyTo };
  });
}

function dropTyping(s: MessagesState, channelId: string, userId: string): MessagesState {
  const channel = Object.hasOwn(s.typing, channelId) ? s.typing[channelId]! : undefined;
  if (!channel || !Object.hasOwn(channel, userId)) return s;
  const next = { ...channel };
  delete next[userId];
  return { ...s, typing: { ...s.typing, [channelId]: next } };
}

function onMessage(s: MessagesState, m: Message, selfId: string): MessagesState {
  let next = dropTyping(s, m.channelId, m.authorId);
  const log = logOf(next, m.channelId);
  if (!log) return next; // not loaded: the history request will bring it
  const pending = m.authorId === selfId && m.clientMsgId !== null ? log.pending.filter((p) => p.clientMsgId !== m.clientMsgId) : log.pending;
  next = withLog(next, m.channelId, { ...log, items: upsert(log.items, m), pending });
  return next;
}

function mapPending(s: MessagesState, channelId: string, clientMsgId: string, f: (p: PendingMessage) => PendingMessage | null): MessagesState {
  const log = logOf(s, channelId);
  if (!log || !log.pending.some((p) => p.clientMsgId === clientMsgId)) return s;
  const pending: PendingMessage[] = [];
  for (const p of log.pending) {
    if (p.clientMsgId !== clientMsgId) pending.push(p);
    else {
      const mapped = f(p);
      if (mapped) pending.push(mapped);
    }
  }
  return withLog(s, channelId, { ...log, pending });
}

/** Pure reducer of the messages slice. `root` is the whole state before this action. */
export function messagesSlice(s: MessagesState, a: TextAction, root: TextState): MessagesState {
  switch (a.type) {
    case 'reset':
      // Every open channel reloads its last page after a (re)connect (spec §13).
      return initialMessages;
    case 'select': {
      // The channel we leave keeps only its newest messages.
      const previous = root.channels.activeId;
      const log = previous === null || previous === a.channelId ? undefined : logOf(s, previous);
      if (!log || log.items.length <= INACTIVE_KEEP) return s;
      return withLog(s, previous!, { ...log, items: log.items.slice(-INACTIVE_KEEP), hasMore: true, older: 'idle' });
    }
    case 'history.start': {
      const log = logOf(s, a.channelId);
      if (a.older) return log ? withLog(s, a.channelId, { ...log, older: 'loading' }) : s;
      return withLog(s, a.channelId, { ...EMPTY_LOG, items: log?.items ?? [], pending: log?.pending ?? [] });
    }
    case 'history.done': {
      const log = logOf(s, a.channelId) ?? EMPTY_LOG;
      const items = mergeById(a.messages, log.items); // live events that raced the page win
      if (a.older) return withLog(s, a.channelId, { ...log, items, hasMore: a.hasMore, older: 'idle' });
      return withLog(s, a.channelId, { ...log, items, hasMore: a.hasMore, status: 'ready', older: 'idle' });
    }
    case 'history.fail': {
      const log = logOf(s, a.channelId);
      if (!log) return s;
      return withLog(s, a.channelId, a.older ? { ...log, older: 'error' } : { ...log, status: 'error' });
    }
    case 'pending.add': {
      const log = logOf(s, a.pending.channelId) ?? { ...EMPTY_LOG, status: 'ready' as const };
      return withLog(s, a.pending.channelId, { ...log, pending: [...log.pending, a.pending] });
    }
    case 'pending.fail':
      return mapPending(s, a.channelId, a.clientMsgId, (p) => ({ ...p, error: a.error }));
    case 'pending.retry':
      return mapPending(s, a.channelId, a.clientMsgId, (p) => ({ ...p, error: null }));
    case 'pending.drop':
      return mapPending(s, a.channelId, a.clientMsgId, () => null);
    case 'message.upsert':
      return onMessage(s, a.message, root.server.selfId);
    case 'typing.prune': {
      let changed = false;
      const typing: Record<string, Record<string, number>> = {};
      for (const [channelId, users] of Object.entries(s.typing)) {
        const live = Object.entries(users).filter(([, until]) => until > a.now);
        if (live.length !== Object.keys(users).length) changed = true;
        if (live.length > 0) typing[channelId] = Object.fromEntries(live);
      }
      return changed ? { ...s, typing } : s;
    }
    case 'event':
      break;
    default:
      return s;
  }

  const e = a.event;
  switch (e.t) {
    case 'msg.new':
      return onMessage(s, e.message, root.server.selfId);
    case 'msg.updated': {
      const log = logOf(s, e.message.channelId);
      if (!log) return s;
      const known = log.items.some((m) => m.id === e.message.id);
      const items = refreshQuotes(known ? log.items.map((m) => (m.id === e.message.id ? e.message : m)) : log.items, e.message.id, e.message);
      return items === log.items ? s : withLog(s, e.message.channelId, { ...log, items });
    }
    case 'msg.deleted': {
      const log = logOf(s, e.channelId);
      if (!log) return s;
      const items = refreshQuotes(log.items.filter((m) => m.id !== e.id), e.id, null);
      return withLog(s, e.channelId, { ...log, items });
    }
    case 'msg.reactions': {
      const log = logOf(s, e.channelId);
      if (!log || !log.items.some((m) => m.id === e.id)) return s;
      return withLog(s, e.channelId, { ...log, items: log.items.map((m) => (m.id === e.id ? { ...m, reactions: e.reactions } : m)) });
    }
    case 'typing': {
      if (e.userId === root.server.selfId) return s;
      const channel = Object.hasOwn(s.typing, e.channelId) ? s.typing[e.channelId]! : {};
      return { ...s, typing: { ...s.typing, [e.channelId]: { ...channel, [e.userId]: a.now + CHAT_LIMITS.typingTtlMs } } };
    }
    case 'channel.deleted': {
      if (!Object.hasOwn(s.logs, e.id) && !Object.hasOwn(s.typing, e.id)) return s;
      const logs = { ...s.logs };
      delete logs[e.id];
      const typing = { ...s.typing };
      delete typing[e.id];
      return { logs, typing };
    }
    case 'member.left': {
      // Someone who left stops typing everywhere.
      let next = s;
      for (const channelId of Object.keys(s.typing)) next = dropTyping(next, channelId, e.userId);
      return next;
    }
    default:
      return s;
  }
}

// ---- selectors ----

/** Who is typing in a channel right now (never the current user), oldest first. */
export function typingUserIds(s: MessagesState, channelId: string, now: number): string[] {
  const users = Object.hasOwn(s.typing, channelId) ? s.typing[channelId]! : {};
  return Object.entries(users)
    .filter(([, until]) => until > now)
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => id);
}

export function channelLog(s: MessagesState, channelId: string | null): ChannelLog | undefined {
  return channelId === null ? undefined : logOf(s, channelId);
}
