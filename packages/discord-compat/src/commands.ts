/**
 * Slash command definitions between discord.js and GhostLink (bots spec §2, §4). A bot hands
 * builders, Discord's JSON (`builder.toJSON()`, REST bodies) or discord.js's camelCase
 * ApplicationCommandData; GhostLink's `commands.set` takes `{ name, description, options }` with
 * options of type string, integer, number, boolean, user or channel. Anything that would change
 * the command (subcommands, permissions, autocomplete, min/max, localizations) throws
 * GhostLinkUnsupported rather than being dropped.
 */
import type { BotCommand, CommandOption, CommandOptionType } from '@ghostlink/shared';
import { ApplicationCommandOptionType, ApplicationCommandType } from './enums.js';
import { GhostLinkUnsupported } from './errors.js';

export interface APIApplicationCommandOptionChoice {
  name: string;
  value: string | number;
  name_localizations?: Record<string, string> | null;
}

/** Discord's JSON for a command option, as SlashCommand*Option.toJSON() returns it. */
export interface APIApplicationCommandOption {
  type: ApplicationCommandOptionType;
  name: string;
  description: string;
  required?: boolean;
  choices?: APIApplicationCommandOptionChoice[];
  autocomplete?: boolean;
  name_localizations?: Record<string, string> | null;
  description_localizations?: Record<string, string> | null;
}

/** Discord's JSON for a chat input command, as SlashCommandBuilder.toJSON() returns it. */
export interface RESTPostAPIChatInputApplicationCommandsJSONBody {
  name: string;
  description: string;
  options?: APIApplicationCommandOption[];
  type?: ApplicationCommandType.ChatInput;
  name_localizations?: Record<string, string> | null;
  description_localizations?: Record<string, string> | null;
  default_member_permissions?: string | null;
  dm_permission?: boolean;
  default_permission?: boolean;
  nsfw?: boolean;
}

/** A registered command as Discord returns it (REST put/get). */
export interface APIApplicationCommand extends RESTPostAPIChatInputApplicationCommandsJSONBody {
  id: string;
  application_id: string;
  version: string;
  type: ApplicationCommandType.ChatInput;
  options: APIApplicationCommandOption[];
}

/** discord.js's camelCase command data (`commands.set([{ name, description, options }])`). */
export interface ChatInputApplicationCommandData {
  name: string;
  description: string;
  type?: ApplicationCommandType.ChatInput;
  options?: readonly {
    type: ApplicationCommandOptionType;
    name: string;
    description: string;
    required?: boolean;
    choices?: readonly { name: string; value: string | number }[];
  }[];
  dmPermission?: false;
  nsfw?: false;
}

/** What `commands.set()` and REST bodies accept. */
export type ApplicationCommandDataResolvable =
  | { toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody }
  | RESTPostAPIChatInputApplicationCommandsJSONBody
  | ChatInputApplicationCommandData;

const FROM_DISCORD: Readonly<Partial<Record<number, CommandOptionType>>> = {
  [ApplicationCommandOptionType.String]: 'string',
  [ApplicationCommandOptionType.Integer]: 'integer',
  [ApplicationCommandOptionType.Number]: 'number',
  [ApplicationCommandOptionType.Boolean]: 'boolean',
  [ApplicationCommandOptionType.User]: 'user',
  [ApplicationCommandOptionType.Channel]: 'channel',
};

/** @internal */
export const TO_DISCORD: Readonly<Record<CommandOptionType, ApplicationCommandOptionType>> = {
  string: ApplicationCommandOptionType.String,
  integer: ApplicationCommandOptionType.Integer,
  number: ApplicationCommandOptionType.Number,
  boolean: ApplicationCommandOptionType.Boolean,
  user: ApplicationCommandOptionType.User,
  channel: ApplicationCommandOptionType.Channel,
};

const isEmpty = (v: unknown) => v === undefined || v === null || (typeof v === 'object' && Object.keys(v).length === 0);

/** Keys GhostLink has no use for, accepted only with a value that changes nothing. */
const COMMAND_NEUTRAL: Readonly<Record<string, (v: unknown) => boolean>> = {
  type: (v) => v === ApplicationCommandType.ChatInput,
  name_localizations: isEmpty,
  nameLocalizations: isEmpty,
  description_localizations: isEmpty,
  descriptionLocalizations: isEmpty,
  default_member_permissions: isEmpty,
  defaultMemberPermissions: isEmpty,
  default_permission: (v) => v === true,
  defaultPermission: (v) => v === true,
  // No direct messages with bots on GhostLink: "not in DMs" is what happens anyway.
  dm_permission: (v) => v === false,
  dmPermission: (v) => v === false,
  nsfw: (v) => v === false,
  contexts: isEmpty,
  integration_types: isEmpty,
  integrationTypes: isEmpty,
  // Echoed back from a fetched command.
  id: () => true,
  application_id: () => true,
  applicationId: () => true,
  version: () => true,
  guild_id: () => true,
  guildId: () => true,
};

