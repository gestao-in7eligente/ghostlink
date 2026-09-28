// Requests to the connected server (the generic `server.request` IPC) and their
// effect on the text stores. Answers are untrusted: they go through the lenient
// client schemas (spec §5.1), and a malformed answer is reported as INTERNAL.
import { z } from 'zod';
import {
  CHAT_LIMITS,
  banEntrySchemaClient,
  channelSchemaClient,
  inviteEntrySchemaClient,
  inviteLinksSchemaClient,
  memberSchemaClient,
  messageSchemaClient,
  reactionSchemaClient,
  readStateSchemaClient,
  roleSchemaClient,
  serverInfoSchemaClient,
  type BanEntry,
  type Channel,
  type InviteEntry,
  type InviteLinks,
  type JoinMode,
  type Member,
  type Message,
  type Reaction,
  type ReadState,
  type Role,
  type ServerInfo,
} from '@ghostlink/shared';
import type { GhostlinkApi } from '../../../shared/ipcTypes.js';
import { errorCodeOf } from '../../i18n/index.js';
import { channelLog } from '../../stores/messages.js';
import { dispatchText, textState } from '../../stores/text.js';

/** The preload API (typed without the DOM lib, so node-side tests can load this module). */
function ghostlink(): GhostlinkApi {
  return (globalThis as unknown as { window: { ghostlink: GhostlinkApi } }).window.ghostlink;
}

/** Sends a request and validates the answer; rejects with Error(code) like every window.ghostlink call. */
export async function request<T>(type: string, payload: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  // Optional fields left undefined are omitted (the server's strict schemas see only real keys).
  const defined = Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined));
  const raw = await ghostlink().server.request(type, defined);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error('INTERNAL');
  return parsed.data;
}

const empty = z.object({});

// ---- history ----

const historySchema = z.object({ messages: z.array(messageSchemaClient).max(CHAT_LIMITS.historyPageMax), hasMore: z.boolean() });

/**
 * Loads the newest page of a channel, or (older) the page before the oldest loaded
 * message. The log's own status prevents duplicate requests.
 */
export async function loadHistory(channelId: string, older = false): Promise<void> {
  const log = channelLog(textState().messages, channelId);
  if (older) {
    if (!log || log.status !== 'ready' || !log.hasMore || log.items.length === 0 || log.older === 'loading') return;
  } else if (log?.status === 'loading') {
    return;
  }
  const serverId = textState().server.serverId;
  const before = older ? log!.items[0]!.id : undefined;
  dispatchText({ type: 'history.start', channelId, older });
  // After another server's welcome, or once the channel is gone, a late answer is dropped.
  const current = () => textState().server.serverId === serverId && channelLog(textState().messages, channelId) !== undefined;
  try {
    const page = await request('msg.history', { channelId, limit: CHAT_LIMITS.historyPageMax, ...(before ? { before } : {}) }, historySchema);
    if (!current()) return;
    dispatchText({ type: 'history.done', channelId, older, before, messages: page.messages.filter((m) => m.channelId === channelId), hasMore: page.hasMore });
  } catch {
    if (current()) dispatchText({ type: 'history.fail', channelId, older });
  }
}

// ---- messages ----

const messageAnswer = z.object({ message: messageSchemaClient });

