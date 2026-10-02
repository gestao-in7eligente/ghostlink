/**
 * Bots (spec 2026-10-02-bots-design.md §2): accounts the server creates, which connect with a
 * connection code instead of an identity, read and send messages like members, and answer
 * slash commands. Payloads, events, results, strict server schemas and lenient client schemas.
 *
 * Handshake: a bot's `hello` is `BotHelloPayload` (protocol.ts, `botHelloSchema` in schemas.ts):
 * `{ protocol, bot: <token>, client, locale? }`. No challenge: the server answers `welcome`
 * (with `self.bot: true`) or closes with BAD_BOT_TOKEN. Failures count toward the same per-IP
 * auth-failure limit as a person's handshake.
 *
 * Requests (MANAGE_SERVER):
 *   - `bot.create { name }` → `BotCreateResult` (the connection code appears only here);
 *   - `bot.regenerate { botId }` → `BotRegenerateResult` (the old code stops working and the
 *     bot's session is closed with BAD_BOT_TOKEN);
 *   - `bot.delete { botId }` → `{}` (the member leaves with `member.left`; its messages stay,
 *     with `authorBot: true`);
 *   - `bot.list {}` → `BotListResult`.
 *   A bot's photo goes through the avatar upload with `botId` (avatar.ts).
 *
 * Slash commands:
 *   - `commands.set { commands }` (bots only) → `{ commands }`; everyone connected gets
 *     `commands.updated` (`BotCommands`); the welcome's `botCommands` lists every bot's.
 *   - `interaction.invoke { channelId, botId, command, options }` (SEND_MESSAGES in the channel,
 *     and the bot must see it) → `{ id }`; the bot alone gets `interaction.create`.
 *     BOT_OFFLINE when the bot has no session; NOT_FOUND for an unknown bot or command.
 *   - The bot answers within `BOT_LIMITS.firstResponseMs` with `interaction.respond`
 *     (`reply` or `defer`), then may `interaction.edit` the answer and `interaction.followup`
 *     for `BOT_LIMITS.responseWindowMs`. Each returns `InteractionResult`. NOT_FOUND once the
 *     interaction expired or is not this bot's; BAD_REQUEST when answered twice, or edited /
 *     followed up before an answer.
 *   - A public answer is a bot message (`msg.new`) with `interaction: { id, userId, command }`;
 *     an ephemeral one is the `interaction.ephemeral` event to the invoker's sessions only, never
 *     stored. A `defer` sends `interaction.thinking` (to the channel, or to the invoker when
 *     ephemeral) until the edit. No answer in time: `interaction.failed` ("the bot did not
 *     respond") to the invoker, or, for a defer never edited, to whoever saw it thinking.
 */
import { z } from 'zod';
import { CHAT_LIMITS, entityIdSchema, memberSchemaClient, messageSchemaClient, userIdSchema, type Member, type Message } from './chat.js';
import { formatHostPort, parseHostPort } from './invite.js';

/** The `features` flag of a server that has bots (spec §1: servers before 0.4.0 have none). */
export const FEATURE_BOTS = 'bots';

export const BOT_LIMITS = {
  /** The connection token's secret: 256 random bits (b64url, 43 characters). */
  tokenBytes: 32,
  /** Bots per server. */
  maxBots: 50,
  /** Slash commands per bot. */
  maxCommands: 100,
  /** Options per command, and choices per option (as in Discord). */
  maxOptions: 25,
  maxChoices: 25,
  /** Command, option and choice descriptions/names (as in Discord). */
  descriptionMax: 100,
  choiceNameMax: 100,
  /** A string option's value as typed by the invoker. */
  optionValueMax: CHAT_LIMITS.messageMaxLength,
  /** The bot's first answer (`reply` or `defer`) to an interaction. */
  firstResponseMs: 3_000,
  /** After the first answer, edits and follow-ups are accepted for this long. */
  responseWindowMs: 15 * 60_000,
  /** `interaction.invoke` per channel per second (spec §2). */
  invokesPerChannelPerSecond: 5,
  /** A bot's messages (and answers) use the members' msg.send limit times this (spec §2). */
  messageRateMultiplier: 2,
  /** `bot.create`, `bot.regenerate` and `bot.delete` together, per manager per window. */
  managePerWindow: 10,
  manageWindowMs: 60_000,
  /** `commands.set` per bot per window. */
  commandsSetPerWindow: 10,
  commandsSetWindowMs: 60_000,
} as const;

