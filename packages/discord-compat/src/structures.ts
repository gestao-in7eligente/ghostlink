/**
 * The discord.js structures a bot touches when it reads and sends messages (bots spec §4):
 * User, ClientUser, Guild (the GhostLink server), TextChannel with its MessageManager, Message
 * and MessageMentions. Same names and shapes as discord.js v14 for what they cover; the rest of
 * each class throws GhostLinkUnsupported when used.
 */
import { randomBytes } from 'node:crypto';
import { messageSchemaClient, type Channel as WireChannel, type Message as WireMessage } from '@ghostlink/shared';
import { Collection } from './collection.js';
import type { Client } from './client.js';
import { resolveContent, type MessageCreateOptions, type MessageEditOptions, type MessageReplyOptions } from './content.js';
import { ChannelType, MessageType } from './enums.js';
import { GhostLinkError, GhostLinkUnsupported, unsupportedMembers } from './errors.js';

/** @internal */
export interface UserData {
  userId: string;
  nickname: string;
  bot?: boolean;
  avatar?: string | null;
}

/** Defines the non-enumerable `client` discord.js structures carry (util.inspect stays short). */
function bindClient(target: object, client: Client): void {
  Object.defineProperty(target, 'client', { value: client, enumerable: false, writable: false });
}

/** A message id as GhostLink knows it (a positive integer), from the string discord.js uses. */
function messageNumber(id: unknown, method: string): number {
  const n = typeof id === 'number' ? id : typeof id === 'string' && /^[0-9]{1,16}$/.test(id) ? Number(id) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new TypeError(`${method}: ${JSON.stringify(id)} is not a GhostLink message id`);
  return n;
}

// ---- users ----

/** A member of the GhostLink server, person or bot. `username` is their nickname there. */
export class User {
  declare readonly client: Client;
  readonly id: string;
  username: string;
  globalName: string | null = null;
  bot: boolean;
  readonly system = false;
  /** Always '0', as for Discord users with a unique username. */
  readonly discriminator = '0';
  /** The photo's SHA-256 (hex), or null. */
  avatar: string | null;

  /** @internal */
  constructor(client: Client, data: UserData) {
    bindClient(this, client);
    this.id = data.userId;
    this.username = data.nickname;
    this.bot = data.bot ?? false;
    this.avatar = data.avatar ?? null;
  }

  /** @internal */
  _patch(data: UserData): this {
    this.username = data.nickname;
    if (data.bot !== undefined) this.bot = data.bot;
    if (data.avatar !== undefined) this.avatar = data.avatar;
    return this;
  }

  /** discord.js: the username when the discriminator is '0'. */
  get tag(): string {
    return this.username;
  }

  get displayName(): string {
    return this.globalName ?? this.username;
  }

  /** The mention, `<@id>`: GhostLink mentions people the same way. */
  toString(): `<@${string}>` {
    return `<@${this.id}>`;
  }

  equals(user: User): boolean {
    return user instanceof User && user.id === this.id && user.username === this.username && user.bot === this.bot;
  }
}
unsupportedMembers(User.prototype, 'User', [
  'avatarURL', 'displayAvatarURL', 'avatarDecoration', 'avatarDecorationURL', 'banner', 'bannerURL', 'accentColor', 'hexAccentColor',
  'flags', 'fetchFlags', 'createdAt', 'createdTimestamp', 'dmChannel', 'createDM', 'deleteDM', 'send', 'fetch', 'partial',
]);

/** The bot itself (`client.user`). */
export class ClientUser extends User {}
unsupportedMembers(ClientUser.prototype, 'ClientUser', [
  'setPresence', 'setActivity', 'setStatus', 'setAFK', 'setUsername', 'setAvatar', 'setBanner', 'edit', 'presence', 'verified', 'mfaEnabled',
]);

// ---- the server ----

/** The GhostLink server the bot is in: its only "guild". `id` is the server's key id (the pin). */
export class Guild {
  declare readonly client: Client;
  readonly id: string;
  name: string;
  /** The owner's userId, or null when the server has none. */
  ownerId: string | null;
  readonly available = true;

  /** @internal */
  constructor(client: Client, data: { id: string; name: string; ownerId: string | null }) {
    bindClient(this, client);
    this.id = data.id;
    this.name = data.name;
    this.ownerId = data.ownerId;
  }

  get memberCount(): number {
    return this.client.users.cache.size;
  }

