// The example bot (examples/ping-bot) against a real GhostLink server (bots spec §5): it answers
// !ping and /ping (reply, defer then edit, ephemeral), and refuses a server whose key is not the pin.
import { afterEach, describe, expect, it } from 'vitest';
import type { BotCommands, BotCreateResult, InteractionEphemeralEvent, InteractionThinkingEvent, Message as WireMessage } from '@ghostlink/shared';
import { createAvatarsModule } from '../../../apps/server/src/avatars/index.js';
import { createBotsModule } from '../../../apps/server/src/bots/index.js';
import { channelId, nextClientMsgId, textFixture } from '../../../apps/server/test/text/helpers.js';
import { commands, createPingBot } from '../examples/ping-bot/bot.mjs';
import { REST, Routes, type Client } from '../src/index.js';

const bots: Client[] = [];
afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.destroy();
});

async function setup() {
  const fx = await textFixture({ extraModules: [createAvatarsModule(), createBotsModule()] });
  const created = await fx.owner.ok<BotCreateResult>('bot.create', { name: 'PingBot' });
  return { fx, code: created.connectionToken, botId: created.bot.userId, geral: channelId(fx.owner, 'geral') };
}

describe('the ping bot on a GhostLink server', () => {
  it('answers !ping and /ping: reply, defer then edit, ephemeral', async () => {
    const { fx, code, botId, geral } = await setup();
    const bot = createPingBot();
    bots.push(bot);
    await bot.login(code);
    expect(bot.user?.id).toBe(botId);
    expect(bot.user?.bot).toBe(true);
    expect(bot.channels.cache.get(geral)?.name).toBe('geral');
    // ClientReady registered /ping with client.application.commands.set().
    await fx.owner.event<BotCommands>('commands.updated', (d) => d.botId === botId && d.commands.some((c) => c.name === 'ping'));

    await fx.owner.ok('msg.send', { channelId: geral, content: '!ping', clientMsgId: nextClientMsgId() });
    const pong = await fx.owner.event<{ message: WireMessage }>('msg.new', (d) => d.message.authorId === botId);
    expect(pong.message.content).toMatch(/^Pong! \d+ ms$/);
    expect(pong.message.replyTo).toMatchObject({ authorId: fx.owner.userId, content: '!ping' });

    const invoke = (options: { name: string; value: boolean }[] = []) =>
      fx.owner.ok<{ id: string }>('interaction.invoke', { channelId: geral, botId, command: 'ping', options });

    const reply = await invoke();
    const answer = await fx.owner.event<{ message: WireMessage }>('msg.new', (d) => d.message.interaction?.id === reply.id);
    expect(answer.message).toMatchObject({ authorId: botId, authorBot: true, content: 'Pong!', interaction: { userId: fx.owner.userId, command: 'ping' } });

    const slow = await invoke([{ name: 'slow', value: true }]);
    const thinking = await fx.owner.event<InteractionThinkingEvent>('interaction.thinking', (d) => d.id === slow.id);
    expect(thinking).toMatchObject({ botId, ephemeral: false });
    const edited = await fx.owner.event<{ message: WireMessage }>('msg.new', (d) => d.message.interaction?.id === slow.id);
    expect(edited.message.content).toBe('Pong! (after thinking)');

    const secret = await invoke([{ name: 'private', value: true }]);
    const shown = await fx.owner.event<InteractionEphemeralEvent>('interaction.ephemeral', (d) => d.interactionId === secret.id);
    expect(shown).toMatchObject({ botId, content: 'Pong!' });
    await fx.owner.sync();
    expect(fx.owner.seen<{ message: WireMessage }>('msg.new').some((d) => d.message.interaction?.id === secret.id)).toBe(false);
  });

  it('sends, reads, edits and deletes messages through the discord.js structures', async () => {
    const { fx, code, botId, geral } = await setup();
    const bot = createPingBot();
    bots.push(bot);
    await bot.login(code);
    const channel = await bot.channels.fetch(geral);
    await channel.sendTyping();
    const sent = await channel.send(`hi ${fx.owner.nickname}, I am ${bot.user}`);
    expect(sent).toMatchObject({ channelId: geral, content: `hi ${fx.owner.nickname}, I am <@${botId}>`, author: { id: botId, bot: true } });
    expect(sent.mentions.has(botId)).toBe(true);
    const later = await channel.send({ content: 'second', reply: { messageReference: sent } });
    const recent = await channel.messages.fetch({ limit: 2 });
    expect([...recent.keys()]).toEqual([later.id, sent.id]);
    expect((await channel.messages.fetch(sent.id)).content).toBe(sent.content);
    expect((await sent.edit('edited')).content).toBe('edited');
    await fx.owner.event<{ message: WireMessage }>('msg.updated', (d) => String(d.message.id) === sent.id && d.message.content === 'edited');
    await later.delete();
    await fx.owner.event<{ id: number }>('msg.deleted', (d) => String(d.id) === later.id);
    await expect(channel.messages.fetch(later.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('deploys commands with REST and Routes.applicationCommands, as the discord.js guide does', async () => {
    const { fx, code, botId } = await setup();
    const rest = new REST({ version: '10' }).setToken(code);
    const saved = await rest.put(Routes.applicationCommands(botId), { body: commands.map((c) => c.toJSON()) });
    expect(saved).toMatchObject([{ name: 'ping', application_id: botId, options: [{ name: 'private', type: 5 }, { name: 'slow', type: 5 }] }]);
    await fx.owner.event<BotCommands>('commands.updated', (d) => d.botId === botId && d.commands.length === 1);
    expect(await rest.get(Routes.applicationCommands(botId))).toEqual(saved);
  });

  it('refuses a server whose key does not match the pin', async () => {
    const { code } = await setup();
    const bot = createPingBot();
    bots.push(bot);
    const wrongPin = code.replace(/pin=[^&]+/, `pin=${'A'.repeat(43)}`);
    await expect(bot.login(wrongPin)).rejects.toMatchObject({ name: 'GhostLinkError', code: 'PIN_MISMATCH' });
    expect(bot.isReady()).toBe(false);
  });
});