/** `^[a-z0-9_-]{1,32}$` (spec §2): command and option names. */
export const COMMAND_NAME = /^[a-z0-9_-]{1,32}$/;

export const COMMAND_OPTION_TYPES = ['string', 'integer', 'number', 'boolean', 'user', 'channel'] as const;
export type CommandOptionType = (typeof COMMAND_OPTION_TYPES)[number];

// ---- the connection code ----

/** `ghostlink-bot://<host:port>?pin=<serverKeyId>&token=<secret>` (spec §1). */
export const BOT_CODE_SCHEME = 'ghostlink-bot';

export interface BotConnectionCode {
  host: string;
  port: number;
  /** The server's TLS key pin (b64url SHA-256, as in invites). */
  serverKeyId: string;
  /** The secret the bot sends as `hello.bot`. */
  token: string;
}

const B64U_32 = /^[A-Za-z0-9_-]{43}$/;

export function formatBotConnectionCode(c: BotConnectionCode): string {
  return `${BOT_CODE_SCHEME}://${formatHostPort(c.host, c.port)}?pin=${c.serverKeyId}&token=${c.token}`;
}

/** Reads a connection code (surrounding spaces allowed); null when it is not one. */
export function parseBotConnectionCode(input: string): BotConnectionCode | null {
  if (typeof input !== 'string' || input.length > 1024) return null;
  const s = input.trim();
  const prefix = `${BOT_CODE_SCHEME}://`;
  if (!s.toLowerCase().startsWith(prefix)) return null;
  const rest = s.slice(prefix.length);
  const q = rest.indexOf('?');
  if (q < 0) return null;
  const authority = rest.slice(0, q).replace(/\/$/, '');
  const params = new URLSearchParams(rest.slice(q + 1));
  const serverKeyId = params.get('pin') ?? '';
  const token = params.get('token') ?? '';
  if (!B64U_32.test(serverKeyId) || !B64U_32.test(token)) return null;
  try {
    const { host, port } = parseHostPort(authority);
    return { host, port, serverKeyId, token };
  } catch {
    return null;
  }
}

// ---- bot management (MANAGE_SERVER) ----

/** A bot as `bot.create` and `bot.list` show it; `userId` is its member id. */
export interface BotInfo {
  userId: string;
  name: string;
  /** The photo's SHA-256 (hex), or null: initials. */
  avatar: string | null;
  createdBy: string | null;
  createdAt: number;
}

export interface BotCreatePayload {
  /** Cleaned like a nickname (1–32 visible characters, unique among members: NICK_TAKEN). */
  name: string;
}

export interface BotCreateResult {
  bot: BotInfo;
  /** The full connection code (`formatBotConnectionCode`). Shown once: the server keeps only a hash. */
  connectionToken: string;
}

export interface BotRegenerateResult {
  connectionToken: string;
}

export interface BotListResult {
  bots: BotInfo[];
}

// ---- slash commands ----

export interface CommandChoice {
  name: string;
  /** A string for `string` options, an integer for `integer`, a number for `number`. */
  value: string | number;
}

export interface CommandOption {
  name: string;
  description: string;
  type: CommandOptionType;
  /** Required options come before optional ones. Omitted in `commands.set`: false. */
  required: boolean;
  /** Only for `string`, `integer` and `number`. */
  choices?: CommandChoice[];
}

export interface BotCommand {
  name: string;
  description: string;
  options: CommandOption[];
}

/** One bot's commands: the `commands.updated` event and each entry of the welcome's `botCommands`. */
export interface BotCommands {
  botId: string;
  commands: BotCommand[];
}

/** Welcome keys added by the bots module. */
export interface BotsWelcome {
  botCommands: BotCommands[];
}

// ---- interactions ----

export type InteractionOptionValue = string | number | boolean;

/** An option as the invoker sends it: `user` takes a member's userId, `channel` a channel id. */
export interface InteractionOptionInput {
  name: string;
  value: InteractionOptionValue;
}

/** An option as the bot receives it, with the type from the command. */
export interface InteractionOption extends InteractionOptionInput {
  type: CommandOptionType;
}

export interface InteractionInvokePayload {
  channelId: string;
  botId: string;
  command: string;
  options: InteractionOptionInput[];
}

export interface InteractionInvokeResult {
  /** The interaction's id; events about it carry it. */
  id: string;
}

/** `interaction.create` event, to the bot's session only. */
export interface InteractionCreateEvent {
  id: string;
  channelId: string;
  /** The member who used the command, as stored now. */
  user: Member;
  command: string;
  options: InteractionOption[];
  createdAt: number;
}

