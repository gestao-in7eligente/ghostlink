import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EVERYONE_PERMISSIONS,
  PERMISSIONS,
  PROTOCOL,
  botsWelcomeSchemaClient,
  memberSchemaClient,
  parseBotConnectionCode,
  type BotCreateResult,
  type ErrorCode,
  type InteractionCreateEvent,
  type Message,
} from '@ghostlink/shared';
import type { StartServerOptions } from '../src/index.js';
import { createAvatarsModule } from '../src/avatars/index.js';
import { createBotsModule, type BotsModuleOptions } from '../src/bots/index.js';
import { connectRaw } from './helpers/testClient.js';
import { channelId, nextClientMsgId, textFixture, wrapClient, type TextClient, type TextFixture } from './text/helpers.js';

const FIRST_RESPONSE_MS = 300;

async function setup(opts: { bots?: BotsModuleOptions; limits?: StartServerOptions['limits'] } = {}) {
  return textFixture({ extraModules: [createAvatarsModule(), createBotsModule({ firstResponseMs: FIRST_RESPONSE_MS, ...opts.bots })], limits: opts.limits });
}

type Bot = { client: TextClient; error?: undefined } | { client?: undefined; error: ErrorCode };

/** The bot handshake: hello with the code's token, straight to the welcome. */
async function connectBot(fx: TextFixture, code: string): Promise<Bot> {
  const parsed = parseBotConnectionCode(code);
  if (!parsed) throw new Error('not a connection code');
  const raw = await connectRaw(fx.t.server, { pin: parsed.serverKeyId });
  raw.send({ t: 'hello', d: { protocol: PROTOCOL.current, bot: parsed.token, client: 'bots-test/0.0.0' } });
  const m = await raw.next();
  if (m.t === 'error') {
    raw.close();
    return { error: (m.d as { code: ErrorCode }).code };
  }
  if (m.t !== 'welcome') throw new Error(`unexpected ${m.t}`);
  const welcome = m.d as { self: { userId: string; nickname: string } } & Record<string, unknown>;
  return { client: wrapClient(raw, welcome, { userId: welcome.self.userId, seed: new Uint8Array(32), nickname: welcome.self.nickname }) };
}

async function botOnline(fx: TextFixture, name = 'Hermes') {
  const created = await fx.owner.ok<BotCreateResult>('bot.create', { name });
  const r = await connectBot(fx, created.connectionToken);
  if (!r.client) throw new Error(`bot refused: ${r.error}`);
  return { created, bot: r.client, botId: created.bot.userId };
}

const PING = { name: 'ping', description: 'Pong!', options: [{ name: 'texto', description: 'O quê', type: 'string', required: false }] };

