/**
 * Text protocol (spec §5.2, §5.3, §7): channels, messages, reactions, read
 * states, typing, profile, invites and server administration.
 *
 * Server-side schemas are strict (unknown keys → BAD_REQUEST). Client-side
 * schemas (`*SchemaClient`) are lenient: they drop unknown keys, and callers
 * ignore payloads that fail to parse (spec §5.1).
 */
import { z } from 'zod';
import { roleSchemaClient, type Role } from './roles.js';

export const CHAT_LIMITS = {
  messageMaxLength: 4000,
  historyPageMax: 50,
  channelNameMax: 100,
  topicMax: 1024,
  maxReactionsPerMessage: 20,
  maxAttachments: 10,
  clientMsgIdMax: 64,
  maxMentionsPerMessage: 50,
  maxAllowedRoles: 100,
  userLimitMax: 99,
  replyPreviewLength: 200,
  /** Messages by the same author closer than this are grouped (spec §11.1). */
  groupWindowMs: 5 * 60_000,
  /** A client sends `typing` at most this often (spec §13: 1 every 3 s). */
  typingIntervalMs: 3_000,
  /** How long a "typing" indicator lasts without a refresh. */
  typingTtlMs: 8_000,
  maxMembersLimit: 10_000,
  serverNameMax: 64,
  passwordMax: 256,
  banReasonMax: 512,
} as const;

/** The canonical `@everyone` token (shown as "@todos" in pt-BR). */
export const EVERYONE_MENTION = '@everyone';

// ---- identifiers ----

/** Channel, role and file ids: 128 random bits in base32 (spec §5.3). */
export const entityIdSchema = z.string().regex(/^[A-Z2-7]{26}$/);
/** userId = 128 bits in hex (spec §3.2). */
export const userIdSchema = z.string().regex(/^[0-9a-f]{32}$/);
/** Message ids are global, increasing integers. */
export const messageIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

// ---- model ----

export type ChannelType = 'text' | 'voice';

export interface Channel {
  id: string;
  name: string;
  type: ChannelType;
  topic: string;
  position: number;
  private: boolean;
  allowedRoleIds: string[];
  /** Voice only; 0 = no limit. */
  userLimit: number;
  /** 0 when the channel has no message yet. */
  lastMessageId: number;
}

export interface Reaction {
  emoji: string;
  userIds: string[];
}

/** Mentions that took effect when the message was sent or edited. */
export interface MessageMentions {
  users: string[];
  roles: string[];
  everyone: boolean;
}

export interface ReplyPreview {
  id: number;
  authorId: string | null;
  content: string;
  deleted: boolean;
}

export interface Message {
  id: number;
  channelId: string;
  authorId: string;
  content: string;
  createdAt: number;
  editedAt: number | null;
  replyTo: ReplyPreview | null;
  reactions: Reaction[];
  mentions: MessageMentions;
  clientMsgId: string | null;
}

export interface ReadState {
  channelId: string;
  lastReadMessageId: number;
  mentionCount: number;
}

export interface Member {
  userId: string;
  nickname: string;
  roleIds: string[];
  online: boolean;
  joinedAt: number;
}

export interface ServerSettings {
  ownerId: string | null;
  maxMembers: number;
  hasPassword: boolean;
}

/** Welcome keys added by the text module (spec §5.3). */
export interface TextWelcome {
  channels: Channel[];
  roles: Role[];
  members: Member[];
  readStates: ReadState[];
  serverSettings: ServerSettings;
}

export interface BanEntry {
  userId: string;
  nickname: string;
  reason: string | null;
  bannedBy: string | null;
  createdAt: number;
}

export interface InviteEntry {
  code: string;
  createdBy: string | null;
  createdAt: number;
  expiresAt: number | null;
  maxUses: number | null;
  uses: number;
  webLink: string;
}

export type MemberLeftReason = 'left' | 'kicked' | 'banned';

// ---- content helpers (pure, linear time) ----

const EMOJI = new RegExp('^\\p{RGI_Emoji}$', 'v');
const MAX_EMOJI_LENGTH = 32;

/** A single RGI emoji (spec §5.2). */
export function isReactionEmoji(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0 && x.length <= MAX_EMOJI_LENGTH && EMOJI.test(x);
}

/**
 * Replaces ``` fenced blocks and `inline` code with a space, so mentions inside
 * code do not ping anyone. Unclosed markers are plain text. One linear scan.
 */
