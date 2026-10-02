/**
 * `client.application`: the bot as an application, and its slash commands
 * (`client.application.commands.set([...])` → GhostLink's `commands.set`, bots spec §2, §4).
 */
import { botCommandSchemaClient, type BotCommand } from '@ghostlink/shared';
import { Collection } from './collection.js';
import type { Client } from './client.js';
import { TO_DISCORD, toGhostLinkCommand, type ApplicationCommandDataResolvable } from './commands.js';
import { ApplicationCommandType, type ApplicationCommandOptionType } from './enums.js';
import { unsupportedMembers } from './errors.js';

/** A command option as discord.js's ApplicationCommand shows it (camelCase). */
export interface ApplicationCommandOption {
  type: ApplicationCommandOptionType;
  name: string;
  description: string;
  required: boolean;
  choices?: { name: string; value: string | number }[];
}

/** A registered slash command. GhostLink commands have no separate id: `id` is the name. */
export class ApplicationCommand {
  declare readonly client: Client;
  readonly id: string;
  readonly applicationId: string;
  readonly guildId = null;
  readonly type = ApplicationCommandType.ChatInput;
  readonly name: string;
  readonly description: string;
  readonly options: ApplicationCommandOption[];
  readonly version = '1';
  readonly dmPermission = false;
  readonly nsfw = false;
  readonly defaultMemberPermissions = null;

  /** @internal */
  constructor(client: Client, data: BotCommand) {
    Object.defineProperty(this, 'client', { value: client, enumerable: false });
    this.id = data.name;
    this.applicationId = client._selfId();
    this.name = data.name;
    this.description = data.description;
    this.options = data.options.map((o) => ({
      type: TO_DISCORD[o.type],
      name: o.name,
      description: o.description,
      required: o.required,
      ...(o.choices ? { choices: o.choices.map((c) => ({ name: c.name, value: c.value })) } : {}),
    }));
  }

  toString(): string {
    return `</${this.name}:${this.id}>`;
  }
}
unsupportedMembers(ApplicationCommand.prototype, 'ApplicationCommand', [
  'permissions', 'edit', 'delete', 'fetch', 'setName', 'setDescription', 'setOptions', 'setDefaultMemberPermissions',
  'setDMPermission', 'setNameLocalizations', 'setDescriptionLocalizations', 'equals', 'createdAt', 'createdTimestamp',
]);

/** `client.application.commands`. */
export class ApplicationCommandManager {
  declare readonly client: Client;
  readonly cache = new Collection<string, ApplicationCommand>();

  /** @internal */
  constructor(client: Client) {
    Object.defineProperty(this, 'client', { value: client, enumerable: false });
  }

  /** @internal The commands GhostLink has for this bot (welcome, commands.updated, commands.set). */
  _replace(commands: readonly BotCommand[]): Collection<string, ApplicationCommand> {
    this.cache.clear();
    for (const c of commands) this.cache.set(c.name, new ApplicationCommand(this.client, c));
    return this.cache.clone();
  }

  /**
   * Replaces all of the bot's slash commands (GhostLink `commands.set`). Takes SlashCommandBuilders,
   * their `toJSON()`, or discord.js command data. The second argument (a guild) is accepted for
   * code written for guild commands: a bot belongs to one GhostLink server.
   */
  async set(commands: readonly ApplicationCommandDataResolvable[], _guildId?: string): Promise<Collection<string, ApplicationCommand>> {
    if (!Array.isArray(commands)) throw new TypeError('commands.set takes a list of commands');
    const res = await this.client._request<{ commands?: unknown[] }>('commands.set', { commands: commands.map((c) => toGhostLinkCommand(c)) });
    const saved = (res.commands ?? []).flatMap((c) => {
      const parsed = botCommandSchemaClient.safeParse(c);
      return parsed.success ? [parsed.data] : [];
    });
    return this._replace(saved);
  }

  /** The bot's commands, as GhostLink has them. */
  async fetch(): Promise<Collection<string, ApplicationCommand>> {
    return this.cache.clone();
  }
}
unsupportedMembers(ApplicationCommandManager.prototype, 'ApplicationCommandManager', ['create', 'edit', 'delete', 'permissions', 'resolve', 'resolveId']);

/** `client.application`: the bot, as an application. `id` is the bot's user id. */
export class ClientApplication {
  declare readonly client: Client;
  readonly id: string;
  readonly commands: ApplicationCommandManager;

  /** @internal */
  constructor(client: Client) {
    Object.defineProperty(this, 'client', { value: client, enumerable: false });
    this.id = client._selfId();
    this.commands = new ApplicationCommandManager(client);
  }

  get name(): string {
    return this.client._selfName();
  }
}
unsupportedMembers(ClientApplication.prototype, 'ClientApplication', [
  'fetch', 'owner', 'description', 'icon', 'iconURL', 'coverURL', 'flags', 'approximateGuildCount', 'botPublic', 'botRequireCodeGrant',
  'emojis', 'entitlements', 'edit', 'fetchRoleConnectionMetadataRecords', 'editRoleConnectionMetadataRecords', 'fetchSKUs',
]);