export type InteractionRespondPayload =
  | { id: string; type: 'reply'; content: string; ephemeral?: boolean }
  | { id: string; type: 'defer'; ephemeral?: boolean };

export interface InteractionEditPayload {
  id: string;
  content: string;
}

export interface InteractionFollowupPayload {
  id: string;
  content: string;
  ephemeral?: boolean;
}

/** The answer to `interaction.respond`, `interaction.edit` and `interaction.followup`: the public message, or null. */
export interface InteractionResult {
  message: Message | null;
}

/** `interaction.thinking` event: "<bot> is thinking…" until the answer arrives. */
export interface InteractionThinkingEvent {
  id: string;
  channelId: string;
  botId: string;
  userId: string;
  command: string;
  /** True: only the invoker got this event. */
  ephemeral: boolean;
}

/**
 * `interaction.ephemeral` event, to the invoker's sessions only, never stored: "only you can see
 * this". `id` equals `interactionId` for the answer itself (an edit sends it again with the same
 * id, to replace it) and is new for each follow-up.
 */
export interface InteractionEphemeralEvent {
  id: string;
  interactionId: string;
  channelId: string;
  botId: string;
  command: string;
  content: string;
  createdAt: number;
  editedAt: number | null;
}

/** `interaction.failed` event: "the bot did not respond". */
export interface InteractionFailedEvent {
  id: string;
  channelId: string;
  botId: string;
  userId: string;
  command: string;
}

// ---- server side: strict (spec §5.1) ----

const commandName = z.string().regex(COMMAND_NAME);
const description = z.string().min(1).max(BOT_LIMITS.descriptionMax);
const content = z.string().max(CHAT_LIMITS.messageMaxLength);

/** The token's secret as sent in `hello.bot`. */
export const botTokenSchema = z.string().regex(B64U_32);

export const botCreateSchema = z.strictObject({ name: z.string().min(1).max(64) });
export const botRegenerateSchema = z.strictObject({ botId: userIdSchema });
export const botDeleteSchema = z.strictObject({ botId: userIdSchema });
export const botListSchema = z.strictObject({});

const commandChoiceSchema = z.strictObject({
  name: z.string().min(1).max(BOT_LIMITS.choiceNameMax),
  value: z.union([z.string().min(1).max(BOT_LIMITS.choiceNameMax), z.number().finite()]),
});

const commandOptionSchema = z.strictObject({
  name: commandName,
  description,
  type: z.enum(COMMAND_OPTION_TYPES),
  required: z.boolean().default(false),
  choices: z.array(commandChoiceSchema).min(1).max(BOT_LIMITS.maxChoices).optional(),
});

function choiceFits(type: CommandOptionType, value: string | number): boolean {
  if (type === 'string') return typeof value === 'string';
  if (type === 'integer') return typeof value === 'number' && Number.isSafeInteger(value);
  if (type === 'number') return typeof value === 'number';
  return false;
}

export const botCommandSchema = z
  .strictObject({
    name: commandName,
    description,
    options: z.array(commandOptionSchema).max(BOT_LIMITS.maxOptions).default([]),
  })
  .superRefine((cmd, ctx) => {
    const names = new Set<string>();
    let optionalSeen = false;
    cmd.options.forEach((o, i) => {
      if (names.has(o.name)) ctx.addIssue({ code: 'custom', path: ['options', i, 'name'], message: 'duplicate option name' });
      names.add(o.name);
      if (o.required && optionalSeen) ctx.addIssue({ code: 'custom', path: ['options', i, 'required'], message: 'required options come first' });
      if (!o.required) optionalSeen = true;
      if (o.choices?.some((c) => !choiceFits(o.type, c.value))) {
        ctx.addIssue({ code: 'custom', path: ['options', i, 'choices'], message: `choices do not fit a ${o.type} option` });
      }
    });
  });

export const commandsSetSchema = z
  .strictObject({ commands: z.array(botCommandSchema).max(BOT_LIMITS.maxCommands) })
  .superRefine((p, ctx) => {
    const names = new Set<string>();
    p.commands.forEach((c, i) => {
      if (names.has(c.name)) ctx.addIssue({ code: 'custom', path: ['commands', i, 'name'], message: 'duplicate command name' });
      names.add(c.name);
    });
  });