const OPTION_NEUTRAL: Readonly<Record<string, (v: unknown) => boolean>> = {
  name_localizations: isEmpty,
  nameLocalizations: isEmpty,
  description_localizations: isEmpty,
  descriptionLocalizations: isEmpty,
  autocomplete: (v) => v === false,
};

function text(where: string, value: unknown): string {
  if (typeof value !== 'string') throw new TypeError(`${where} must be a string`);
  return value;
}

function option(command: string, raw: unknown): CommandOption {
  if (typeof raw !== 'object' || raw === null) throw new TypeError(`/${command}: an option must be an object`);
  const o = raw as Record<string, unknown>;
  const type = typeof o.type === 'number' ? FROM_DISCORD[o.type] : undefined;
  const name = text(`/${command} option name`, o.name);
  if (type === undefined) {
    const kind = typeof o.type === 'number' ? (ApplicationCommandOptionType[o.type] ?? String(o.type)) : String(o.type);
    throw new GhostLinkUnsupported(`ApplicationCommandOptionType.${kind}`, `option "${name}" of /${command}`);
  }
  const out: CommandOption = { name, description: text(`/${command} ${name} description`, o.description), type, required: o.required === true };
  for (const [key, value] of Object.entries(o)) {
    if (['type', 'name', 'description', 'required', 'choices'].includes(key) || value === undefined || value === null) continue;
    if (!OPTION_NEUTRAL[key]?.(value)) throw new GhostLinkUnsupported(`command option ${key}`, `option "${name}" of /${command}`);
  }
  if (o.choices !== undefined && o.choices !== null) {
    if (!Array.isArray(o.choices)) throw new TypeError(`/${command} ${name} choices must be a list`);
    if (o.choices.length > 0) {
      out.choices = o.choices.map((c: unknown) => {
        const choice = c as { name?: unknown; value?: unknown };
        if (typeof choice.value !== 'string' && typeof choice.value !== 'number') throw new TypeError(`/${command} ${name}: a choice value must be a string or a number`);
        return { name: text(`/${command} ${name} choice name`, choice.name), value: choice.value };
      });
    }
  }
  return out;
}

/** One command as GhostLink's `commands.set` takes it. @internal */
export function toGhostLinkCommand(input: unknown): BotCommand {
  const raw = typeof input === 'object' && input !== null && typeof (input as { toJSON?: unknown }).toJSON === 'function'
    ? (input as { toJSON(): unknown }).toJSON()
    : input;
  if (typeof raw !== 'object' || raw === null) throw new TypeError('a command must be a SlashCommandBuilder or its JSON');
  const c = raw as Record<string, unknown>;
  const name = text('command name', c.name);
  if (c.type !== undefined && c.type !== null && c.type !== ApplicationCommandType.ChatInput) {
    const kind = typeof c.type === 'number' ? (ApplicationCommandType[c.type] ?? String(c.type)) : String(c.type);
    throw new GhostLinkUnsupported(`ApplicationCommandType.${kind}`, `command "${name}": only slash commands exist on GhostLink`);
  }
  for (const [key, value] of Object.entries(c)) {
    if (['name', 'description', 'options'].includes(key) || value === undefined || value === null) continue;
    if (!COMMAND_NEUTRAL[key]?.(value)) throw new GhostLinkUnsupported(`command ${key}`, `/${name}`);
  }
  const options = c.options === undefined || c.options === null ? [] : c.options;
  if (!Array.isArray(options)) throw new TypeError(`/${name} options must be a list`);
  return { name, description: text(`/${name} description`, c.description), options: options.map((o: unknown) => option(name, o)) };
}

/** A GhostLink command as Discord's JSON. @internal */
export function toDiscordCommand(command: BotCommand, applicationId: string): APIApplicationCommand {
  return {
    id: command.name,
    application_id: applicationId,
    version: '1',
    type: ApplicationCommandType.ChatInput,
    name: command.name,
    description: command.description,
    default_member_permissions: null,
    dm_permission: false,
    nsfw: false,
    options: command.options.map((o) => ({
      type: TO_DISCORD[o.type],
      name: o.name,
      description: o.description,
      required: o.required,
      ...(o.choices ? { choices: o.choices.map((c) => ({ name: c.name, value: c.value })) } : {}),
    })),
  };
}
