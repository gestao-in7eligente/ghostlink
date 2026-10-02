// Bots in the app (bots spec §3): the "/" parser, the option chips, the BOTS section's visibility,
// which commands a channel offers, and the interaction lines only this app shows.
import { describe, expect, it } from 'vitest';
import type { BotCommand } from '@ghostlink/shared';
import { channelCommands, serverBots, showBotsSection } from '../../src/renderer/features/bots/botsModel.js';
import {
  addChip,
  chipEditor,
  chipError,
  invokeOptions,
  optionalLeft,
  removeChip,
  setChip,
  slashQuery,
  slashSuggestions,
  startDraft,
  type SlashEntry,
} from '../../src/renderer/features/bots/slashModel.js';
import { channelLocals } from '../../src/renderer/stores/bots.js';
import { ADMIN_ROLE, BOB, GERAL, ME, SECRET, channel, ev, member, message, run, snapshot, start } from './textFixtures.js';

const BOT = 'e'.repeat(32);
const OTHER_BOT = 'f'.repeat(32);

const PING: BotCommand = { name: 'ping', description: 'Responde pong', options: [] };
const ECHO: BotCommand = {
  name: 'echo',
  description: 'Repete o texto',
  options: [
    { name: 'texto', description: 'O que repetir', type: 'string', required: true },
    { name: 'vezes', description: 'Quantas vezes', type: 'integer', required: false },
    { name: 'gritar', description: 'Em maiúsculas', type: 'boolean', required: false },
    { name: 'para', description: 'Quem', type: 'user', required: false },
    { name: 'cor', description: 'Cor', type: 'string', required: false, choices: [{ name: 'Azul', value: 'blue' }, { name: 'Vermelho', value: 'red' }] },
  ],
};

const entry = (command: BotCommand, botName = 'Hermes', botId = BOT): SlashEntry => ({ botId, botName, botAvatar: null, command });

describe('the "/" parser', () => {
  it('reads the command name while the caret is in the first word of a text that starts with "/"', () => {
    expect(slashQuery('/', 1)).toBe('');
    expect(slashQuery('/pi', 3)).toBe('pi');
    expect(slashQuery('/ping', 3)).toBe('ping');
    expect(slashQuery('/ping ', 6)).toBeNull();
    expect(slashQuery('oi /ping', 8)).toBeNull();
    expect(slashQuery(' /ping', 6)).toBeNull();
    expect(slashQuery('/ping', 0)).toBeNull();
    expect(slashQuery(`/${'a'.repeat(40)}`, 41)).toBeNull();
  });

  it('suggests names that start with the query first, then names or descriptions that contain it', () => {
    const all = [entry(ECHO), entry(PING), entry({ name: 'help', description: 'Mostra ajuda e ping', options: [] }), entry(PING, 'Ajudante', OTHER_BOT)];
    expect(slashSuggestions('', all).map((e) => `${e.command.name}@${e.botName}`)).toEqual(['echo@Hermes', 'help@Hermes', 'ping@Ajudante', 'ping@Hermes']);
    expect(slashSuggestions('PI', all).map((e) => `${e.command.name}@${e.botName}`)).toEqual(['ping@Ajudante', 'ping@Hermes', 'help@Hermes']);
    expect(slashSuggestions('zzz', all)).toEqual([]);
  });
});

describe('the option chips', () => {
  it('starts with the required options; optional ones are added and removed', () => {
    let draft = startDraft(entry(ECHO));
    expect(draft.chips.map((c) => c.option.name)).toEqual(['texto']);
    expect(optionalLeft(draft).map((o) => o.name)).toEqual(['vezes', 'gritar', 'para', 'cor']);
    draft = addChip(addChip(draft, 'gritar'), 'vezes');
    expect(draft.chips.map((c) => c.option.name)).toEqual(['texto', 'gritar', 'vezes']);
    expect(removeChip(draft, 'texto')).toBe(draft); // required stays
    expect(removeChip(draft, 'gritar').chips.map((c) => c.option.name)).toEqual(['texto', 'vezes']);
  });

  it('edits each type its own way', () => {
    const [texto, vezes, gritar, para, cor] = ECHO.options;
    expect([texto, vezes, gritar, para, cor].map((o) => chipEditor(o!))).toEqual(['text', 'number', 'select', 'user', 'select']);
    expect(chipEditor({ type: 'channel' })).toBe('channel');
    expect(chipEditor({ type: 'number' })).toBe('number');
  });

  it('checks every value and sends typed options, leaving empty optional ones out', () => {
    let draft = addChip(addChip(addChip(addChip(startDraft(entry(ECHO)), 'vezes'), 'gritar'), 'para'), 'cor');
    expect(invokeOptions(draft)).toBeNull(); // "texto" is required
    draft = setChip(draft, 'texto', '  olá  ');
    expect(invokeOptions(draft)).toEqual([{ name: 'texto', value: 'olá' }]);

    draft = setChip(draft, 'vezes', '2.5');
    expect(chipError(draft.chips[1]!)).toBe('integer');
    draft = setChip(setChip(draft, 'vezes', '3'), 'gritar', 'true');
    draft = setChip(draft, 'para', BOB, '@Bob');
    draft = setChip(draft, 'cor', 'green');
    expect(chipError(draft.chips[4]!)).toBe('choice');
    draft = setChip(draft, 'cor', 'red');
    expect(invokeOptions(draft)).toEqual([
      { name: 'texto', value: 'olá' },
      { name: 'vezes', value: 3 },
      { name: 'gritar', value: true },
      { name: 'para', value: BOB },
      { name: 'cor', value: 'red' },
    ]);
    expect(draft.chips[3]!.label).toBe('@Bob');
  });

  it('accepts a decimal comma in a number option and refuses a person that was only typed', () => {
    const cmd: BotCommand = {
      name: 'calc',
      description: 'x',
      options: [
        { name: 'n', description: 'x', type: 'number', required: true },
        { name: 'quem', description: 'x', type: 'user', required: true },
      ],
    };
    let draft = setChip(setChip(startDraft(entry(cmd)), 'n', '2,5'), 'quem', 'Bob');
    expect(chipError(draft.chips[0]!)).toBeNull();
    expect(chipError(draft.chips[1]!)).toBe('required');
    draft = setChip(draft, 'quem', BOB, '@Bob');
    expect(invokeOptions(draft)).toEqual([
      { name: 'n', value: 2.5 },
      { name: 'quem', value: BOB },
    ]);
  });
});