  toString(): string {
    return this.name;
  }
}
unsupportedMembers(Guild.prototype, 'Guild', [
  'members', 'roles', 'channels', 'commands', 'bans', 'invites', 'emojis', 'stickers', 'voiceStates', 'scheduledEvents',
  'autoModerationRules', 'presences', 'stageInstances', 'icon', 'iconURL', 'banner', 'bannerURL', 'splashURL', 'description',
  'systemChannel', 'systemChannelId', 'rulesChannel', 'afkChannel', 'preferredLocale', 'premiumTier', 'features', 'createdAt',
  'createdTimestamp', 'joinedAt', 'joinedTimestamp', 'fetch', 'fetchOwner', 'fetchAuditLogs', 'fetchWebhooks', 'fetchIntegrations',
  'leave', 'delete', 'edit', 'setName', 'setIcon', 'setBanner', 'setOwner', 'shardId', 'shard',
]);

// ---- channels ----

/** `messages.fetch()` options: newest first, up to 100. */
export interface FetchMessagesOptions {
  limit?: number;
  /** Messages older than this one. */
  before?: string;
  /** Not supported on GhostLink. */
  after?: never;
  around?: never;
  cache?: boolean;
}

export interface FetchMessageOptions {
  message: string | { id: string };
  cache?: boolean;
  force?: boolean;
}

interface HistoryPage {
  messages: unknown[];
  hasMore: boolean;
}

/** `channel.messages`. */
export class MessageManager {
  declare readonly client: Client;
  readonly channel: TextChannel;

  /** @internal */
  constructor(channel: TextChannel) {
    bindClient(this, channel.client);
    this.channel = channel;
  }

  /** One message by id, or the latest messages (newest first). */
  fetch(message: string): Promise<Message>;
  fetch(options: FetchMessageOptions): Promise<Message>;
  fetch(options?: FetchMessagesOptions): Promise<Collection<string, Message>>;
  async fetch(options?: string | FetchMessageOptions | FetchMessagesOptions): Promise<Message | Collection<string, Message>> {
    if (typeof options === 'string') return this.#fetchOne(options);
    if (typeof options === 'object' && options !== null && 'message' in options) {
      const ref = options.message;
      return this.#fetchOne(typeof ref === 'string' ? ref : ref.id);
    }
    const o = (options ?? {}) as FetchMessagesOptions & Record<string, unknown>;
    if (o.after !== undefined) throw new GhostLinkUnsupported('MessageManager.fetch({ after })');
    if (o.around !== undefined) throw new GhostLinkUnsupported('MessageManager.fetch({ around })');
    const limit = o.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('MessageManager.fetch: limit must be an integer from 1 to 100');
    let before = o.before === undefined ? undefined : messageNumber(o.before, 'MessageManager.fetch');
    const out = new Collection<string, Message>();
    while (out.size < limit) {
      const page = await this.client._request<HistoryPage>('msg.history', {
        channelId: this.channel.id,
        limit: Math.min(50, limit - out.size),
        ...(before === undefined ? {} : { before }),
      });
      const messages = parseMessages(page.messages);
      // GhostLink pages go oldest → newest; discord.js returns newest first.
      for (const m of [...messages].reverse()) out.set(String(m.id), new Message(this.client, m));
      if (!page.hasMore || messages.length === 0) break;
      before = messages[0]!.id;
    }
    return out;
  }

  async #fetchOne(id: string): Promise<Message> {
    const n = messageNumber(id, 'MessageManager.fetch');
    // The newest message older than id + 1 is that message, when it is in this channel.
    const page = await this.client._request<HistoryPage>('msg.history', { channelId: this.channel.id, before: n + 1, limit: 1 });
    const found = parseMessages(page.messages).find((m) => m.id === n);
    if (!found) throw new GhostLinkError('NOT_FOUND', 'Unknown Message', 'msg.history');
    return new Message(this.client, found);
  }
}
unsupportedMembers(MessageManager.prototype, 'MessageManager', [
  'cache', 'fetchPinned', 'fetchPins', 'delete', 'edit', 'pin', 'unpin', 'react', 'crosspost', 'forward', 'resolve', 'resolveId',
]);

function parseMessages(list: unknown[]): WireMessage[] {
  return list.flatMap((m) => {
    const parsed = messageSchemaClient.safeParse(m);
    return parsed.success ? [parsed.data] : [];
  });
}

/** @internal */
export interface ChannelData {
  id: string;
  name: string;
  topic?: string;
  position?: number;
}

/** A text channel the bot can see. */
export class TextChannel {
  declare readonly client: Client;
  readonly id: string;
  name: string;
  topic: string | null;
  position: number;
  readonly type = ChannelType.GuildText;
  readonly messages: MessageManager;

