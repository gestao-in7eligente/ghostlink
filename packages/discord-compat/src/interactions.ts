/**
 * Slash command interactions (bots spec §2, §4): ChatInputCommandInteraction with its option
 * getters and the answers GhostLink has: reply, deferReply ("<bot> is thinking…"), editReply and
 * followUp, public or ephemeral (only the person who used the command sees it).
 */
import { interactionResultSchemaClient, type InteractionCreateEvent, type Message as WireMessage } from '@ghostlink/shared';
import type { Client } from './client.js';
import {
  resolveContent,
  type InteractionDeferReplyOptions,
  type InteractionEditReplyOptions,
  type InteractionReplyOptions,
} from './content.js';
import { ApplicationCommandOptionType, ApplicationCommandType, ChannelType, InteractionType } from './enums.js';
import { DiscordjsError, DiscordjsTypeError, GhostLinkError, GhostLinkUnsupported, unsupportedMembers } from './errors.js';
import { EphemeralMessage, Message, type Guild, type TextChannel, type User } from './structures.js';

/** An option as `interaction.options.get()` and `.data` show it. */
export interface CommandInteractionOption {
  name: string;
  type: ApplicationCommandOptionType;
  value?: string | number | boolean;
  user?: User;
  channel?: TextChannel;
}

const OPTION_TYPES = {
  string: ApplicationCommandOptionType.String,
  integer: ApplicationCommandOptionType.Integer,
  number: ApplicationCommandOptionType.Number,
  boolean: ApplicationCommandOptionType.Boolean,
  user: ApplicationCommandOptionType.User,
  channel: ApplicationCommandOptionType.Channel,
} as const;

/** `interaction.options`. Getters return null for an option not given, and throw when `required` is true. */
export class CommandInteractionOptionResolver {
  declare readonly client: Client;
  readonly data: readonly CommandInteractionOption[];

  /** @internal */
  constructor(client: Client, options: InteractionCreateEvent['options']) {
    Object.defineProperty(this, 'client', { value: client, enumerable: false });
    this.data = options.map((o) => {
      const option: CommandInteractionOption = { name: o.name, type: OPTION_TYPES[o.type], value: o.value };
      if (o.type === 'user' && typeof o.value === 'string') option.user = client._user(o.value);
      if (o.type === 'channel' && typeof o.value === 'string') option.channel = client._channel(o.value);
      return option;
    });
  }

  get(name: string, required: true): CommandInteractionOption;
  get(name: string, required?: boolean): CommandInteractionOption | null;
  get(name: string, required = false): CommandInteractionOption | null {
    const option = this.data.find((o) => o.name === name);
    if (option) return option;
    if (required) throw new DiscordjsTypeError('CommandInteractionOptionNotFound', name);
    return null;
  }