describe('bots: accounts and the handshake (spec §2)', () => {
  it('creates a bot member and connects it with the code; a wrong token is refused', async () => {
    const fx = await setup();
    const member = await fx.join();
    const created = await fx.owner.ok<BotCreateResult>('bot.create', { name: 'Hermes' });
    expect(created.bot).toMatchObject({ name: 'Hermes', avatar: null, createdBy: fx.owner.userId });
    const code = parseBotConnectionCode(created.connectionToken)!;
    expect(code).toMatchObject({ host: '127.0.0.1', port: fx.t.server.port, serverKeyId: fx.t.server.serverKeyId });
    const joined = await member.event<{ member: unknown }>('member.joined', (d) => memberSchemaClient.parse(d.member).userId === created.bot.userId);
    expect(memberSchemaClient.parse(joined.member)).toMatchObject({ nickname: 'Hermes', bot: true, online: false });
    expect((await fx.owner.ok<{ bots: unknown[] }>('bot.list')).bots).toEqual([created.bot]);

    const r = await connectBot(fx, created.connectionToken);
    expect(r.error).toBeUndefined();
    const bot = r.client!;
    expect(bot.welcome.self).toEqual({ userId: created.bot.userId, nickname: 'Hermes', isOwner: false, bot: true });
    expect(bot.welcome.features).toContain('bots');
    expect(bot.text.members.find((m) => m.userId === bot.userId)?.bot).toBe(true);
    expect(bot.text.channels.length).toBeGreaterThan(0);
    await member.event('presence', (d: { userId: string; online: boolean }) => d.userId === bot.userId && d.online);

    const wrong = await connectBot(fx, created.connectionToken.replace(/token=./, (t) => (t.endsWith('A') ? 'token=B' : 'token=A')));
    expect(wrong.error).toBe('BAD_BOT_TOKEN');
  });

  it('counts wrong tokens toward the per-IP auth-failure limit', async () => {
    const fx = await setup({ limits: { authFailuresPerIpPerMinute: 2 } });
    const { created } = await botOnline(fx);
    const bad = created.connectionToken.replace(/token=[^&]+/, `token=${'Z'.repeat(43)}`);
    expect((await connectBot(fx, bad)).error).toBe('BAD_BOT_TOKEN');
    expect((await connectBot(fx, bad)).error).toBe('BAD_BOT_TOKEN');
    expect((await connectBot(fx, created.connectionToken)).error).toBe('RATE_LIMITED');
  });

  it('regenerating closes the session and voids the old code; the new one works', async () => {
    const fx = await setup();
    const { created, bot, botId } = await botOnline(fx);
    const { connectionToken } = await fx.owner.ok<{ connectionToken: string }>('bot.regenerate', { botId });
    await bot.closed;
    expect(bot.closedWith).toBe('BAD_BOT_TOKEN');
    expect((await connectBot(fx, created.connectionToken)).error).toBe('BAD_BOT_TOKEN');
    expect((await connectBot(fx, connectionToken)).client?.userId).toBe(botId);
  });

  it('deleting keeps its messages as a former member, frees the name and voids the code', async () => {
    const fx = await setup();
    const member = await fx.join();
    const { created, bot, botId } = await botOnline(fx);
    const geral = channelId(fx.owner, 'geral');
    const { message } = await bot.ok<{ message: Message }>('msg.send', { channelId: geral, content: 'oi', clientMsgId: nextClientMsgId() });
    expect(message.authorBot).toBe(true);
    await fx.owner.ok('bot.delete', { botId });
    await bot.closed;
    expect(bot.closedWith).toBe('BAD_BOT_TOKEN');
    await member.event('member.left', (d: { userId: string }) => d.userId === botId);
    await member.event('commands.updated', (d: { botId: string; commands: unknown[] }) => d.botId === botId && d.commands.length === 0);
    const history = await member.ok<{ messages: Message[] }>('msg.history', { channelId: geral });
    expect(history.messages.find((m) => m.id === message.id)).toMatchObject({ authorId: botId, content: 'oi', authorBot: true });
    expect((await connectBot(fx, created.connectionToken)).error).toBe('BAD_BOT_TOKEN');
    expect((await fx.owner.ok<{ bots: unknown[] }>('bot.list')).bots).toEqual([]);
    expect((await fx.owner.ok<BotCreateResult>('bot.create', { name: 'Hermes' })).bot.userId).not.toBe(botId);
  });

  it('only MANAGE_SERVER manages bots; only bots set commands', async () => {
    const fx = await setup();
    const member = await fx.join();
    const { botId } = await botOnline(fx);
    for (const [t, d] of [['bot.create', { name: 'X' }], ['bot.list', {}], ['bot.regenerate', { botId }], ['bot.delete', { botId }]] as const) {
      expect(await member.fail(t, d), t).toBe('FORBIDDEN');
    }
    expect(await member.fail('commands.set', { commands: [] })).toBe('FORBIDDEN');
    expect(await fx.owner.fail('commands.set', { commands: [] })).toBe('FORBIDDEN');
    expect(await fx.owner.fail('bot.create', { name: 'Dono' })).toBe('NICK_TAKEN');
    expect(await fx.owner.fail('bot.delete', { botId: fx.owner.userId })).toBe('NOT_FOUND');
    expect(await fx.owner.fail('server.transferOwnership', { userId: botId })).toBe('BAD_REQUEST');
    // A bot's photo: the manager may set it, nobody else.
    const photo = { purpose: 'avatar', size: 100, sha256: 'a'.repeat(64), botId };
    expect(await member.fail('upload.begin', photo)).toBe('FORBIDDEN');
    expect(await fx.owner.ok('upload.begin', photo)).toHaveProperty('uploadToken');
  });

  it("a bot's messages get twice a member's burst", async () => {
    const fx = await setup();
    const { bot } = await botOnline(fx);
    const geral = channelId(fx.owner, 'geral');
    for (let i = 0; i < 20; i++) await bot.ok('msg.send', { channelId: geral, content: `m${i}`, clientMsgId: nextClientMsgId() });
    expect(await bot.fail('msg.send', { channelId: geral, content: 'one more', clientMsgId: nextClientMsgId() })).toBe('RATE_LIMITED');
  });
});