  /** @internal */
  constructor(client: Client, data: ChannelData) {
    bindClient(this, client);
    this.id = data.id;
    this.name = data.name;
    this.topic = data.topic === undefined || data.topic === '' ? null : data.topic;
    this.position = data.position ?? 0;
    this.messages = new MessageManager(this);
  }

  /** @internal */
  _patch(data: WireChannel): this {
    this.name = data.name;
    this.topic = data.topic === '' ? null : data.topic;
    this.position = data.position;
    return this;
  }

  get guild(): Guild {
    return this.client._guild();
  }

  get guildId(): string {
    return this.guild.id;
  }

  /** Sends a message (text only) and resolves with it. */
  async send(options: string | MessageCreateOptions): Promise<Message> {
    const { content, replyTo } = resolveContent('TextChannel.send', options, { reply: true });
    return this.client._send(this.id, content, replyTo === null ? undefined : messageNumber(replyTo, 'TextChannel.send'));
  }

  /** Shows "<bot> is typing…" for a few seconds. */
  async sendTyping(): Promise<void> {
    await this.client._request('typing', { channelId: this.id });
  }

  toString(): `<#${string}>` {
    return `<#${this.id}>`;
  }

  isTextBased(): this is TextChannel {
    return true;
  }

  isSendable(): this is TextChannel {
    return true;
  }

  isVoiceBased(): false {
    return false;
  }

  isDMBased(): false {
    return false;
  }

  isThread(): false {
    return false;
  }

  inGuild(): true {
    return true;
  }
}
unsupportedMembers(TextChannel.prototype, 'TextChannel', [
  'bulkDelete', 'createInvite', 'fetchInvites', 'createWebhook', 'fetchWebhooks', 'permissionsFor', 'permissionOverwrites',
  'lockPermissions', 'setName', 'setTopic', 'setPosition', 'setParent', 'setNSFW', 'setRateLimitPerUser', 'setType',
  'edit', 'delete', 'clone', 'threads', 'awaitMessages', 'createMessageCollector', 'awaitMessageComponent',
  'createMessageComponentCollector', 'lastMessage', 'lastMessageId', 'lastPinAt', 'lastPinTimestamp', 'parent', 'parentId',
  'nsfw', 'rateLimitPerUser', 'members', 'viewable', 'manageable', 'deletable', 'createdAt', 'createdTimestamp', 'url', 'fetch',
  'partial', 'defaultAutoArchiveDuration', 'defaultThreadRateLimitPerUser',
]);

// ---- messages ----

/** Who a message mentions (`message.mentions`). */
export class MessageMentions {
  declare readonly client: Client;
  /** `@everyone` took effect. */
  readonly everyone: boolean;
  readonly users: Collection<string, User>;
  /** The author of the message this one replies to. */
  readonly repliedUser: User | null;
  readonly #roleIds: readonly string[];

  /** @internal */
  constructor(client: Client, message: WireMessage) {
    bindClient(this, client);
    this.everyone = message.mentions.everyone;
    this.users = new Collection(message.mentions.users.map((id) => [id, client._user(id)] as const));
    this.repliedUser = message.replyTo?.authorId ? client._user(message.replyTo.authorId) : null;
    this.#roleIds = message.mentions.roles;
  }

  /**
   * Whether `data` (a user or its id) is mentioned: directly, by `@everyone`, or through one of
   * their roles, as in discord.js.
   */
  has(
    data: User | { id: string } | string,
    options: { ignoreDirect?: boolean; ignoreRoles?: boolean; ignoreRepliedUser?: boolean; ignoreEveryone?: boolean } = {},
  ): boolean {
    const id = typeof data === 'string' ? data : data.id;
    if (!options.ignoreEveryone && this.everyone) return true;
    if (!options.ignoreRepliedUser && this.repliedUser?.id === id && this.users.has(id)) return true;
    if (!options.ignoreDirect && this.users.has(id)) return true;
    if (!options.ignoreRoles && this.#roleIds.length > 0) {
      const roles = this.client._memberRoles(id);
      if (this.#roleIds.some((r) => roles.includes(r))) return true;
    }
    return false;
  }
}
unsupportedMembers(MessageMentions.prototype, 'MessageMentions', ['roles', 'members', 'channels', 'crosspostedChannels', 'parsedUsers']);

/** A message in a text channel. `id` is GhostLink's message number, as a string. */
export class Message {
  declare readonly client: Client;
  readonly id: string;
  readonly channelId: string;
  readonly guildId: string;
  content: string;
  readonly author: User;
  readonly createdTimestamp: number;
  editedTimestamp: number | null;
  readonly mentions: MessageMentions;
  readonly type: MessageType;
  readonly system = false;
  readonly webhookId = null;
  readonly tts = false;
  /** The bot's id on its answers to slash commands, null otherwise. */
  readonly applicationId: string | null;