export const interactionInvokeSchema = z.strictObject({
  channelId: entityIdSchema,
  botId: userIdSchema,
  command: commandName,
  options: z
    .array(
      z.strictObject({
        name: commandName,
        value: z.union([z.string().max(BOT_LIMITS.optionValueMax), z.number().finite(), z.boolean()]),
      }),
    )
    .max(BOT_LIMITS.maxOptions)
    .default([]),
});

export const interactionIdSchema = entityIdSchema;

export const interactionRespondSchema = z.discriminatedUnion('type', [
  z.strictObject({ id: interactionIdSchema, type: z.literal('reply'), content, ephemeral: z.boolean().optional() }),
  z.strictObject({ id: interactionIdSchema, type: z.literal('defer'), ephemeral: z.boolean().optional() }),
]);
export const interactionEditSchema = z.strictObject({ id: interactionIdSchema, content });
export const interactionFollowupSchema = z.strictObject({ id: interactionIdSchema, content, ephemeral: z.boolean().optional() });

// ---- client side: z.object drops unknown keys ----

const idClient = z.string().min(1).max(64);
const commandNameClient = z.string().min(1).max(64);
const textClient = z.string().max(1024);

export const botInfoSchemaClient: z.ZodType<BotInfo> = z.object({
  userId: idClient,
  name: z.string().max(256),
  avatar: z.string().regex(/^[0-9a-f]{64}$/).nullable().catch(null),
  createdBy: idClient.nullable().catch(null),
  createdAt: z.number().catch(0),
});

export const botCreateResultSchemaClient: z.ZodType<BotCreateResult> = z.object({
  bot: botInfoSchemaClient,
  connectionToken: z.string().min(1).max(1024),
});

export const botRegenerateResultSchemaClient: z.ZodType<BotRegenerateResult> = z.object({ connectionToken: z.string().min(1).max(1024) });

export const botListResultSchemaClient: z.ZodType<BotListResult> = z.object({ bots: z.array(botInfoSchemaClient).max(1000) });

const commandOptionSchemaClient: z.ZodType<CommandOption> = z.object({
  name: commandNameClient,
  description: textClient.catch(''),
  type: z.enum(COMMAND_OPTION_TYPES),
  required: z.boolean().catch(false),
  choices: z
    .array(z.object({ name: textClient, value: z.union([z.string().max(1024), z.number()]) }))
    .max(100)
    .optional()
    .catch(undefined),
});

export const botCommandSchemaClient: z.ZodType<BotCommand> = z.object({
  name: commandNameClient,
  description: textClient.catch(''),
  options: z.array(commandOptionSchemaClient).max(100).catch([]),
});

export const botCommandsSchemaClient: z.ZodType<BotCommands> = z.object({
  botId: idClient,
  commands: z.array(botCommandSchemaClient).max(1000).catch([]),
});

export const botsWelcomeSchemaClient: z.ZodType<BotsWelcome> = z.object({
  botCommands: z.array(botCommandsSchemaClient).max(1000).catch([]),
});

export const interactionInvokeResultSchemaClient: z.ZodType<InteractionInvokeResult> = z.object({ id: idClient });

export const interactionCreateEventSchemaClient: z.ZodType<InteractionCreateEvent> = z.object({
  id: idClient,
  channelId: idClient,
  user: memberSchemaClient,
  command: commandNameClient,
  options: z
    .array(z.object({ name: commandNameClient, type: z.enum(COMMAND_OPTION_TYPES), value: z.union([z.string().max(16_384), z.number(), z.boolean()]) }))
    .max(100)
    .catch([]),
  createdAt: z.number().catch(0),
});

export const interactionResultSchemaClient: z.ZodType<InteractionResult> = z.object({ message: messageSchemaClient.nullable() });

export const interactionThinkingEventSchemaClient: z.ZodType<InteractionThinkingEvent> = z.object({
  id: idClient,
  channelId: idClient,
  botId: idClient,
  userId: idClient,
  command: commandNameClient,
  ephemeral: z.boolean().catch(false),
});

export const interactionEphemeralEventSchemaClient: z.ZodType<InteractionEphemeralEvent> = z.object({
  id: idClient,
  interactionId: idClient,
  channelId: idClient,
  botId: idClient,
  command: commandNameClient,
  content: z.string().max(CHAT_LIMITS.messageMaxLength * 2),
  createdAt: z.number(),
  editedAt: z.number().nullable().catch(null),
});

export const interactionFailedEventSchemaClient: z.ZodType<InteractionFailedEvent> = z.object({
  id: idClient,
  channelId: idClient,
  botId: idClient,
  userId: idClient,
  command: commandNameClient,
});
