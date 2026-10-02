// Bots in the app (bots spec §3): the "/" parser, the option chips, the BOTS section's visibility,
// which commands a channel offers, and the interaction lines only this app shows.
import { describe, expect, it } from 'vitest';
import type { BotCommand } from '@ghostlink/shared';
import {
  botRoleChoices,
  channelCommands,
  isSystemBot,
  refreshesBotSettings,
  seenText,
  serverBots,
  showBotsSection,
  timeAgo,
  toggledRole,
} from '../../src/renderer/features/bots/botsModel.js';
import { translate, type Translate } from '../../src/renderer/i18n/index.js';
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
import { buildRows } from '../../src/renderer/features/chat/grouping.js';
import { channelLocals } from '../../src/renderer/stores/bots.js';
import { centerView } from '../../src/renderer/stores/channels.js';
import { ADMIN_ROLE, BOB, CAROL, FANS_ROLE, GERAL, ME, MOD_ROLE, NOW, OWNER, SECRET, VOICE, channel, ev, member, message, run, snapshot, start } from './textFixtures.js';

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

  it("opens a bot's page in the center like a channel; a channel, the stage or the bot leaving brings the chat back", () => {
    const state = start(snapshot({ members: [member(ME, 'Eu'), member(BOB, 'Bob'), member(BOT, 'Zeca', { bot: true })] }));
    expect(centerView(state.channels)).toBe('chat');
    expect(run(state, { type: 'bot.open', botId: BOB })).toBe(state); // people have no page
    const open = run(state, { type: 'bot.open', botId: BOT });
    expect(open.channels).toMatchObject({ botPageId: BOT, activeId: GERAL });
    expect(centerView(open.channels)).toBe('bot');
    expect(centerView(run(open, { type: 'select', channelId: GERAL }).channels)).toBe('chat');
    expect(centerView(run(open, { type: 'stage', channelId: VOICE }).channels)).toBe('stage');
    expect(centerView(run(open, { type: 'stage', channelId: VOICE }, { type: 'stage', channelId: null }).channels)).toBe('chat');
    expect(centerView(run(open, ev({ t: 'member.left', userId: BOT, reason: 'kicked' })).channels)).toBe('chat');
    // A reconnect keeps it; another server's welcome does not.
    expect(run(open, { type: 'reset', snapshot: snapshot({ members: [member(ME, 'Eu'), member(BOT, 'Zeca', { bot: true })] }) }).channels.botPageId).toBe(BOT);
    expect(run(open, { type: 'reset', snapshot: snapshot({ members: [member(ME, 'Eu'), member(BOT, 'Zeca', { bot: true })] }, 'srv-2') }).channels.botPageId).toBeNull();
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

    // In the chat: each line right after the message it followed; the next message starts a group.
    const rows = buildRows([message(10), message(11), message(12, { authorId: BOB }), message(13, { authorId: BOB })], [], ME, channelLocals(state.bots, GERAL));
    expect(rows.filter((r) => r.kind !== 'date').map((r) => `${r.key}${r.head ? '*' : ''}`)).toEqual(['m:10*', 'm:11', 'b:ephemeral:I2*', 'b:failed:I3*', 'm:12*', 'm:13']);

    state = run(state, { type: 'bots.dismiss', channelId: GERAL, kind: 'ephemeral', id: 'I2' }, { type: 'bots.dismiss', channelId: GERAL, kind: 'failed', id: 'I3' });
    expect(channelLocals(state.bots, GERAL)).toEqual([]);
  });

  it("knows the server's own bot (the Ghost DJ) from its profile", () => {
    const members = [member(ME, 'Eu'), member(BOT, 'Ghost DJ', { bot: true }), member(OTHER_BOT, 'Zeca', { bot: true })];
    const profile = { description: '', createdBy: null, createdAt: 5, lastSeenAt: null };
    const state = start({ ...snapshot({ members }), botProfiles: [{ botId: BOT, ...profile, system: true }, { botId: OTHER_BOT, ...profile, system: false }] });
    expect(isSystemBot(state.bots.profiles, BOT)).toBe(true);
    expect(isSystemBot(state.bots.profiles, OTHER_BOT)).toBe(false);
    // A server before 0.4.2 has no profiles: no system bot.
    expect(isSystemBot(start(snapshot({ members })).bots.profiles, BOT)).toBe(false);
  });

  it("keeps each bot's profile: the welcome's, bot.updated, a bot created meanwhile, its last connection", () => {
    const members = [member(ME, 'Eu'), member(BOT, 'Zeca', { bot: true })];
    let state = start({ ...snapshot({ members }), botProfiles: [{ botId: BOT, description: 'Oi', createdBy: OWNER, createdAt: 5, lastSeenAt: 7, system: false }] });
    expect(state.bots.profiles).toEqual({ [BOT]: { description: 'Oi', createdBy: OWNER, createdAt: 5, lastSeenAt: 7, system: false } });
    state = run(state, ev({ t: 'bot.updated', botId: BOT, description: 'Novo' }), ev({ t: 'presence', userId: BOT, online: false }, NOW + 1));
    expect(state.bots.profiles![BOT]).toEqual({ description: 'Novo', createdBy: OWNER, createdAt: 5, lastSeenAt: NOW + 1, system: false });
    // A bot created after the welcome starts with what its member says; a person gets no profile.
    state = run(state, ev({ t: 'member.joined', member: member(OTHER_BOT, 'Ana Bot', { bot: true, joinedAt: 42 }) }), ev({ t: 'member.joined', member: member(CAROL, 'Carol') }));
    expect(state.bots.profiles![OTHER_BOT]).toEqual({ description: '', createdBy: null, createdAt: 42, lastSeenAt: null, system: false });
    expect(Object.keys(state.bots.profiles!)).toEqual([BOT, OTHER_BOT]);
    // Nothing that changes nothing.
    expect(run(state, ev({ t: 'bot.updated', botId: BOT, description: 'Novo' }), ev({ t: 'presence', userId: BOB, online: true })).bots).toBe(state.bots);
    // A server before 0.4.2: no profiles, whatever arrives.
    const old = run(start(snapshot({ members })), ev({ t: 'bot.updated', botId: BOT, description: 'x' }), ev({ t: 'member.joined', member: member(OTHER_BOT, 'Ana Bot', { bot: true }) }));
    expect(old.bots.profiles).toBeNull();
  });
});