function newClientMsgId(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

async function deliver(channelId: string, clientMsgId: string, content: string, replyTo: number | null): Promise<void> {
  try {
    const { message } = await request(
      'msg.send',
      { channelId, content, clientMsgId, ...(replyTo !== null ? { replyTo } : {}) },
      messageAnswer,
    );
    dispatchText({ type: 'message.upsert', message });
  } catch (e) {
    dispatchText({ type: 'pending.fail', channelId, clientMsgId, error: errorCodeOf(e) });
  }
}

/** Shows the message at once (pending), then sends it; a failure keeps it for a retry. */
export function sendMessage(channelId: string, content: string, replyTo: number | null): Promise<void> {
  const clientMsgId = newClientMsgId();
  dispatchText({ type: 'pending.add', pending: { clientMsgId, channelId, content, replyTo, createdAt: Date.now(), error: null } });
  return deliver(channelId, clientMsgId, content, replyTo);
}

/** Sends a failed message again with the same clientMsgId, so the server never stores it twice. */
export function retryMessage(channelId: string, clientMsgId: string): Promise<void> {
  const pending = channelLog(textState().messages, channelId)?.pending.find((p) => p.clientMsgId === clientMsgId);
  if (!pending) return Promise.resolve();
  dispatchText({ type: 'pending.retry', channelId, clientMsgId });
  return deliver(channelId, clientMsgId, pending.content, pending.replyTo);
}

export function dropMessage(channelId: string, clientMsgId: string): void {
  dispatchText({ type: 'pending.drop', channelId, clientMsgId });
}

export async function editMessage(id: number, content: string): Promise<Message> {
  const { message } = await request('msg.edit', { id, content }, messageAnswer);
  dispatchText({ type: 'message.upsert', message });
  return message;
}

export async function deleteMessage(id: number): Promise<void> {
  await request('msg.delete', { id }, empty);
}

const reactionsAnswer = z.object({ reactions: z.array(reactionSchemaClient).max(100) });

/** Adds or removes the user's reaction; msg.reactions updates everyone's view. */
export async function toggleReaction(message: Pick<Message, 'id' | 'reactions'>, emoji: string): Promise<Reaction[]> {
  const self = textState().server.selfId;
  const mine = message.reactions.some((r) => r.emoji === emoji && r.userIds.includes(self));
  const { reactions } = await request(mine ? 'msg.unreact' : 'msg.react', { id: message.id, emoji }, reactionsAnswer);
  return reactions;
}

// ---- read marks and typing ----

const readAnswer = z.object({ readState: readStateSchemaClient });

/** Marks a channel read up to `messageId`: at once locally, then with the server's answer. */
export async function markRead(channelId: string, messageId: number): Promise<void> {
  dispatchText({ type: 'read', readState: { channelId, lastReadMessageId: messageId, mentionCount: 0 } });
  try {
    const { readState } = await request('channel.read', { channelId, messageId }, readAnswer);
    dispatchText({ type: 'read', readState: readState satisfies ReadState });
  } catch {
    // The next welcome brings the server's read state back.
  }
}

let lastTyping = { channelId: '', at: 0 };

/** "Digitando…" at most once every 3 s per channel (spec §13). */
export function sendTyping(channelId: string, now = Date.now()): void {
  if (lastTyping.channelId === channelId && now - lastTyping.at < CHAT_LIMITS.typingIntervalMs) return;
  lastTyping = { channelId, at: now };
  ghostlink().server.request('typing', { channelId }).catch(() => undefined);
}

/** Stops the throttle after a message is sent, so the next keystroke announces typing again. */
export function resetTyping(): void {
  lastTyping = { channelId: '', at: 0 };
}

// ---- channels ----

const channelAnswer = z.object({ channel: channelSchemaClient });

export interface ChannelDraft {
  name: string;
  type: 'text' | 'voice';
  topic?: string;
  private?: boolean;
  allowedRoleIds?: string[];
  userLimit?: number;
}

export async function createChannel(draft: ChannelDraft): Promise<Channel> {
  const { channel } = await request('channel.create', { ...draft }, channelAnswer);
  return channel;
}

export async function updateChannel(id: string, patch: Omit<ChannelDraft, 'name' | 'type'> & { name?: string }): Promise<Channel> {
  const { channel } = await request('channel.update', { id, ...patch }, channelAnswer);
  return channel;
}

export async function deleteChannel(id: string): Promise<void> {
  await request('channel.delete', { id }, empty);
}

/** `ids`: every channel the user can see, in the new order. */
export async function reorderChannels(ids: string[]): Promise<void> {
  await request('channel.reorder', { ids }, empty);
}

// ---- roles and members ----

const roleAnswer = z.object({ role: roleSchemaClient });
const memberAnswer = z.object({ member: memberSchemaClient });

export interface RoleDraft {
  name?: string;
  color?: number;
  permissions?: number;
  hoist?: boolean;
  mentionable?: boolean;
}

export async function createRole(draft: RoleDraft & { name: string }): Promise<Role> {
  return (await request('role.create', { ...draft }, roleAnswer)).role;
}

export async function updateRole(id: string, patch: RoleDraft): Promise<Role> {
  return (await request('role.update', { id, ...patch }, roleAnswer)).role;
}

export async function deleteRole(id: string): Promise<void> {
  await request('role.delete', { id }, empty);
}

/** `ids`: the roles below the user's top role, strongest first. */
export async function reorderRoles(ids: string[]): Promise<void> {
  await request('role.reorder', { ids }, empty);
}

export async function setMemberRoles(userId: string, roleIds: string[]): Promise<Member> {
  return (await request('member.setRoles', { userId, roleIds }, memberAnswer)).member;
}

export async function kickMember(userId: string): Promise<void> {
  await request('member.kick', { userId }, empty);
}

export async function banMember(userId: string, reason: string, banIp: boolean): Promise<void> {
  const trimmed = reason.trim();
  await request('member.ban', { userId, banIp, ...(trimmed ? { reason: trimmed } : {}) }, empty);
}

export async function unbanMember(userId: string): Promise<void> {
  await request('member.unban', { userId }, empty);
}

export async function listBans(): Promise<BanEntry[]> {
  return (await request('bans.list', {}, z.object({ bans: z.array(banEntrySchemaClient).max(100_000) }))).bans;
}

export async function updateProfile(nickname: string): Promise<Member> {
  return (await request('profile.update', { nickname }, memberAnswer)).member;
}

// ---- invites and the server ----

export async function createInvite(opts: { maxUses?: number; expiresInHours?: number }): Promise<InviteLinks> {
  return request('invite.create', { ...opts }, inviteLinksSchemaClient);
}

export async function listInvites(): Promise<InviteEntry[]> {
  return (await request('invite.list', {}, z.object({ invites: z.array(inviteEntrySchemaClient).max(1000) }))).invites;
}

export async function revokeInvite(code: string): Promise<void> {
  await request('invite.revoke', { code }, empty);
}

export interface ServerPatch {
  name?: string;
  joinMode?: JoinMode;
  password?: string | null;
  maxMembers?: number;
}

export async function updateServer(patch: ServerPatch): Promise<ServerInfo> {
  return request('server.update', { ...patch }, serverInfoSchemaClient);
}

export async function transferOwnership(userId: string): Promise<void> {
  await request('server.transferOwnership', { userId }, empty);
}

export async function leaveServer(deleteMyMessages: boolean): Promise<void> {
  await request('server.leave', { deleteMyMessages }, empty);
}
