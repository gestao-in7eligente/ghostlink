/**
 * discord.js's Client for a GhostLink bot (bots spec §4): `client.login(connectionCode)` opens the
 * pinned session, keeps the channels and members the bot can see in `client.channels` and
 * `client.users`, and emits ClientReady, MessageCreate and InteractionCreate. It reconnects by
 * itself; a refusal that no retry can fix (a new code, a ban, a wrong pin) is emitted as 'error'.
 */
import { EventEmitter } from 'node:events';
import process from 'node:process';
import {
  botCommandsSchemaClient,
  botsWelcomeSchemaClient,
  channelSchemaClient,
  interactionCreateEventSchemaClient,
  memberSchemaClient,
  messageSchemaClient,
  serverInfoSchemaClient,
  textWelcomeSchemaClient,
  welcomeSchemaClient,
  type BotCommand,
  type Channel as WireChannel,
  type Envelope,
  type Member,
} from '@ghostlink/shared';
import { ClientApplication } from './application.js';
import { Collection } from './collection.js';
import { parseConnectionCode } from './connectionCode.js';
import { Events } from './enums.js';
import { DiscordjsError, GhostLinkError, GhostLinkUnsupported, unsupportedMembers } from './errors.js';
import { Gateway } from './gateway.js';
import { ChatInputCommandInteraction } from './interactions.js';
import { liveSessions, type BotSession } from './rest.js';
import { ClientUser, Guild, Message, TextChannel, User, newClientMsgId } from './structures.js';

/** `new Client(options)`: intents and partials are accepted and ignored (a bot sees what its roles let it see). */
export interface ClientOptions {
  intents?: unknown;
  partials?: unknown;
  [option: string]: unknown;
}

/** The only interaction on GhostLink. */
export type Interaction = ChatInputCommandInteraction;

/** The events a GhostLink bot gets. */
export interface ClientEvents {
  ready: [client: Client<true>];
  clientReady: [client: Client<true>];
  messageCreate: [message: Message];
  interactionCreate: [interaction: Interaction];
  error: [error: Error];
  warn: [message: string];
  debug: [message: string];
}

type If<T extends boolean, A, B = null> = T extends true ? A : T extends false ? B : A | B;
// discord.js's own listener type; the second overload of on() takes any event name.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyListener = (...args: any[]) => void;

const SUPPORTED_EVENTS: ReadonlySet<string> = new Set(['ready', 'clientReady', 'messageCreate', 'interactionCreate', 'error', 'warn', 'debug']);
const EVENT_NAMES: ReadonlyMap<string, string> = new Map(Object.entries(Events).map(([key, value]) => [value, key]));

function checkEvent(event: string | symbol): void {
  if (typeof event !== 'string' || SUPPORTED_EVENTS.has(event)) return;
  const key = EVENT_NAMES.get(event);
  if (key !== undefined) throw new GhostLinkUnsupported(`Events.${key} ('${event}')`, 'GhostLink bots get ClientReady, MessageCreate and InteractionCreate');
}

/** `client.channels`: the text channels the bot can see. */
export class ChannelManager {
  declare readonly client: Client;
  readonly cache = new Collection<string, TextChannel>();

  /** @internal */
  constructor(client: Client) {
    Object.defineProperty(this, 'client', { value: client, enumerable: false });
  }

  /** A channel the bot sees; rejects (NOT_FOUND, "Unknown Channel") otherwise. */
  async fetch(id: string): Promise<TextChannel> {
    const channel = this.cache.get(id);
    if (!channel) throw new GhostLinkError('NOT_FOUND', 'Unknown Channel');
    return channel;
  }

  resolve(channel: TextChannel | string): TextChannel | null {
    return this.cache.get(typeof channel === 'string' ? channel : channel.id) ?? null;
  }