describe("the bot's settings", () => {
  const pt: Translate = (key, vars) => translate('pt-BR', key, vars);

  it('says when something happened, in the app\'s language, and how the bot is connected', () => {
    const now = 1_800_000_000_000;
    expect(timeAgo(now, now, 'pt-BR')).toBe('agora');
    expect(timeAgo(now + 5_000, now, 'en')).toBe('now');
    expect(timeAgo(now - 5 * 60_000, now, 'pt-BR')).toBe('há 5 minutos');
    expect(timeAgo(now - 2 * 3_600_000 - 1, now, 'en')).toBe('2 hours ago');
    expect(timeAgo(now - 26 * 3_600_000, now, 'pt-BR')).toBe('ontem');
    expect(seenText(pt, true, null, now, 'pt-BR')).toBe('Online');
    expect(seenText(pt, false, undefined, now, 'pt-BR')).toBe('Offline');
    expect(seenText(pt, false, null, now, 'pt-BR')).toBe('Nunca conectou');
    expect(seenText(pt, false, now - 3 * 60_000, now, 'pt-BR')).toBe('Visto por último há 3 minutos');
  });

  it('loads again after events about this bot, roles, channels or a reconnect, and not after others', () => {
    for (const event of [
      { t: 'bot.updated', d: { botId: BOT, description: '' } },
      { t: 'commands.updated', d: { botId: BOT, commands: [] } },
      { t: 'member.updated', d: { member: { userId: BOT } } },
      { t: 'presence', d: { userId: BOT, online: false } },
      { t: 'role.updated', d: {} },
      { t: 'channel.created', d: {} },
      { t: 'welcome', d: {} },
    ]) {
      expect(refreshesBotSettings(event, BOT), event.t).toBe(true);
    }
    for (const event of [
      { t: 'bot.updated', d: { botId: OTHER_BOT } },
      { t: 'member.updated', d: { member: { userId: BOB } } },
      { t: 'member.updated', d: null },
      { t: 'presence', d: { userId: BOB } },
      { t: 'msg.new', d: {} },
    ]) {
      expect(refreshesBotSettings(event, BOT), event.t).toBe(false);
    }
  });

  it("lists the bot's roles and the ones I may give it, each one I may change as a checkbox", () => {
    const withRoles = (mine: string[], bots: string[]) =>
      start(snapshot({ members: [member(ME, 'Eu', { roleIds: mine }), member(BOT, 'Zeca', { bot: true, roleIds: bots })] }));
    const summary = (state: ReturnType<typeof withRoles>) => botRoleChoices(state, BOT).map((c) => `${c.role.name}:${c.checked ? 'x' : '-'}${c.editable ? 'e' : ''}`);
    // Mods (MANAGE_ROLES, position 2) may give Fãs (1), not Admin (3) nor Mods itself.
    expect(summary(withRoles([MOD_ROLE], []))).toEqual(['Fãs:-e']);
    expect(summary(withRoles([MOD_ROLE], [FANS_ROLE]))).toEqual(['Fãs:xe']);
    // A bot above me: its roles are shown, none can be changed.
    expect(summary(withRoles([MOD_ROLE], [ADMIN_ROLE, FANS_ROLE]))).toEqual(['Admin:x', 'Fãs:x']);
    // Without MANAGE_ROLES: only what it has.
    expect(summary(withRoles([FANS_ROLE], []))).toEqual([]);
    expect(toggledRole([FANS_ROLE], MOD_ROLE)).toEqual([FANS_ROLE, MOD_ROLE]);
    expect(toggledRole([FANS_ROLE, MOD_ROLE], FANS_ROLE)).toEqual([MOD_ROLE]);
  });
});