  /** @internal */
  constructor(client: Client, data: WireMessage) {
    bindClient(this, client);
    this.id = String(data.id);
    this.channelId = data.channelId;
    this.guildId = client._guild().id;
    this.content = data.content;
    this.author = client._user(data.authorId, data.authorBot);
    this.createdTimestamp = data.createdAt;
    this.editedTimestamp = data.editedAt;
    this.mentions = new MessageMentions(client, data);
    this.type = data.interaction ? MessageType.ChatInputCommand : data.replyTo ? MessageType.Reply : MessageType.Default;
    this.applicationId = data.interaction ? data.authorId : null;
  }

  get channel(): TextChannel {
    return this.client._channel(this.channelId);
  }

  get guild(): Guild {
    return this.client._guild();
  }

  get createdAt(): Date {
    return new Date(this.createdTimestamp);
  }

  get editedAt(): Date | null {
    return this.editedTimestamp === null ? null : new Date(this.editedTimestamp);
  }

  get partial(): false {
    return false;
  }

  inGuild(): true {
    return true;
  }

  /** Replies in the same channel, quoting this message. */
  async reply(options: string | MessageReplyOptions): Promise<Message> {
    const { content } = resolveContent('Message.reply', options);
    return this.client._send(this.channelId, content, messageNumber(this.id, 'Message.reply'));
  }

  /** Edits the text of one of the bot's own messages. */
  async edit(options: string | MessageEditOptions): Promise<Message> {
    const { content } = resolveContent('Message.edit', options);
    const res = await this.client._request<{ message: unknown }>('msg.edit', { id: messageNumber(this.id, 'Message.edit'), content });
    const updated = new Message(this.client, messageSchemaClient.parse(res.message));
    this.content = updated.content;
    this.editedTimestamp = updated.editedTimestamp;
    return updated;
  }

  /** Deletes the message (the bot's own, or any with MANAGE_MESSAGES). */
  async delete(): Promise<Message> {
    await this.client._request('msg.delete', { id: messageNumber(this.id, 'Message.delete') });
    return this;
  }

  toString(): string {
    return this.content;
  }
}
unsupportedMembers(Message.prototype, 'Message', [
  'member', 'attachments', 'embeds', 'components', 'reactions', 'stickers', 'reference', 'thread', 'poll', 'interaction',
  'interactionMetadata', 'activity', 'flags', 'nonce', 'position', 'call', 'messageSnapshots', 'roleSubscriptionData', 'url',
  'cleanContent', 'crosspostable', 'deletable', 'editable', 'pinnable', 'pinned', 'hasThread', 'groupActivityApplication',
  'react', 'pin', 'unpin', 'crosspost', 'startThread', 'fetch', 'fetchReference', 'fetchWebhook', 'suppressEmbeds',
  'awaitReactions', 'createReactionCollector', 'awaitMessageComponent', 'createMessageComponentCollector', 'removeAttachments',
  'forward', 'equals', 'resolveComponent',
]);

/**
 * An answer only the person who used the command sees (GhostLink never stores it), as
 * interaction.reply/followUp return it. Only the original answer can be edited, through the
 * interaction.
 * @internal
 */
export class EphemeralMessage extends Message {
  readonly #edit: ((content: string) => Promise<Message>) | null;

  constructor(client: Client, data: WireMessage, edit: ((content: string) => Promise<Message>) | null) {
    super(client, data);
    this.#edit = edit;
  }

  override async edit(options: string | MessageEditOptions): Promise<Message> {
    if (this.#edit === null) throw new GhostLinkUnsupported('Message.edit', 'an ephemeral follow-up cannot be edited');
    return this.#edit(resolveContent('Message.edit', options).content);
  }

  override async delete(): Promise<Message> {
    throw new GhostLinkUnsupported('Message.delete', 'an ephemeral answer goes away when its reader dismisses it');
  }
}

/**
 * A message id for a send (`clientMsgId`): GhostLink returns the same message on a retry.
 * @internal
 */
export function newClientMsgId(): string {
  return randomBytes(16).toString('base64url');
}