export function stripCode(content: string): string {
  let out = '';
  let i = 0;
  while (i < content.length) {
    if (content.startsWith('```', i)) {
      const end = content.indexOf('```', i + 3);
      if (end < 0) return out + content.slice(i);
      out += ' ';
      i = end + 3;
    } else if (content[i] === '`') {
      const end = content.indexOf('`', i + 1);
      if (end < 0) return out + content.slice(i);
      out += ' ';
      i = end + 1;
    } else {
      const next = content.indexOf('`', i);
      const stop = next < 0 ? content.length : next;
      out += content.slice(i, stop);
      i = stop;
    }
  }
  return out;
}

const USER_MENTION = /<@([0-9a-f]{32})>/g;
const ROLE_MENTION = /<@&([A-Z2-7]{26})>/g;
const EVERYONE = /(?<![\w@.])@everyone(?!\w)/;

/** Mention tokens outside code: `<@userId>`, `<@&roleId>` and `@everyone`. */
export function extractMentions(content: string): MessageMentions {
  const text = stripCode(content);
  const collect = (re: RegExp) => {
    const ids = new Set<string>();
    for (const m of text.matchAll(re)) {
      if (ids.size >= CHAT_LIMITS.maxMentionsPerMessage) break;
      ids.add(m[1]!);
    }
    return [...ids];
  };
  return { users: collect(USER_MENTION), roles: collect(ROLE_MENTION), everyone: EVERYONE.test(text) };
}

// Control characters (C0, DEL, C1) except \t and \n, and lone surrogates.
const CONTENT_JUNK = /[^\P{Cc}\t\n]|\p{Cs}/gu;

/** Server-side cleanup of message text: \r\n → \n, no control characters, trimmed. */
export function cleanMessageContent(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').replace(CONTENT_JUNK, '').trim();
}

// ---- server-side request schemas (strict) ----

const channelName = z.string().min(1).max(CHAT_LIMITS.channelNameMax);
const topic = z.string().max(CHAT_LIMITS.topicMax);
const allowedRoleIds = z.array(entityIdSchema).max(CHAT_LIMITS.maxAllowedRoles);
const userLimit = z.number().int().min(0).max(CHAT_LIMITS.userLimitMax);
const content = z.string().max(CHAT_LIMITS.messageMaxLength);

export const channelCreateSchema = z.strictObject({
  name: channelName,
  type: z.enum(['text', 'voice']),
  topic: topic.optional(),
  private: z.boolean().optional(),
  allowedRoleIds: allowedRoleIds.optional(),
  userLimit: userLimit.optional(),
});

export const channelUpdateSchema = z.strictObject({
  id: entityIdSchema,
  name: channelName.optional(),
  topic: topic.optional(),
  private: z.boolean().optional(),
  allowedRoleIds: allowedRoleIds.optional(),
  userLimit: userLimit.optional(),
});

export const channelDeleteSchema = z.strictObject({ id: entityIdSchema });
export const channelReorderSchema = z.strictObject({ ids: z.array(entityIdSchema).min(1).max(500) });

export const msgHistorySchema = z.strictObject({
  channelId: entityIdSchema,
  before: messageIdSchema.optional(),
  limit: z.number().int().min(1).max(CHAT_LIMITS.historyPageMax).optional(),
});

export const msgSendSchema = z.strictObject({
  channelId: entityIdSchema,
  content,
  clientMsgId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  replyTo: messageIdSchema.optional(),
  attachmentIds: z.array(z.string().max(64)).max(CHAT_LIMITS.maxAttachments).optional(),
});

export const msgEditSchema = z.strictObject({ id: messageIdSchema, content });
export const msgDeleteSchema = z.strictObject({ id: messageIdSchema });
export const msgReactSchema = z.strictObject({ id: messageIdSchema, emoji: z.string().refine(isReactionEmoji) });
export const channelReadSchema = z.strictObject({ channelId: entityIdSchema, messageId: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) });
export const typingSchema = z.strictObject({ channelId: entityIdSchema });
/** v0.1: nickname only (avatars arrive in v0.2). */
export const profileUpdateSchema = z.strictObject({ nickname: z.string().min(1).max(64) });