  resolveId(channel: TextChannel | string): string | null {
    return this.resolve(channel)?.id ?? null;
  }
}
unsupportedMembers(ChannelManager.prototype, 'ChannelManager', ['createMessage']);

/** `client.users`: the server's members, people and bots. */
export class UserManager {
  declare readonly client: Client;
  readonly cache = new Collection<string, User>();

  /** @internal */
  constructor(client: Client) {
    Object.defineProperty(this, 'client', { value: client, enumerable: false });
  }

  async fetch(id: string): Promise<User> {
    const user = this.cache.get(id);
    if (!user) throw new GhostLinkError('NOT_FOUND', 'Unknown User');
    return user;
  }

  resolve(user: User | string): User | null {
    return this.cache.get(typeof user === 'string' ? user : user.id) ?? null;
  }

  resolveId(user: User | string): string | null {
    return this.resolve(user)?.id ?? null;
  }
}
unsupportedMembers(UserManager.prototype, 'UserManager', ['createDM', 'deleteDM', 'send', 'fetchFlags']);

/** `client.guilds`: the one GhostLink server the bot belongs to. */
export class GuildManager {
  declare readonly client: Client;
  readonly cache = new Collection<string, Guild>();

  /** @internal */
  constructor(client: Client) {
    Object.defineProperty(this, 'client', { value: client, enumerable: false });
  }

  resolve(guild: Guild | string): Guild | null {
    return this.cache.get(typeof guild === 'string' ? guild : guild.id) ?? null;
  }
}
unsupportedMembers(GuildManager.prototype, 'GuildManager', ['fetch', 'create', 'widgetImageURL']);

/** `client.ws`. */
export class WebSocketManager {
  readonly #client: () => Gateway | null;

  /** @internal */
  constructor(gateway: () => Gateway | null) {
    this.#client = gateway;
  }

  /** The last round trip to the server in ms, -1 before the first. */
  get ping(): number {
    return this.#client()?.ping ?? -1;
  }
}
unsupportedMembers(WebSocketManager.prototype, 'WebSocketManager', ['shards', 'status', 'gateway', 'destroy']);

export class Client<Ready extends boolean = boolean> extends EventEmitter {
  readonly options: ClientOptions;
  /** The connection code (non-enumerable, so logging the client never prints it). */
  declare token: If<Ready, string, string | null>;
  user: If<Ready, ClientUser> = null as If<Ready, ClientUser>;
  application: If<Ready, ClientApplication> = null as If<Ready, ClientApplication>;
  readyTimestamp: If<Ready, number> = null as If<Ready, number>;
  readonly channels: ChannelManager;
  readonly users: UserManager;
  readonly guilds: GuildManager;
  readonly ws: WebSocketManager;
  #gateway: Gateway | null = null;
  #session: { token: string; entry: BotSession } | null = null;
  #guild: Guild | null = null;
  #commands: BotCommand[] = [];
  readonly #roles = new Map<string, string[]>();
  /** Events that arrive between the welcome and 'ready' wait here, so 'ready' is always first. */
  #early: Envelope[] | null = null;