  #typed(name: string, type: ApplicationCommandOptionType, property: 'value' | 'user' | 'channel', required: boolean): CommandInteractionOption | null {
    const option = this.get(name, required);
    if (option === null) return null;
    if (option.type !== type) {
      throw new DiscordjsTypeError('CommandInteractionOptionType', name, ApplicationCommandOptionType[option.type] ?? String(option.type), ApplicationCommandOptionType[type]!);
    }
    if (required && (option[property] === undefined || option[property] === null)) {
      throw new DiscordjsTypeError('CommandInteractionOptionEmpty', name, ApplicationCommandOptionType[option.type]!);
    }
    return option;
  }

  getString(name: string, required: true): string;
  getString(name: string, required?: boolean): string | null;
  getString(name: string, required = false): string | null {
    return (this.#typed(name, ApplicationCommandOptionType.String, 'value', required)?.value as string | undefined) ?? null;
  }

  getInteger(name: string, required: true): number;
  getInteger(name: string, required?: boolean): number | null;
  getInteger(name: string, required = false): number | null {
    return (this.#typed(name, ApplicationCommandOptionType.Integer, 'value', required)?.value as number | undefined) ?? null;
  }

  getNumber(name: string, required: true): number;
  getNumber(name: string, required?: boolean): number | null;
  getNumber(name: string, required = false): number | null {
    return (this.#typed(name, ApplicationCommandOptionType.Number, 'value', required)?.value as number | undefined) ?? null;
  }

  getBoolean(name: string, required: true): boolean;
  getBoolean(name: string, required?: boolean): boolean | null;
  getBoolean(name: string, required = false): boolean | null {
    return (this.#typed(name, ApplicationCommandOptionType.Boolean, 'value', required)?.value as boolean | undefined) ?? null;
  }

  getUser(name: string, required: true): User;
  getUser(name: string, required?: boolean): User | null;
  getUser(name: string, required = false): User | null {
    return this.#typed(name, ApplicationCommandOptionType.User, 'user', required)?.user ?? null;
  }

  /** A text channel the bot sees, or one it does not (then only `id` and `toString()` are meaningful). */
  getChannel(name: string, required: true, channelTypes?: readonly ChannelType[]): TextChannel;
  getChannel(name: string, required?: boolean, channelTypes?: readonly ChannelType[]): TextChannel | null;
  getChannel(name: string, required = false, channelTypes: readonly ChannelType[] = []): TextChannel | null {
    const channel = this.#typed(name, ApplicationCommandOptionType.Channel, 'channel', required)?.channel ?? null;
    if (channel !== null && channelTypes.length > 0 && !channelTypes.includes(channel.type)) {
      throw new DiscordjsTypeError('CommandInteractionOptionType', name, ChannelType[channel.type]!, channelTypes.map((t) => ChannelType[t]).join(', '));
    }
    return channel;
  }
}
unsupportedMembers(CommandInteractionOptionResolver.prototype, 'CommandInteractionOptionResolver', [
  'getSubcommand', 'getSubcommandGroup', 'getMember', 'getRole', 'getMentionable', 'getAttachment', 'getFocused', 'getMessage', 'resolved',
]);

/** What reply() and deferReply() resolve with, unless `fetchReply` is set. */
export class InteractionResponse {
  declare readonly client: Client;
  readonly interaction: ChatInputCommandInteraction;
  readonly id: string;

  /** @internal */
  constructor(interaction: ChatInputCommandInteraction) {
    Object.defineProperty(this, 'client', { value: interaction.client, enumerable: false });
    this.interaction = interaction;
    this.id = interaction.id;
  }

  /** The same as `interaction.editReply()`. */
  edit(options: string | InteractionEditReplyOptions): Promise<Message> {
    return this.interaction.editReply(options);
  }
}
unsupportedMembers(InteractionResponse.prototype, 'InteractionResponse', ['delete', 'fetch', 'awaitMessageComponent', 'createMessageComponentCollector']);

/** A slash command someone used: the only interaction GhostLink has. */
export class ChatInputCommandInteraction {
  declare readonly client: Client;
  readonly id: string;
  /** The bot's id. */
  readonly applicationId: string;
  readonly type = InteractionType.ApplicationCommand;
  readonly commandType = ApplicationCommandType.ChatInput;
  readonly commandName: string;
  /** GhostLink commands have no separate id: their name. */
  readonly commandId: string;
  readonly commandGuildId = null;
  readonly channelId: string;
  readonly guildId: string;
  readonly user: User;
  readonly options: CommandInteractionOptionResolver;
  readonly createdTimestamp: number;
  deferred = false;
  replied = false;
  /** Whether the answer is ephemeral, once reply() or deferReply() ran. */
  ephemeral: boolean | null = null;
  #answering = false;

  /** @internal */
  constructor(client: Client, data: InteractionCreateEvent) {
    Object.defineProperty(this, 'client', { value: client, enumerable: false });
    this.id = data.id;
    this.applicationId = client._selfId();
    this.commandName = data.command;
    this.commandId = data.command;
    this.channelId = data.channelId;
    this.guildId = client._guild().id;
    this.user = client._upsertMember(data.user);
    this.options = new CommandInteractionOptionResolver(client, data.options);
    this.createdTimestamp = data.createdAt || Date.now();
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

  isChatInputCommand(): this is ChatInputCommandInteraction {
    return true;
  }

  isCommand(): this is ChatInputCommandInteraction {
    return true;
  }

  isRepliable(): this is ChatInputCommandInteraction {
    return true;
  }

  inGuild(): true {
    return true;
  }

  // GhostLink has no buttons, menus, modals, autocomplete or context menus (bots spec §1).
  isAutocomplete(): false {
    return false;
  }

  isButton(): false {
    return false;
  }

  isAnySelectMenu(): false {
    return false;
  }

  isSelectMenu(): false {
    return false;
  }

  isStringSelectMenu(): false {
    return false;
  }

  isUserSelectMenu(): false {
    return false;
  }

  isRoleSelectMenu(): false {
    return false;
  }

  isChannelSelectMenu(): false {
    return false;
  }

  isMentionableSelectMenu(): false {
    return false;
  }

  isMessageComponent(): false {
    return false;
  }

  isModalSubmit(): false {
    return false;
  }

  isContextMenuCommand(): false {
    return false;
  }

  isUserContextMenuCommand(): false {
    return false;
  }

  isMessageContextMenuCommand(): false {
    return false;
  }

  isPrimaryEntryPointCommand(): false {
    return false;
  }

  /**
   * The first answer, within 3 seconds: a message in the channel ("<user> used /<command>"), or
   * only for the user with `ephemeral: true` / `flags: MessageFlags.Ephemeral`.
   */
  reply(options: InteractionReplyOptions & { fetchReply: true }): Promise<Message>;
  reply(options: string | InteractionReplyOptions): Promise<InteractionResponse>;
  async reply(options: string | InteractionReplyOptions): Promise<InteractionResponse | Message> {
    const resolved = resolveContent('ChatInputCommandInteraction.reply', options, { ephemeral: true, fetchReply: true });
    const message = await this.#first({ type: 'reply', content: resolved.content, ephemeral: resolved.ephemeral });
    this.replied = true;
    this.ephemeral = resolved.ephemeral;
    if (!resolved.fetchReply) return new InteractionResponse(this);
    return this.#message(message, resolved.content, true);
  }

  /** Shows "<bot> is thinking…" and gives the bot 15 minutes to editReply(). */
  deferReply(options: InteractionDeferReplyOptions & { fetchReply: true }): Promise<Message>;
  deferReply(options?: InteractionDeferReplyOptions): Promise<InteractionResponse>;
  async deferReply(options?: InteractionDeferReplyOptions): Promise<InteractionResponse | Message> {
    const resolved = resolveContent('ChatInputCommandInteraction.deferReply', options, { ephemeral: true, fetchReply: true, noContent: true });
    if (resolved.fetchReply) throw new GhostLinkUnsupported('ChatInputCommandInteraction.deferReply({ fetchReply })', 'a deferred answer has no message until editReply()');
    await this.#first({ type: 'defer', ephemeral: resolved.ephemeral });
    this.deferred = true;
    this.ephemeral = resolved.ephemeral;
    return new InteractionResponse(this);
  }

  /** Sets the answer's text (after reply() or deferReply()). */
  async editReply(options: string | InteractionEditReplyOptions): Promise<Message> {
    if (!this.deferred && !this.replied) throw new DiscordjsError('InteractionNotReplied');
    const { content } = resolveContent('ChatInputCommandInteraction.editReply', options, { editTarget: true });
    const message = await this.#answer('interaction.edit', { id: this.id, content });
    this.replied = true;
    return this.#message(message, content, true);
  }

  /** Another message after the answer, public or ephemeral. */
  async followUp(options: string | InteractionReplyOptions): Promise<Message> {
    if (!this.deferred && !this.replied) throw new DiscordjsError('InteractionNotReplied');
    const { content, ephemeral } = resolveContent('ChatInputCommandInteraction.followUp', options, { ephemeral: true, fetchReply: true });
    const message = await this.#answer('interaction.followup', { id: this.id, content, ...(ephemeral ? { ephemeral } : {}) });
    return this.#message(message, content, false);
  }

  async #first(payload: { type: 'reply'; content: string; ephemeral: boolean } | { type: 'defer'; ephemeral: boolean }): Promise<WireMessage | null> {
    if (this.deferred || this.replied || this.#answering) throw new DiscordjsError('InteractionAlreadyReplied');
    this.#answering = true;
    try {
      const { ephemeral, ...rest } = payload;
      return await this.#answer('interaction.respond', { id: this.id, ...rest, ...(ephemeral ? { ephemeral } : {}) });
    } catch (e) {
      if (e instanceof GhostLinkError && e.code === 'NOT_FOUND') {
        throw new GhostLinkError('NOT_FOUND', 'Unknown interaction: the first answer must come within 3 seconds (deferReply() gives 15 minutes)', 'interaction.respond');
      }
      throw e;
    } finally {
      this.#answering = false;
    }
  }

  async #answer(t: string, d: Record<string, unknown>): Promise<WireMessage | null> {
    const res = await this.client._request(t, d);
    const parsed = interactionResultSchemaClient.safeParse(res);
    return parsed.success ? parsed.data.message : null;
  }

  /** The public message, or a stand-in for an ephemeral answer GhostLink does not store. */
  #message(message: WireMessage | null, content: string, isAnswer: boolean): Message {
    if (message !== null) return new Message(this.client, message);
    const now = Date.now();
    const data: WireMessage = {
      id: 0,
      channelId: this.channelId,
      authorId: this.applicationId,
      content,
      createdAt: now,
      editedAt: null,
      replyTo: null,
      reactions: [],
      mentions: { users: [], roles: [], everyone: false },
      clientMsgId: null,
      attachments: [],
      authorBot: true,
      interaction: { id: this.id, userId: this.user.id, command: this.commandName },
    };
    const edit = isAnswer ? (text: string) => this.editReply(text) : null;
    const stand = new EphemeralMessage(this.client, data, edit);
    Object.defineProperty(stand, 'id', { value: this.id });
    return stand;
  }
}
unsupportedMembers(ChatInputCommandInteraction.prototype, 'ChatInputCommandInteraction', [
  'member', 'memberPermissions', 'appPermissions', 'locale', 'guildLocale', 'token', 'version', 'webhook', 'command', 'entitlements',
  'authorizingIntegrationOwners', 'context', 'deleteReply', 'fetchReply', 'showModal', 'awaitModalSubmit', 'sendPremiumRequired',
  'launchActivity', 'inCachedGuild', 'inRawGuild',
]);