export const inviteCreateSchema = z.strictObject({
  maxUses: z.number().int().min(1).max(10_000).optional(),
  expiresInHours: z.number().positive().max(24 * 365).optional(),
});
export const inviteListSchema = z.strictObject({});
export const inviteRevokeSchema = z.strictObject({ code: z.string().regex(/^[A-Z2-7]{10}$/) });

/** v0.1: no icon, upload limit or quota (files arrive in v0.2). */
export const serverUpdateSchema = z.strictObject({
  name: z.string().min(1).max(256).optional(),
  joinMode: z.enum(['open', 'password', 'invite']).optional(),
  password: z.string().min(1).max(CHAT_LIMITS.passwordMax).nullable().optional(),
  maxMembers: z.number().int().min(1).max(CHAT_LIMITS.maxMembersLimit).optional(),
});
export const serverTransferSchema = z.strictObject({ userId: userIdSchema });
export const serverLeaveSchema = z.strictObject({ deleteMyMessages: z.boolean().optional() });

// ---- client-side schemas (lenient) ----

const idClient = z.string().min(1).max(64);

export const channelSchemaClient: z.ZodType<Channel> = z.object({
  id: idClient,
  name: z.string().max(256),
  type: z.enum(['text', 'voice']),
  topic: z.string().max(4096).catch(''),
  position: z.number().int(),
  private: z.boolean(),
  allowedRoleIds: z.array(idClient).max(1000).catch([]),
  userLimit: z.number().int().min(0).catch(0),
  lastMessageId: z.number().int().min(0).catch(0),
});

const reactionSchemaClient: z.ZodType<Reaction> = z.object({
  emoji: z.string().max(64),
  userIds: z.array(idClient).max(100_000),
});

const mentionsSchemaClient: z.ZodType<MessageMentions> = z.object({
  users: z.array(idClient).max(1000),
  roles: z.array(idClient).max(1000),
  everyone: z.boolean(),
});

export const messageSchemaClient: z.ZodType<Message> = z.object({
  id: z.number().int().positive(),
  channelId: idClient,
  authorId: idClient,
  content: z.string().max(CHAT_LIMITS.messageMaxLength * 2),
  createdAt: z.number(),
  editedAt: z.number().nullable(),
  replyTo: z
    .object({ id: z.number().int(), authorId: idClient.nullable(), content: z.string().max(1000), deleted: z.boolean() })
    .nullable()
    .catch(null),
  reactions: z.array(reactionSchemaClient).max(100).catch([]),
  mentions: mentionsSchemaClient.catch({ users: [], roles: [], everyone: false }),
  clientMsgId: z.string().max(64).nullable().catch(null),
});

export const readStateSchemaClient: z.ZodType<ReadState> = z.object({
  channelId: idClient,
  lastReadMessageId: z.number().int().min(0),
  mentionCount: z.number().int().min(0),
});

export const memberSchemaClient: z.ZodType<Member> = z.object({
  userId: idClient,
  nickname: z.string().max(256),
  roleIds: z.array(idClient).max(1000).catch([]),
  online: z.boolean().catch(false),
  joinedAt: z.number().catch(0),
});

export const serverSettingsSchemaClient: z.ZodType<ServerSettings> = z.object({
  ownerId: idClient.nullable(),
  maxMembers: z.number().int().min(0),
  hasPassword: z.boolean(),
});

const DEFAULT_SETTINGS: ServerSettings = { ownerId: null, maxMembers: 0, hasPassword: false };

export const textWelcomeSchemaClient: z.ZodType<TextWelcome> = z.object({
  channels: z.array(channelSchemaClient).max(5000).catch([]),
  roles: z.array(roleSchemaClient).max(1000).catch([]),
  members: z.array(memberSchemaClient).max(100_000).catch([]),
  readStates: z.array(readStateSchemaClient).max(5000).catch([]),
  serverSettings: serverSettingsSchemaClient.catch(DEFAULT_SETTINGS),
});

export const banEntrySchemaClient: z.ZodType<BanEntry> = z.object({
  userId: idClient,
  nickname: z.string().max(256),
  reason: z.string().max(2048).nullable(),
  bannedBy: idClient.nullable(),
  createdAt: z.number(),
});

export const inviteEntrySchemaClient: z.ZodType<InviteEntry> = z.object({
  code: z.string().max(64),
  createdBy: idClient.nullable(),
  createdAt: z.number(),
  expiresAt: z.number().nullable(),
  maxUses: z.number().int().nullable(),
  uses: z.number().int(),
  webLink: z.string().max(4096),
});