describe('the BOTS section and the commands of a channel', () => {
  it('shows when the server has bots, or when the person can create one on a server that takes bots', () => {
    expect(showBotsSection({ bots: 0, canManage: false, supported: true })).toBe(false);
    expect(showBotsSection({ bots: 0, canManage: true, supported: false })).toBe(false);
    expect(showBotsSection({ bots: 0, canManage: true, supported: true })).toBe(true);
    expect(showBotsSection({ bots: 2, canManage: false, supported: true })).toBe(true);
  });

  it('lists the bots by name and offers only the commands of bots that see the channel', () => {
    const state = start(
      snapshot({
        channels: [channel(GERAL, 'geral', 0), channel(SECRET, 'segredo', 1, { private: true, allowedRoleIds: [ADMIN_ROLE] })],
        members: [member(ME, 'Eu'), member(BOT, 'Zeca', { bot: true }), member(OTHER_BOT, 'Ana Bot', { bot: true, roleIds: [ADMIN_ROLE] })],
      }),
    );
    expect(serverBots(state.members.byId).map((m) => m.nickname)).toEqual(['Ana Bot', 'Zeca']);
    const commands = { [BOT]: [PING], [OTHER_BOT]: [ECHO], [ME]: [PING] };
    const names = (id: string) => channelCommands(state, commands, state.channels.byId[id]!).map((e) => `${e.command.name}@${e.botName}`);
    expect(names(GERAL)).toEqual(['ping@Zeca', 'echo@Ana Bot']);
    expect(names(SECRET)).toEqual(['echo@Ana Bot']);
  });
});

describe('the bots store', () => {
  it('takes the commands from the welcome and from commands.updated', () => {
    let state = start({ ...snapshot(), botCommands: [{ botId: BOT, commands: [PING] }] });
    expect(state.bots.commands).toEqual({ [BOT]: [PING] });
    state = run(state, ev({ t: 'commands.updated', botId: BOT, commands: [PING, ECHO] }));
    expect(state.bots.commands[BOT]!.map((c) => c.name)).toEqual(['ping', 'echo']);
    state = run(state, ev({ t: 'member.left', userId: BOT, reason: 'kicked' }));
    expect(state.bots.commands).toEqual({});
  });

  it('shows "pensando…" until the answer, the ephemeral answer until dismissed, and "não respondeu"', () => {
    const base = { channelId: GERAL, botId: BOT, command: 'ping' };
    let state = run(start(), ev({ t: 'interaction.thinking', id: 'I1', userId: ME, ephemeral: false, ...base }));
    expect(channelLocals(state.bots, GERAL)).toMatchObject([{ kind: 'thinking', id: 'I1', afterId: 10 }]);

    // The public answer replaces it.
    state = run(state, ev({ t: 'msg.new', message: message(11, { authorId: BOT, authorBot: true, interaction: { id: 'I1', userId: ME, command: 'ping' } }) }));
    expect(channelLocals(state.bots, GERAL)).toEqual([]);

    // An ephemeral answer replaces its "pensando…"; an edit keeps its place.
    state = run(state, ev({ t: 'interaction.thinking', id: 'I2', userId: ME, ephemeral: true, ...base }));
    const answer = { id: 'I2', interactionId: 'I2', content: 'pong', createdAt: 1, editedAt: null, ...base };
    state = run(state, ev({ t: 'interaction.ephemeral', ...answer }));
    state = run(state, ev({ t: 'interaction.ephemeral', ...answer, content: 'pong!', editedAt: 2 }));
    expect(channelLocals(state.bots, GERAL)).toMatchObject([{ kind: 'ephemeral', id: 'I2', userId: ME, content: 'pong!', afterId: 11 }]);

    state = run(state, ev({ t: 'interaction.failed', id: 'I3', userId: ME, ...base }));
    expect(channelLocals(state.bots, GERAL).map((l) => l.kind)).toEqual(['ephemeral', 'failed']);

    state = run(state, { type: 'bots.dismiss', channelId: GERAL, kind: 'ephemeral', id: 'I2' }, { type: 'bots.dismiss', channelId: GERAL, kind: 'failed', id: 'I3' });
    expect(channelLocals(state.bots, GERAL)).toEqual([]);
  });
});
