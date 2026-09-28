// State and actions of the text stores (spec §11.2): server, channels, messages and
// members. Each store has a pure slice reducer; stores/text.ts combines them.
import type { Channel, JoinMode, Member, Message, ReadState, Role } from '@ghostlink/shared';
import type { AppErrorCode } from '../../shared/appErrors.js';
import type { TextEvent, TextSnapshot } from '../features/chat/events.js';

export interface ServerState {
  /** The saved-server id the snapshot belongs to; null before the first welcome. */
  serverId: string | null;
  selfId: string;
  name: string;
  joinMode: JoinMode;
  version: string;
  ownerId: string | null;
  maxMembers: number;
  hasPassword: boolean;
  roles: Readonly<Record<string, Role>>;
}

export interface ReadMark {
  lastReadMessageId: number;
  mentionCount: number;
}

export interface ChannelsState {
  byId: Readonly<Record<string, Channel>>;
  reads: Readonly<Record<string, ReadMark>>;
  /** The text channel whose chat is open. */
  activeId: string | null;
  /** The voice channel shown in the center (the Voice track's stage), or null for the chat. */
  stageId: string | null;
  /** The window is focused and the open chat is scrolled to the newest message. */
  attentive: boolean;
}

export interface PendingMessage {
  clientMsgId: string;
  channelId: string;
  content: string;
  replyTo: number | null;
  createdAt: number;
  /** Set when the send failed; the message stays so it can be retried or dropped. */
  error: AppErrorCode | null;
}

export interface ChannelLog {
  /** Oldest first, by id. */
  items: readonly Message[];
  /** More history exists before items[0]. */
  hasMore: boolean;
  status: 'loading' | 'ready' | 'error';
  older: 'idle' | 'loading' | 'error';
  pending: readonly PendingMessage[];
}

export interface MessagesState {
  logs: Readonly<Record<string, ChannelLog>>;
  /** channelId → userId → expiry (ms epoch). */
  typing: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export interface MembersState {
  byId: Readonly<Record<string, Member>>;
}

export interface TextState {
  server: ServerState;
  channels: ChannelsState;
  messages: MessagesState;
  members: MembersState;
}

export type TextAction =
  /** A welcome (first join or reconnect) replaces every store (spec §13). */
  | { type: 'reset'; snapshot: TextSnapshot }
  | { type: 'event'; event: TextEvent; now: number }
  | { type: 'select'; channelId: string }
  | { type: 'stage'; channelId: string | null }
  | { type: 'attention'; attentive: boolean }
  | { type: 'history.start'; channelId: string; older: boolean }
  | { type: 'history.done'; channelId: string; older: boolean; messages: readonly Message[]; hasMore: boolean }
  | { type: 'history.fail'; channelId: string; older: boolean }
  | { type: 'pending.add'; pending: PendingMessage }
  | { type: 'pending.fail'; channelId: string; clientMsgId: string; error: AppErrorCode }
  | { type: 'pending.retry'; channelId: string; clientMsgId: string }
  | { type: 'pending.drop'; channelId: string; clientMsgId: string }
  /** A message returned by msg.send or msg.edit (its event may already have arrived). */
  | { type: 'message.upsert'; message: Message }
  /** A read mark: optimistic (mentionCount 0) or the server's answer to channel.read. */
  | { type: 'read'; readState: ReadState }
  | { type: 'typing.prune'; now: number };

/** True when the message pings `userId`: a direct mention, @everyone, or one of their roles. */
export function mentionsUser(message: Pick<Message, 'mentions'>, userId: string, roleIds: readonly string[]): boolean {
  const { users, roles, everyone } = message.mentions;
  return everyone || users.includes(userId) || roles.some((r) => roleIds.includes(r));
}