describe('bots: slash commands (spec §2)', () => {
  it('commands.set is validated, announced, and in the next welcome', async () => {
    const fx = await setup();
    const member = await fx.join();
    const { bot, botId } = await botOnline(fx);
    expect(await bot.fail('commands.set', { commands: [{ name: 'Ping', description: 'x' }] })).toBe('BAD_REQUEST');
    const set = await bot.ok<{ commands: unknown[] }>('commands.set', { commands: [PING] });
    const expected = [{ ...PING }];
    expect(set.commands).toEqual(expected);
    const updated = await member.event<{ botId: string; commands: unknown[] }>('commands.updated', (d) => d.botId === botId);
    expect(updated.commands).toEqual(expected);
    const later = await fx.join();
    expect(botsWelcomeSchemaClient.parse(later.welcome).botCommands).toEqual([{ botId, commands: expected }]);
  });
});

describe('bots: interactions (spec §2)', () => {
  async function ready() {
    const fx = await setup();
    const member = await fx.join();
    const other = await fx.join();
    const { bot, botId } = await botOnline(fx);
    await bot.ok('commands.set', { commands: [PING] });
    const geral = channelId(fx.owner, 'geral');
    const invoke = async (by: TextClient, options: unknown[] = []) => {
      const { id } = await by.ok<{ id: string }>('interaction.invoke', { channelId: geral, botId, command: 'ping', options });
      const created = await bot.event<InteractionCreateEvent>('interaction.create', (d) => d.id === id);
      return { id, created };
    };
    return { fx, member, other, bot, botId, geral, invoke };
  }

  it('reply: the bot alone gets the interaction; the answer is a bot message tagged with it', async () => {
    const { fx, member, other, bot, botId, geral, invoke } = await ready();
    const { id, created } = await invoke(member, [{ name: 'texto', value: 'olá' }]);
    expect(created).toMatchObject({ channelId: geral, command: 'ping', options: [{ name: 'texto', type: 'string', value: 'olá' }] });
    expect(created.user).toMatchObject({ userId: member.userId, bot: false });
    await other.sync();
    expect(other.seen('interaction.create')).toEqual([]);

    const { message } = await bot.ok<{ message: Message }>('interaction.respond', { id, type: 'reply', content: 'Pong!' });
    expect(message).toMatchObject({ authorId: botId, content: 'Pong!', authorBot: true, interaction: { id, userId: member.userId, command: 'ping' } });
    const seen = await other.event<{ message: Message }>('msg.new', (d) => d.message.id === message.id);
    expect(seen.message.interaction).toEqual({ id, userId: member.userId, command: 'ping' });
    expect(await bot.fail('interaction.respond', { id, type: 'reply', content: 'again' })).toBe('BAD_REQUEST');
    // Follow-ups reply to the answer; after 15 min the interaction is gone.
    const follow = await bot.ok<{ message: Message }>('interaction.followup', { id, content: 'mais' });
    expect(follow.message.replyTo?.id).toBe(message.id);
    expect(follow.message.interaction).toBeNull();
    fx.clock.now += 15 * 60_000 + 1;
    expect(await bot.fail('interaction.followup', { id, content: 'tarde' })).toBe('NOT_FOUND');
  });

  it('defer shows "thinking" to the channel until the edit, which posts the answer', async () => {
    const { member, other, bot, invoke } = await ready();
    const { id } = await invoke(member);
    expect(await bot.fail('interaction.edit', { id, content: 'cedo' })).toBe('BAD_REQUEST');
    expect((await bot.ok<{ message: unknown }>('interaction.respond', { id, type: 'defer' })).message).toBeNull();
    for (const c of [member, other]) {
      expect(await c.event('interaction.thinking', (d: { id: string }) => d.id === id)).toMatchObject({ userId: member.userId, command: 'ping', ephemeral: false });
    }
    const { message } = await bot.ok<{ message: Message }>('interaction.edit', { id, content: 'Pronto' });
    expect(message.interaction?.id).toBe(id);
    await other.event('msg.new', (d: { message: Message }) => d.message.id === message.id);
    const edited = await bot.ok<{ message: Message }>('interaction.edit', { id, content: 'Pronto!' });
    expect(edited.message).toMatchObject({ id: message.id, content: 'Pronto!' });
    await other.event('msg.updated', (d: { message: Message }) => d.message.id === message.id && d.message.content === 'Pronto!');
  });

  it('ephemeral: only the invoker sees it, nothing is stored', async () => {
    const { member, other, bot, geral, invoke } = await ready();
    const { id } = await invoke(member);
    expect((await bot.ok<{ message: unknown }>('interaction.respond', { id, type: 'reply', content: 'segredo', ephemeral: true })).message).toBeNull();
    const shown = await member.event<{ id: string; content: string; editedAt: number | null }>('interaction.ephemeral', (d) => d.id === id);
    expect(shown).toMatchObject({ interactionId: id, content: 'segredo', editedAt: null });
    await bot.ok('interaction.edit', { id, content: 'segredo 2' });
    await member.event('interaction.ephemeral', (d: { id: string; content: string }) => d.id === id && d.content === 'segredo 2');
    await other.sync();
    expect(other.seen('interaction.ephemeral')).toEqual([]);
    expect(other.seen('msg.new')).toEqual([]);
    const history = await member.ok<{ messages: Message[] }>('msg.history', { channelId: geral });
    expect(history.messages.some((m) => m.content.startsWith('segredo'))).toBe(false);
  });

  it('no answer in 3 s: the invoker learns the bot did not respond, and a late answer is refused', async () => {
    const { member, other, bot, invoke } = await ready();
    const { id } = await invoke(member);
    const failed = await member.event('interaction.failed', (d: { id: string }) => d.id === id, FIRST_RESPONSE_MS + 3_000);
    expect(failed).toMatchObject({ command: 'ping', userId: member.userId });
    expect(await bot.fail('interaction.respond', { id, type: 'reply', content: 'tarde' })).toBe('NOT_FOUND');
    await other.sync();
    expect(other.seen('interaction.failed')).toEqual([]);
  });

  it('permissions: SEND_MESSAGES to invoke, the bot must see the channel, only the bot answers', async () => {
    const { fx, member, bot, botId, geral, invoke } = await ready();
    const { id } = await invoke(member);
    expect(await member.fail('interaction.respond', { id, type: 'reply', content: 'eu' })).toBe('NOT_FOUND');
    expect(await bot.fail('interaction.invoke', { channelId: geral, botId, command: 'ping', options: [] })).toBe('FORBIDDEN');
    expect(await member.fail('interaction.invoke', { channelId: geral, botId, command: 'nope', options: [] })).toBe('NOT_FOUND');
    expect(await member.fail('interaction.invoke', { channelId: geral, botId, command: 'ping', options: [{ name: 'texto', value: 3 }] })).toBe('BAD_REQUEST');
    expect(await member.fail('interaction.invoke', { channelId: geral, botId, command: 'ping', options: [{ name: 'outro', value: 'x' }] })).toBe('BAD_REQUEST');

    // A private channel the bot cannot see (the owner sees every channel).
    const { channel } = await fx.owner.ok<{ channel: { id: string } }>('channel.create', { name: 'segredo', type: 'text', private: true });
    expect(await fx.owner.fail('interaction.invoke', { channelId: channel.id, botId, command: 'ping', options: [] })).toBe('FORBIDDEN');
    expect(await member.fail('interaction.invoke', { channelId: channel.id, botId, command: 'ping', options: [] })).toBe('NOT_FOUND');

    // Without SEND_MESSAGES.
    const everyone = fx.owner.text.roles.find((r) => r.isDefault)!;
    await fx.owner.ok('role.update', { id: everyone.id, permissions: DEFAULT_EVERYONE_PERMISSIONS & ~PERMISSIONS.SEND_MESSAGES });
    expect(await member.fail('interaction.invoke', { channelId: geral, botId, command: 'ping', options: [] })).toBe('FORBIDDEN');

    // An offline bot.
    bot.close();
    await fx.owner.event('presence', (d: { userId: string; online: boolean }) => d.userId === botId && !d.online);
    expect(await fx.owner.fail('interaction.invoke', { channelId: geral, botId, command: 'ping', options: [] })).toBe('BOT_OFFLINE');
  });
});