  /** Reads the connection code from GHOSTLINK_BOT (or DISCORD_TOKEN) when login() gets none. */
  constructor(options: ClientOptions = {}) {
    super();
    this.options = options;
    Object.defineProperty(this, 'token', {
      value: process.env.GHOSTLINK_BOT ?? process.env.DISCORD_TOKEN ?? null,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    this.channels = new ChannelManager(this as Client);
    this.users = new UserManager(this as Client);
    this.guilds = new GuildManager(this as Client);
    this.ws = new WebSocketManager(() => this.#gateway);
  }

  /** `user` without the Ready generic, for the code below. */
  get #me(): ClientUser | null {
    return this.user as ClientUser | null;
  }

  get readyAt(): If<Ready, Date> {
    return (this.readyTimestamp === null ? null : new Date(this.readyTimestamp)) as If<Ready, Date>;
  }

  get uptime(): If<Ready, number> {
    return (this.readyTimestamp === null ? null : Date.now() - this.readyTimestamp) as If<Ready, number>;
  }

  isReady(): this is Client<true> {
    return this.readyTimestamp !== null;
  }

  /**
   * Connects with the bot's connection code (`ghostlink-bot://host:port?pin=…&token=…`), as shown
   * once by the app when the bot was created. Resolves once the bot is ready; a wrong code, a
   * certificate that does not match the pin, or an unreachable server rejects.
   */
  async login(token: string | null | undefined = this.token): Promise<string> {
    if (this.#gateway !== null) throw new Error('This client is already logged in; call destroy() first.');
    if (typeof token !== 'string' || token === '') throw new DiscordjsError('TokenInvalid');
    const code = parseConnectionCode(token);
    this.token = token as If<Ready, string, string | null>;
    const gateway = new Gateway(code);
    this.#gateway = gateway;
    gateway.on('welcome', (welcome: Record<string, unknown>) => this.#applyWelcome(welcome));
    gateway.on('event', (event: Envelope) => this.#onEvent(event));
    gateway.on('debug', (message: string) => this.emit('debug', message));
    gateway.on('warn', (message: string) => this.emit('warn', message));
    gateway.on('fatal', (error: Error) => this.#onFatal(gateway, error));
    this.#early = [];
    try {
      await gateway.connect();
    } catch (e) {
      gateway.removeAllListeners();
      if (this.#gateway === gateway) this.#gateway = null;
      this.#early = null;
      throw e;
    }
    if (this.#gateway !== gateway) throw new Error('The client was destroyed while logging in.');
    const entry: BotSession = {
      request: (t, d) => this._request(t, d),
      selfId: () => this._selfId(),
      commands: () => this.#commands.map((c) => ({ ...c, options: [...c.options] })),
    };
    this.#session = { token: code.token, entry };
    liveSessions.set(code.token, entry);
    this.readyTimestamp = Date.now() as If<Ready, number>;
    this.emit('ready', this);
    this.emit('clientReady', this);
    const early = this.#early ?? [];
    this.#early = null;
    for (const event of early) this.#onEvent(event);
    return token;
  }

  /** Closes the connection and stops reconnecting. */
  async destroy(): Promise<void> {
    const gateway = this.#gateway;
    this.#gateway = null;
    gateway?.removeAllListeners();
    gateway?.close();
    this.#forget();
    this.token = null as If<Ready, string, string | null>;
  }

  override on<E extends keyof ClientEvents>(event: E, listener: (...args: ClientEvents[E]) => void): this;
  override on(event: string | symbol, listener: AnyListener): this;
  override on(event: string | symbol, listener: AnyListener): this {
    checkEvent(event);
    return super.on(event, listener);
  }

  override once<E extends keyof ClientEvents>(event: E, listener: (...args: ClientEvents[E]) => void): this;
  override once(event: string | symbol, listener: AnyListener): this;
  override once(event: string | symbol, listener: AnyListener): this {
    checkEvent(event);
    return super.once(event, listener);
  }

  override addListener<E extends keyof ClientEvents>(event: E, listener: (...args: ClientEvents[E]) => void): this;
  override addListener(event: string | symbol, listener: AnyListener): this;
  override addListener(event: string | symbol, listener: AnyListener): this {
    checkEvent(event);
    return super.addListener(event, listener);
  }

  override prependListener<E extends keyof ClientEvents>(event: E, listener: (...args: ClientEvents[E]) => void): this;
  override prependListener(event: string | symbol, listener: AnyListener): this;
  override prependListener(event: string | symbol, listener: AnyListener): this {
    checkEvent(event);
    return super.prependListener(event, listener);
  }

  override prependOnceListener<E extends keyof ClientEvents>(event: E, listener: (...args: ClientEvents[E]) => void): this;
  override prependOnceListener(event: string | symbol, listener: AnyListener): this;
  override prependOnceListener(event: string | symbol, listener: AnyListener): this {
    checkEvent(event);
    return super.prependOnceListener(event, listener);
  }

  // ---- for the structures (stripped from the published types) ----

  /** @internal */
  _request<T = unknown>(t: string, d: unknown = {}): Promise<T> {
    const gateway = this.#gateway;
    if (gateway === null) return Promise.reject(new DiscordjsError('ClientNotReady', `send ${t}`));
    return gateway.request<T>(t, d);
  }

  /** @internal */
  async _send(channelId: string, content: string, replyTo?: number): Promise<Message> {
    const res = await this._request<{ message: unknown }>('msg.send', {
      channelId,
      content,
      clientMsgId: newClientMsgId(),
      ...(replyTo === undefined ? {} : { replyTo }),
    });
    return new Message(this as Client, messageSchemaClient.parse(res.message));
  }

  /** @internal */
  _guild(): Guild {
    if (this.#guild === null) throw new DiscordjsError('ClientNotReady', 'read the server');
    return this.#guild;
  }

  /** @internal A channel the bot sees, or a stand-in with only its id. */
  _channel(id: string): TextChannel {
    return this.channels.cache.get(id) ?? new TextChannel(this as Client, { id, name: '' });
  }

  /** @internal A member, or a stand-in for one who left. */
  _user(id: string, bot = false): User {
    return this.users.cache.get(id) ?? new User(this as Client, { userId: id, nickname: 'Deleted user', bot });
  }

  /** @internal */
  _upsertMember(member: Member): User {
    this.#roles.set(member.userId, member.roleIds);
    const data = { userId: member.userId, nickname: member.nickname, bot: member.bot, avatar: member.avatar };
    const me = this.#me;
    if (me !== null && member.userId === me.id) return me._patch(data);
    const known = this.users.cache.get(member.userId);
    if (known) return known._patch(data);
    const user = new User(this as Client, data);
    this.users.cache.set(user.id, user);
    return user;
  }

  /** @internal */
  _memberRoles(id: string): readonly string[] {
    return this.#roles.get(id) ?? [];
  }

  /** @internal */
  _selfId(): string {
    return this.#me?.id ?? '';
  }

  /** @internal */
  _selfName(): string {
    return this.#me?.username ?? '';
  }

  // ---- the session ----

  #applyWelcome(raw: Record<string, unknown>): void {
    const welcome = welcomeSchemaClient.parse(raw);
    const text = textWelcomeSchemaClient.safeParse(raw);
    const bots = botsWelcomeSchemaClient.safeParse(raw);
    const self = { userId: welcome.self.userId, nickname: welcome.self.nickname, bot: true, avatar: null };
    const known = this.#me;
    if (known === null || known.id !== self.userId) this.user = new ClientUser(this as Client, self) as If<Ready, ClientUser>;
    else known._patch(self);
    const ownerId = text.success ? text.data.serverSettings.ownerId : null;
    if (this.#guild === null || this.#guild.id !== welcome.server.serverKeyId) {
      this.#guild = new Guild(this as Client, { id: welcome.server.serverKeyId, name: welcome.server.name, ownerId });
      this.guilds.cache.clear();
      this.guilds.cache.set(this.#guild.id, this.#guild);
    } else {
      this.#guild.name = welcome.server.name;
      this.#guild.ownerId = ownerId;
    }

    const members = text.success ? text.data.members : [];
    const present = new Set(members.map((m) => m.userId));
    for (const id of [...this.users.cache.keys()]) if (!present.has(id)) this.users.cache.delete(id);
    this.#roles.clear();
    for (const member of members) this._upsertMember(member);
    const me = this.#me!;
    this.users.cache.set(me.id, me);

    const channels = (text.success ? text.data.channels : []).filter((c) => c.type === 'text');
    const visible = new Set(channels.map((c) => c.id));
    for (const id of [...this.channels.cache.keys()]) if (!visible.has(id)) this.channels.cache.delete(id);
    for (const channel of channels) this.#upsertChannel(channel);

    if (this.application === null) this.application = new ClientApplication(this as Client) as If<Ready, ClientApplication>;
    const own = bots.success ? bots.data.botCommands.find((b) => b.botId === me.id) : undefined;
    this.#setCommands(own?.commands ?? []);
    if (this.readyTimestamp !== null) this.emit('debug', '[GhostLink] reconnected');
  }

  #upsertChannel(channel: WireChannel): void {
    if (channel.type !== 'text') return;
    const known = this.channels.cache.get(channel.id);
    if (known) known._patch(channel);
    else this.channels.cache.set(channel.id, new TextChannel(this as Client, channel));
  }

  #setCommands(commands: BotCommand[]): void {
    this.#commands = commands;
    (this.application as ClientApplication | null)?.commands._replace(commands);
  }

  #onEvent(event: Envelope): void {
    if (this.#early !== null) {
      this.#early.push(event);
      return;
    }
    const d = (event.d ?? {}) as Record<string, unknown>;
    switch (event.t) {
      case 'msg.new': {
        const message = messageSchemaClient.safeParse(d.message);
        if (message.success) this.emit('messageCreate', new Message(this as Client, message.data));
        return;
      }
      case 'interaction.create': {
        const interaction = interactionCreateEventSchemaClient.safeParse(d);
        if (interaction.success) this.emit('interactionCreate', new ChatInputCommandInteraction(this as Client, interaction.data));
        return;
      }
      case 'member.joined':
      case 'member.updated': {
        const member = memberSchemaClient.safeParse(d.member);
        if (member.success) this._upsertMember(member.data);
        return;
      }
      case 'member.left':
        if (typeof d.userId === 'string' && d.userId !== this.#me?.id) {
          this.users.cache.delete(d.userId);
          this.#roles.delete(d.userId);
        }
        return;
      case 'channel.created':
      case 'channel.updated': {
        const channel = channelSchemaClient.safeParse(d.channel);
        if (channel.success) this.#upsertChannel(channel.data);
        return;
      }
      case 'channel.deleted':
        if (typeof d.id === 'string') this.channels.cache.delete(d.id);
        return;
      case 'server.updated': {
        const info = serverInfoSchemaClient.safeParse(d);
        if (info.success && this.#guild !== null) {
          this.#guild.name = info.data.name;
          this.#guild.ownerId = info.data.ownerId;
        }
        return;
      }
      case 'commands.updated': {
        const update = botCommandsSchemaClient.safeParse(d);
        if (update.success && update.data.botId === this.#me?.id) this.#setCommands(update.data.commands);
        return;
      }
      default:
        return;
    }
  }

  #onFatal(gateway: Gateway, error: Error): void {
    if (this.#gateway !== gateway) return;
    this.#gateway = null;
    gateway.removeAllListeners();
    this.#forget();
    // As in discord.js: without an 'error' listener, this ends the process with the reason.
    this.emit('error', error);
  }

  #forget(): void {
    if (this.#session !== null && liveSessions.get(this.#session.token) === this.#session.entry) liveSessions.delete(this.#session.token);
    this.#session = null;
    this.#early = null;
    this.readyTimestamp = null as If<Ready, number>;
  }
}
unsupportedMembers(Client.prototype, 'Client', [
  'rest', 'shard', 'emojis', 'voice', 'sweepers', 'presence', 'generateInvite', 'fetchInvite', 'fetchGuildTemplate',
  'fetchVoiceRegions', 'fetchSticker', 'fetchStickerPacks', 'fetchPremiumStickerPacks', 'fetchWebhook', 'fetchGuildPreview',
  'fetchGuildWidget', 'fetchDefaultSoundboardSounds', 'guildsReady',
]);
