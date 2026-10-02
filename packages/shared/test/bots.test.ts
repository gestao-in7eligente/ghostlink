import { describe, expect, it } from 'vitest';
import {
  BOT_LIMITS,
  FEATURE_BOTS,
  avatarClearSchema,
  avatarUploadBeginSchema,
  botCommandsSchemaClient,
  botCreateResultSchemaClient,
  botCreateSchema,
  botHelloSchema,
  botsWelcomeSchemaClient,
  commandsSetSchema,
  formatBotConnectionCode,
  helloSchema,
  interactionCreateEventSchemaClient,
  interactionEphemeralEventSchemaClient,
  interactionInvokeSchema,
  interactionRespondSchema,
  isBotHello,
  isErrorCode,
  memberSchemaClient,
  messageSchemaClient,
  parseBotConnectionCode,
  welcomeSchemaClient,
} from '../src/index.js';

const USER = 'a'.repeat(32);
const BOT = 'b'.repeat(32);
const CHANNEL = 'A'.repeat(26);
const KEY = 'K'.repeat(43);
const TOKEN = 'T'.repeat(42) + '_';

describe('bots contract', () => {
  it('names the feature flag, the limits and the new error codes (spec §1, §2)', () => {
    expect(FEATURE_BOTS).toBe('bots');
    expect(BOT_LIMITS.maxCommands).toBe(100);
    expect(BOT_LIMITS.firstResponseMs).toBe(3_000);
    expect(BOT_LIMITS.responseWindowMs).toBe(15 * 60_000);
    expect(BOT_LIMITS.invokesPerChannelPerSecond).toBe(5);
    expect(BOT_LIMITS.messageRateMultiplier).toBe(2);
    expect(isErrorCode('BAD_BOT_TOKEN')).toBe(true);
    expect(isErrorCode('BOT_OFFLINE')).toBe(true);
  });

  it('formats and parses the connection code, refusing anything else', () => {
    const code = formatBotConnectionCode({ host: 'example.com', port: 7700, serverKeyId: KEY, token: TOKEN });
    expect(code).toBe(`ghostlink-bot://example.com:7700?pin=${KEY}&token=${TOKEN}`);
    expect(parseBotConnectionCode(`  ${code}\n`)).toEqual({ host: 'example.com', port: 7700, serverKeyId: KEY, token: TOKEN });
    expect(parseBotConnectionCode(formatBotConnectionCode({ host: '::1', port: 9000, serverKeyId: KEY, token: TOKEN }))).toEqual({
      host: '::1', port: 9000, serverKeyId: KEY, token: TOKEN,
    });
    for (const bad of [
      '', 'ghostlink://example.com', `ghostlink-bot://example.com:7700?pin=${KEY}`, `ghostlink-bot://example.com:7700?pin=x&token=${TOKEN}`,
      `ghostlink-bot://exa mple.com?pin=${KEY}&token=${TOKEN}`, `https://example.com?pin=${KEY}&token=${TOKEN}`,
    ]) {
      expect(parseBotConnectionCode(bad), bad).toBeNull();
    }
  });

  it('tells a bot hello apart and validates it strictly; a person hello is unchanged', () => {
    const hello = { protocol: 1, bot: TOKEN, client: 'discord-compat/0.4.0' };
    expect(isBotHello(hello)).toBe(true);
    expect(isBotHello({ protocol: 1, publicKey: KEY })).toBe(false);
    expect(isBotHello(null)).toBe(false);
    expect(botHelloSchema.parse(hello)).toEqual(hello);
    expect(botHelloSchema.parse({ ...hello, locale: 'pt-BR' })).toEqual({ ...hello, locale: 'pt-BR' });
    expect(botHelloSchema.safeParse({ ...hello, bot: 'short' }).success).toBe(false);
    expect(botHelloSchema.safeParse({ ...hello, inviteCode: 'ABCDEFGHJK' }).success).toBe(false);
    expect(botHelloSchema.safeParse({ ...hello, publicKey: KEY }).success).toBe(false);
    expect(helloSchema.safeParse({ ...hello, publicKey: KEY, nickname: 'x', locale: 'en' }).success).toBe(false);
  });

  it('bot.create takes a name; a bot photo and its clear take an optional botId', () => {
    expect(botCreateSchema.parse({ name: 'Hermes' })).toEqual({ name: 'Hermes' });
    expect(botCreateSchema.safeParse({ name: '' }).success).toBe(false);
    expect(avatarUploadBeginSchema.parse({ purpose: 'avatar', size: 10, sha256: 'a'.repeat(64), botId: BOT }).botId).toBe(BOT);
    expect(avatarClearSchema.parse({})).toEqual({});
    expect(avatarClearSchema.safeParse({ botId: 'nope' }).success).toBe(false);
  });

  describe('commands.set', () => {
    const ping = { name: 'ping', description: 'Pong!' };

    it('fills required and options with their defaults', () => {
      const parsed = commandsSetSchema.parse({
        commands: [ping, { name: 'say', description: 'Say it', options: [{ name: 'text', description: 'What', type: 'string', required: true }, { name: 'n', description: 'Times', type: 'integer', choices: [{ name: 'one', value: 1 }] }] }],
      });
      expect(parsed.commands[0]).toEqual({ ...ping, options: [] });
      expect(parsed.commands[1]!.options.map((o) => o.required)).toEqual([true, false]);
    });

    it.each([
      ['an upper-case name', { commands: [{ ...ping, name: 'Ping' }] }],
      ['a long name', { commands: [{ ...ping, name: 'a'.repeat(33) }] }],
      ['an empty description', { commands: [{ ...ping, description: '' }] }],
      ['duplicate commands', { commands: [ping, ping] }],
      ['too many commands', { commands: Array.from({ length: 101 }, (_, i) => ({ ...ping, name: `c${i}` })) }],
      ['an unknown option type', { commands: [{ ...ping, options: [{ name: 'x', description: 'x', type: 'role' }] }] }],
      ['duplicate options', { commands: [{ ...ping, options: [{ name: 'x', description: 'x', type: 'string' }, { name: 'x', description: 'x', type: 'string' }] }] }],
      ['a required option after an optional one', { commands: [{ ...ping, options: [{ name: 'a', description: 'a', type: 'string' }, { name: 'b', description: 'b', type: 'string', required: true }] }] }],
      ['choices on a boolean', { commands: [{ ...ping, options: [{ name: 'a', description: 'a', type: 'boolean', choices: [{ name: 'y', value: 'y' }] }] }] }],
      ['a string choice on an integer', { commands: [{ ...ping, options: [{ name: 'a', description: 'a', type: 'integer', choices: [{ name: 'y', value: 'y' }] }] }] }],
      ['a fractional choice on an integer', { commands: [{ ...ping, options: [{ name: 'a', description: 'a', type: 'integer', choices: [{ name: 'y', value: 1.5 }] }] }] }],
      ['an unknown key', { commands: [{ ...ping, nsfw: true }] }],
    ])('refuses %s', (_, payload) => {
      expect(commandsSetSchema.safeParse(payload).success).toBe(false);
    });
  });

  it('interaction requests are strict; a reply needs content and a defer has none', () => {
    expect(interactionInvokeSchema.parse({ channelId: CHANNEL, botId: BOT, command: 'ping' })).toEqual({ channelId: CHANNEL, botId: BOT, command: 'ping', options: [] });
    expect(interactionInvokeSchema.safeParse({ channelId: CHANNEL, botId: BOT, command: 'ping', options: [{ name: 'x', value: null }] }).success).toBe(false);
    expect(interactionRespondSchema.parse({ id: CHANNEL, type: 'reply', content: 'Pong', ephemeral: true }).type).toBe('reply');
    expect(interactionRespondSchema.safeParse({ id: CHANNEL, type: 'reply' }).success).toBe(false);
    expect(interactionRespondSchema.safeParse({ id: CHANNEL, type: 'defer', content: 'x' }).success).toBe(false);
    expect(interactionRespondSchema.safeParse({ id: CHANNEL, type: 'update', content: 'x' }).success).toBe(false);
  });

  describe('client schemas', () => {
    const member = { userId: USER, nickname: 'Ana', roleIds: [], online: true, joinedAt: 1, avatar: null };

    it('read Member.bot, defaulting to false for servers before bots', () => {
      expect(memberSchemaClient.parse(member).bot).toBe(false);
      expect(memberSchemaClient.parse({ ...member, bot: true }).bot).toBe(true);
      expect(memberSchemaClient.parse({ ...member, bot: 'yes' }).bot).toBe(false);
    });

    it('read a message with an interaction, and an old one without', () => {
      const message = {
        id: 1, channelId: CHANNEL, authorId: BOT, content: 'Pong', createdAt: 1, editedAt: null, replyTo: null, reactions: [],
        mentions: { users: [], roles: [], everyone: false }, clientMsgId: null, attachments: [],
      };
      expect(messageSchemaClient.parse(message)).toEqual({ ...message, authorBot: false, interaction: null });
      const answer = { ...message, authorBot: true, interaction: { id: CHANNEL, userId: USER, command: 'ping' } };
      expect(messageSchemaClient.parse(answer)).toEqual(answer);
      expect(messageSchemaClient.parse({ ...answer, interaction: { userId: 7 } }).interaction).toBeNull();
    });

    it('read self.bot in the welcome, the bot list, the commands and the interaction events', () => {
      const welcome = {
        self: { userId: BOT, nickname: 'Hermes', isOwner: false, bot: true }, sessionId: 's', serverTime: 1,
        server: { name: 'S', version: '0.4.0', joinMode: 'invite', serverKeyId: KEY }, features: ['bots'], fileToken: 'f', protocol: { min: 1, max: 1 },
      };
      expect(welcomeSchemaClient.parse(welcome).self.bot).toBe(true);
      const created = botCreateResultSchemaClient.parse({ bot: { userId: BOT, name: 'Hermes', avatar: null, createdBy: USER, createdAt: 5 }, connectionToken: 'ghostlink-bot://x' });
      expect(created.bot.name).toBe('Hermes');
      const commands = { botId: BOT, commands: [{ name: 'ping', description: 'Pong', options: [{ name: 'x', description: 'x', type: 'string', required: true }] }] };
      expect(botCommandsSchemaClient.parse(commands)).toEqual(commands);
      expect(botsWelcomeSchemaClient.parse({})).toEqual({ botCommands: [] });
      const create = { id: CHANNEL, channelId: CHANNEL, user: { ...member, bot: false }, command: 'ping', options: [{ name: 'x', type: 'string', value: 'hi' }], createdAt: 9 };
      expect(interactionCreateEventSchemaClient.parse(create)).toEqual(create);
      const eph = { id: CHANNEL, interactionId: CHANNEL, channelId: CHANNEL, botId: BOT, command: 'ping', content: 'só você', createdAt: 1, editedAt: null };
      expect(interactionEphemeralEventSchemaClient.parse(eph)).toEqual(eph);
    });
  });
});
