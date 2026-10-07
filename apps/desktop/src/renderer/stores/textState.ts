// State and actions of the text stores (spec §11.2): server, channels, messages and
// members. Each store has a pure slice reducer; stores/text.ts combines them.
import type { AttachmentKind, BotCommand, Channel, JoinMode, Member, Message, ReadState, Role } from '@ghostlink/shared';
import type { AppErrorCode } from '../../shared/appErrors.js';
import type { TextEvent, TextSnapshot } from '../features/chat/events.js';

export interface ServerState {
  /** The saved-server id the snapshot belongs to; null before the first welcome. */
  serverId: string | null;
  selfId: string;
  name: string;
  /** The server icon's hash, or null: initials (spec 2026-10-01-icone-do-servidor). */
  icon: string | null;
  joinMode: JoinMode;
  version: string;
  ownerId: string | null;
  maxMembers: number;
  hasPassword: boolean;
  /** Attachments (anexos §2): the largest file, and all files together, in MB. */
  uploadLimitMb: number;
  storageQuotaMb: number;
  roles: Readonly<Record<string, Role>>;
}

export interface ReadMark {
  lastReadMessageId: number;
  mentionCount: number;
  /** Unread messages from others since lastReadMessageId (the sidebar's count badge). */
  unreadCount: number;
}

export interface ChannelsState {
  byId: Readonly<Record<string, Channel>>;
  reads: Readonly<Record<string, ReadMark>>;
  /** The text channel whose chat is open. */
  activeId: string | null;
  /** The voice channel shown in the center (the Voice track's stage), or null for the chat. */
  stageId: string | null;
  /** The bot whose page is shown in the center (bot page spec), selected like a channel; null for the chat. */
  botPageId: string | null;
  /** The window is focused and the open chat is scrolled to the newest message. */
  attentive: boolean;
}

/** A file of a message still being sent (anexos §1): uploaded first, then named in msg.send. */
export interface PendingFile {
  /** Local id (the progress bar's key). */
  id: string;
  name: string;
  size: number;
  /** The tray's guess; the server decides from the bytes. */
  kind: AttachmentKind;
  /** Kept so a retry can send it again. */
  file: Blob;
  /** The server's id once uploaded; a retry skips it. */
  fileId: string | null;
  /** 0 to 1 while uploading. */
  progress: number;
}

export interface PendingMessage {
  clientMsgId: string;
  channelId: string;
  content: string;
  replyTo: number | null;
  createdAt: number;
  /** Set when the send failed; the message stays so it can be retried or dropped. */
  error: AppErrorCode | null;
  /** Its files, uploaded before the message goes (none: text only). */
  files?: readonly PendingFile[];
}

export interface ChannelLog {
  /** Oldest first, by id. */
  items: readonly Message[];
  /** More history exists before items[0]. */
  hasMore: boolean;
  /** 'stale': kept only for the unsent messages after a reconnect; the history must be loaded again. */
  status: 'loading' | 'ready' | 'error' | 'stale';
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

/**
 * A line about an interaction that only this app shows (bots spec §3), placed right after the
 * channel's message `afterId`: the bot "pensando…" (a defer), an answer only I see, or "O bot não
 * respondeu".
 */
export type BotLocal =
  | { kind: 'thinking'; id: string; channelId: string; botId: string; userId: string; command: string; ephemeral: boolean; afterId: number }
  | {
      kind: 'ephemeral';
      /** The answer's own id: the interaction's for the answer itself, a new one per follow-up. */
      id: string;
      interactionId: string;
      channelId: string;
      botId: string;
      userId: string;
      command: string;
      content: string;
      createdAt: number;
      editedAt: number | null;
      afterId: number;
    }
  | { kind: 'failed'; id: string; channelId: string; botId: string; userId: string; command: string; afterId: number };

/**
 * What everyone sees of a bot besides its member (bot page spec): the welcome's `botProfiles`,
 * then `bot.updated`; a bot created meanwhile starts with what its member.joined tells.
 */
export interface BotProfileView {
  description: string;
  /** null: not known (a bot created after the welcome, or its creator was not kept). */
  createdBy: string | null;
  /** null: not known (a description that arrived for a bot this app never saw join). */
  createdAt: number | null;
  /** When it last connected or left (the server's clock, then this app's at each presence change); null: never. */
  lastSeenAt: number | null;
  /** The server's own bot (the Ghost DJ): no connection code, cannot be deleted. False before 0.5.0. */
  system: boolean;
}

export interface BotsState {
  /** botId → its slash commands. */
  commands: Readonly<Record<string, readonly BotCommand[]>>;
  /** channelId → its interaction lines, oldest first. */
  locals: Readonly<Record<string, readonly BotLocal[]>>;
  /** botId → its profile; null on a server without the bot's settings (before 0.4.2). */
  profiles: Readonly<Record<string, BotProfileView>> | null;
}

export interface TextState {
  server: ServerState;
  channels: ChannelsState;
  messages: MessagesState;
  members: MembersState;
  bots: BotsState;
}

export type TextAction =
  /** A welcome (first join or reconnect) replaces every store (spec §13). */
  | { type: 'reset'; snapshot: TextSnapshot }
  | { type: 'event'; event: TextEvent; now: number }
  | { type: 'select'; channelId: string }
  | { type: 'stage'; channelId: string | null }
  /** Opens a bot's page in the center, like a channel (a channel, or the stage, closes it). */
  | { type: 'bot.open'; botId: string }
  | { type: 'attention'; attentive: boolean }
  | { type: 'history.start'; channelId: string; older: boolean }
  /** `before`: the oldest loaded message the older page was asked for; a page for a trimmed log is dropped. */
  | { type: 'history.done'; channelId: string; older: boolean; messages: readonly Message[]; hasMore: boolean; before?: number }
  | { type: 'history.fail'; channelId: string; older: boolean }
  | { type: 'pending.add'; pending: PendingMessage }
  | { type: 'pending.fail'; channelId: string; clientMsgId: string; error: AppErrorCode }
  /** `resetFiles`: the server no longer takes the uploaded ids (BAD_ATTACHMENT), so every file goes again. */
  | { type: 'pending.retry'; channelId: string; clientMsgId: string; resetFiles?: boolean }
  /** An upload moved on (`progress` 0–1), or finished with the server's `fileId`. */
  | { type: 'pending.file'; channelId: string; clientMsgId: string; fileLocalId: string; progress: number; fileId?: string }
  | { type: 'pending.drop'; channelId: string; clientMsgId: string }
  /** A message returned by msg.send or msg.edit (its event may already have arrived). */
  | { type: 'message.upsert'; message: Message }
  /** A read mark: optimistic (mentionCount 0) or the server's answer to channel.read. */
  | { type: 'read'; readState: ReadState }
  | { type: 'typing.prune'; now: number }
  /** "Dispensar" on an answer only I see, or on "O bot não respondeu". */
  | { type: 'bots.dismiss'; channelId: string; kind: BotLocal['kind']; id: string };

/** True when the message pings `userId`: a direct mention, @everyone, or one of their roles. */
export function mentionsUser(message: Pick<Message, 'mentions'>, userId: string, roleIds: readonly string[]): boolean {
  const { users, roles, everyone } = message.mentions;
  return everyone || users.includes(userId) || roles.some((r) => roleIds.includes(r));
}
