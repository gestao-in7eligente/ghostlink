import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  PROTOCOL,
  parseBotConnectionCode,
  type BotCreateResult,
  type Edition,
  type ErrorCode,
  type HermesConfig,
  type HermesReport,
  type HermesState,
  type HermesView,
} from '@ghostlink/shared';
import { createAvatarsModule } from '../src/avatars/index.js';
import { createBotsModule } from '../src/bots/index.js';
import { createCompanyHermesModule } from '../src/companyHermes/index.js';
import { fakeEnterprise } from './helpers/enterprise.js';
import { connectRaw } from './helpers/testClient.js';
import { textFixture, wrapClient, type TextClient, type TextFixture } from './text/helpers.js';

/** Obviously fake, made at run time: never a real key. */
const fakeKey = (tag: string) => `sk-test-${tag}-${randomBytes(12).toString('hex')}`;

async function setup(edition: Edition = 'enterprise') {
  const enterprise = fakeEnterprise(edition);
  const fx = await textFixture({ extraModules: [createAvatarsModule(), createBotsModule(), enterprise, createCompanyHermesModule()] });
  return { fx, enterprise };
}

/** The bot handshake (as in bots.test.ts). */
async function connectBot(fx: TextFixture, code: string): Promise<{ client: TextClient; error?: undefined } | { client?: undefined; error: ErrorCode }> {
  const parsed = parseBotConnectionCode(code)!;
  const raw = await connectRaw(fx.t.server, { pin: parsed.serverKeyId });
  raw.send({ t: 'hello', d: { protocol: PROTOCOL.current, bot: parsed.token, client: 'hermes-test/0.0.0' } });
  const m = await raw.next();
  if (m.t === 'error') {
    raw.close();
    return { error: (m.d as { code: ErrorCode }).code };
  }
  const welcome = m.d as { self: { userId: string; nickname: string } } & Record<string, unknown>;
  return { client: wrapClient(raw, welcome, { userId: welcome.self.userId, seed: new Uint8Array(32), nickname: welcome.self.nickname }) };
}

async function admin(fx: TextFixture): Promise<TextClient> {
  const { role } = await fx.owner.ok<{ role: { id: string } }>('role.create', { name: 'Gerente', permissions: PERMISSIONS.MANAGE_SERVER });
  const ana = await fx.join({ nickname: 'Ana' });
  await fx.owner.ok('member.setRoles', { userId: ana.userId, roleIds: [role.id] });
  return ana;
}

const report = (o: Partial<HermesReport> = {}): HermesReport => ({
  appliedVersion: 1,
  skills: [{ name: 'resumo', description: 'Resume conversas', enabled: true, locked: false }],
  memory: { company: [{ id: '0123456789abcdef', text: 'A TC Flag fabrica bandeiras.' }], people: [] },
  status: { model: { provider: 'deepseek', model: 'deepseek-v4-pro' }, fallback: null, keys: { deepseek: 'ok', openrouter: 'missing', 'openai-api': 'missing', anthropic: 'missing', gemini: 'missing' }, unsupported: null, envOverride: [] },
  ...o,
});

describe('the company Hermes (spec §2)', () => {
  it('only the owner of an Enterprise server creates it, once', async () => {
    const { fx } = await setup();
    const ana = await admin(fx);
    expect(await ana.fail('hermes.create', { name: 'TC Hermes' })).toBe('FORBIDDEN');
    const created = await fx.owner.ok<BotCreateResult>('hermes.create', { name: 'TC Hermes' });
    expect(created.connectionToken).toMatch(/^ghostlink-bot:\/\//);
    expect(await fx.owner.fail('hermes.create', { name: 'Outro' })).toBe('BAD_REQUEST');
    expect((await fx.owner.event<HermesState>('hermes.state')).botId).toBe(created.bot.userId);
    // Whoever holds its code gets the keys: only the owner makes a new one or deletes it.
    expect(await ana.fail('bot.regenerate', { botId: created.bot.userId })).toBe('FORBIDDEN');
    expect(await ana.fail('bot.delete', { botId: created.bot.userId })).toBe('FORBIDDEN');

    const normal = await setup('normal');
    expect(await normal.fx.owner.fail('hermes.create', { name: 'TC Hermes' })).toBe('ENTERPRISE_REQUIRED');
  });

  it('keys go only to the company Hermes, never back to an app', async () => {
    const { fx } = await setup();
    const ana = await fx.join({ nickname: 'Ana' });
    const created = await fx.owner.ok<BotCreateResult>('hermes.create', { name: 'TC Hermes' });
    const other = await fx.owner.ok<BotCreateResult>('bot.create', { name: 'Outro bot' });
    const hermes = (await connectBot(fx, created.connectionToken)).client!;
    const impostor = (await connectBot(fx, other.connectionToken)).client!;
    expect((await hermes.event<HermesConfig>('hermes.config')).version).toBe(0);

    const key = fakeKey('deepseek');
    const state = await fx.owner.ok<HermesState>('hermes.update', { keys: { deepseek: `  ${key} ` } });
    expect(state.keys).toEqual({ deepseek: { last4: key.slice(-4) }, openrouter: null, 'openai-api': null, anthropic: null, gemini: null });
    const config = await hermes.event<HermesConfig>('hermes.config', (c) => c.version === 1);
    expect(config.keys.deepseek).toBe(key);
    expect(config.models.primary).toEqual({ provider: 'deepseek', model: 'deepseek-v4-pro' });

    await Promise.all([impostor.sync(), ana.sync(), fx.owner.sync()]);
    expect(impostor.seen('hermes.config')).toEqual([]);
    expect(ana.seen('hermes.state')).toEqual([]);
    for (const seen of [JSON.stringify(state), JSON.stringify(fx.owner.events), JSON.stringify(ana.events), JSON.stringify(await fx.owner.ok('hermes.get', {}))]) {
      expect(seen).not.toContain(key);
    }
    expect(await impostor.fail('hermes.report', report())).toBe('FORBIDDEN');
  });

  it('reports reach the owner live; memory deletes reach the Hermes; offline answers BOT_OFFLINE', async () => {
    const { fx } = await setup();
    const created = await fx.owner.ok<BotCreateResult>('hermes.create', { name: 'TC Hermes' });
    expect(await fx.owner.fail('hermes.memory.delete', { target: 'company', id: '0123456789abcdef' })).toBe('BOT_OFFLINE');
    const hermes = (await connectBot(fx, created.connectionToken)).client!;
    await hermes.ok('hermes.report', report());
    const state = await fx.owner.event<HermesState>('hermes.state', (s) => s.report !== null);
    expect(state).toMatchObject({ connected: true, report: { skills: [{ name: 'resumo' }] } });
    await fx.owner.ok('hermes.memory.delete', { target: 'company', id: '0123456789abcdef' });
    expect(await hermes.event('hermes.memory.delete')).toEqual({ target: 'company', id: '0123456789abcdef' });
    // Disconnected: the last report stays, with the warning in the app.
    hermes.close();
    await fx.owner.event<HermesState>('hermes.state', (s) => !s.connected);
    expect((await fx.owner.ok<HermesState>('hermes.get', {})).report?.skills[0]?.name).toBe('resumo');
  });

  it('a lapsed license disconnects it, refuses it at the door and locks its settings', async () => {
    const { fx, enterprise } = await setup();
    const created = await fx.owner.ok<BotCreateResult>('hermes.create', { name: 'TC Hermes' });
    const hermes = (await connectBot(fx, created.connectionToken)).client!;
    await hermes.event('hermes.config');
    enterprise.set('normal');
    await hermes.closed;
    expect(hermes.closedWith).toBe('ENTERPRISE_REQUIRED');
    expect((await connectBot(fx, created.connectionToken)).error).toBe('ENTERPRISE_REQUIRED');
    expect(await fx.owner.fail('hermes.update', { models: { primary: { provider: 'deepseek', model: 'deepseek-v4-flash' }, fallback: null } })).toBe('ENTERPRISE_REQUIRED');
    expect((await fx.owner.ok<HermesState>('hermes.get', {})).locked).toBe(true);
    enterprise.set('enterprise');
    expect((await connectBot(fx, created.connectionToken)).client).toBeDefined();
  });

  it('deleting the Hermes keeps its settings and keys; a new one picks them up (decision 10)', async () => {
    const { fx } = await setup();
    const created = await fx.owner.ok<BotCreateResult>('hermes.create', { name: 'TC Hermes' });
    const key = fakeKey('deepseek');
    await fx.owner.ok('hermes.update', { keys: { deepseek: key } });
    await fx.owner.ok('bot.delete', { botId: created.bot.userId });
    const state = await fx.owner.ok<HermesState>('hermes.get', {});
    expect(state.botId).toBeNull();
    expect(state.keys.deepseek).toEqual({ last4: key.slice(-4) });
    const again = await fx.owner.ok<BotCreateResult>('hermes.create', { name: 'TC Hermes 2' });
    const hermes = (await connectBot(fx, again.connectionToken)).client!;
    expect((await hermes.event<HermesConfig>('hermes.config')).keys.deepseek).toBe(key);
  });

  it('a non-owner cannot read or change it', async () => {
    const { fx } = await setup();
    const ana = await admin(fx);
    await fx.owner.ok<BotCreateResult>('hermes.create', { name: 'TC Hermes' });
    expect(await ana.fail('hermes.get', {})).toBe('FORBIDDEN');
    expect(await ana.fail('hermes.update', { keys: { deepseek: fakeKey('x') } })).toBe('FORBIDDEN');
    expect(await ana.fail('hermes.memory.delete', { target: 'company', id: '0123456789abcdef' })).toBe('FORBIDDEN');
  });

  it('an ownership transfer tells the new owner, and a stranger leaving tells no one', async () => {
    const { fx } = await setup();
    const ana = await fx.join({ nickname: 'Ana' });
    await fx.owner.ok<BotCreateResult>('hermes.create', { name: 'TC Hermes' });
    const bia = await fx.join({ nickname: 'Bia' });
    await fx.owner.sync();
    const before = fx.owner.seen('hermes.state').length;
    await fx.owner.ok('member.kick', { userId: bia.userId });
    await fx.owner.sync();
    expect(fx.owner.seen('hermes.state')).toHaveLength(before);
    await fx.owner.ok('server.transferOwnership', { userId: ana.userId });
    expect((await ana.event<HermesState>('hermes.state')).botId).not.toBeNull();
  });
});

type ViewEvent = { view: HermesView | null };
const reported = (d: ViewEvent) => Array.isArray(d.view?.skills);
const lost = (d: ViewEvent) => d.view === null;

/** The company Hermes, a viewer role held by Bia, and Caio without it. */
async function withViewer() {
  const { fx, enterprise } = await setup();
  const created = await fx.owner.ok<BotCreateResult>('hermes.create', { name: 'TC Hermes' });
  const { role } = await fx.owner.ok<{ role: { id: string } }>('role.create', { name: 'Diretoria' });
  const bia = await fx.join({ nickname: 'Bia' });
  const caio = await fx.join({ nickname: 'Caio' });
  await fx.owner.ok('member.setRoles', { userId: bia.userId, roleIds: [role.id] });
  const state = await fx.owner.ok<HermesState>('hermes.update', { viewerRoleId: role.id });
  await bia.event<ViewEvent>('hermes.view');
  return { fx, enterprise, created, role, bia, caio, state };
}

describe('the company Hermes page (spec 2026-10-03)', () => {
  it('the owner and the viewer role see it, live and in the welcome; anyone else gets FORBIDDEN and no event', async () => {
    const { fx, created, role, bia, caio, state } = await withViewer();
    expect(state.viewerRoleId).toBe(role.id);
    expect(bia.seen<ViewEvent>('hermes.view')[0]?.view?.botId).toBe(created.bot.userId);
    const hermes = (await connectBot(fx, created.connectionToken)).client!;
    await hermes.ok('hermes.report', report());
    const live = await bia.event<ViewEvent>('hermes.view', (d) => reported(d) && d.view?.connected === true);
    expect(live.view).toMatchObject({
      models: { primary: { provider: 'deepseek', model: 'deepseek-v4-pro' } },
      modelInUse: { provider: 'deepseek', model: 'deepseek-v4-pro' },
      skills: [{ name: 'resumo', description: 'Resume conversas' }],
      access: { roleIds: [], channels: 'all' },
    });
    expect((await fx.owner.ok<{ view: HermesView }>('hermes.view', {})).view.memory).toEqual({ company: 1, people: 0 });
    expect((await bia.ok<{ view: HermesView }>('hermes.view', {})).view.botId).toBe(created.bot.userId);

    expect(await caio.fail('hermes.view', {})).toBe('FORBIDDEN');
    await caio.sync();
    expect(caio.seen('hermes.view')).toEqual([]);
    expect(caio.welcome.hermesView).toBeUndefined();
    const again = await fx.join({ seed: bia.seed, nickname: 'Bia' });
    expect((again.welcome.hermesView as HermesView).botId).toBe(created.bot.userId);
  });

  it("the role's page has no key and no memory, the owner's only the counts; the Hermes never gets the role", async () => {
    const { fx, created, bia } = await withViewer();
    const key = fakeKey('deepseek');
    await fx.owner.ok('hermes.update', { keys: { deepseek: key } });
    const hermes = (await connectBot(fx, created.connectionToken)).client!;
    expect(await hermes.event<HermesConfig>('hermes.config')).not.toHaveProperty('viewerRoleId');
    await hermes.ok('hermes.report', report());
    const owner = (await fx.owner.event<ViewEvent>('hermes.view', reported)).view!;
    const role = (await bia.event<ViewEvent>('hermes.view', reported)).view!;
    expect(owner.memory).toEqual({ company: 1, people: 0 });
    expect(role).not.toHaveProperty('memory');
    for (const seen of [JSON.stringify(owner), JSON.stringify(bia.events), JSON.stringify(await bia.ok('hermes.view', {}))]) {
      expect(seen).not.toContain(key.slice(-4));
      expect(seen).not.toContain('A TC Flag fabrica bandeiras.');
    }
    // Changing only the viewer role sends the Hermes nothing.
    await hermes.sync();
    const configs = hermes.seen('hermes.config').length;
    await fx.owner.ok('hermes.update', { viewerRoleId: null });
    await hermes.sync();
    expect(hermes.seen('hermes.config')).toHaveLength(configs);
  });

  it('losing the role, or the license lapsing, stops the page at once', async () => {
    const { fx, enterprise, created, bia } = await withViewer();
    await fx.owner.ok('member.setRoles', { userId: bia.userId, roleIds: [] });
    await bia.event<ViewEvent>('hermes.view', lost);
    const hermes = (await connectBot(fx, created.connectionToken)).client!;
    await hermes.ok('hermes.report', report());
    await fx.owner.event<ViewEvent>('hermes.view', reported);
    await bia.sync();
    expect(bia.seen<ViewEvent>('hermes.view').at(-1)?.view).toBeNull();
    expect(await bia.fail('hermes.view', {})).toBe('FORBIDDEN');

    const { role } = await fx.owner.ok<{ role: { id: string } }>('role.create', { name: 'Conselho' });
    await fx.owner.ok('hermes.update', { viewerRoleId: role.id });
    await fx.owner.ok('member.setRoles', { userId: bia.userId, roleIds: [role.id] });
    await bia.event<ViewEvent>('hermes.view', reported);
    bia.clear();
    enterprise.set('normal');
    await bia.event<ViewEvent>('hermes.view', lost);
    expect(await bia.fail('hermes.view', {})).toBe('FORBIDDEN');
    expect((await fx.owner.ok<{ view: HermesView }>('hermes.view', {})).view.botId).toBe(created.bot.userId);
  });

  it("a role holder never gets the id of a private channel they cannot see, only how many, and no event when it changes", async () => {
    const { fx, bia } = await withViewer();
    const general = fx.owner.text.channels.find((c) => c.type === 'text')!;
    const { channel: secret } = await fx.owner.ok<{ channel: { id: string } }>('channel.create', { name: 'diretoria', type: 'text', private: true });
    await fx.owner.ok('hermes.update', { access: { roleIds: [], channels: [general.id, secret.id] } });
    const page = (await bia.event<ViewEvent>('hermes.view', (d) => d.view?.access.channels !== 'all')).view!;
    expect(page).toMatchObject({ access: { channels: [general.id] }, hiddenChannels: 1 });
    const owner = (await fx.owner.event<ViewEvent>('hermes.view', (d) => d.view?.access.channels !== 'all')).view!;
    expect(owner).toMatchObject({ access: { channels: [general.id, secret.id] }, hiddenChannels: 0 });
    const asked = await bia.ok('hermes.view', {});
    await bia.sync();
    const before = bia.seen('hermes.view').length;
    await fx.owner.ok('channel.update', { id: secret.id, name: 'diretoria-2', topic: 'só a diretoria' });
    await bia.sync();
    expect(bia.seen('hermes.view')).toHaveLength(before);
    await fx.owner.ok('channel.delete', { id: secret.id });
    await bia.sync();
    // A new session (it replaces the first one) starts from a welcome without it too.
    const { channel: other } = await fx.owner.ok<{ channel: { id: string } }>('channel.create', { name: 'conselho', type: 'text', private: true });
    await fx.owner.ok('hermes.update', { access: { roleIds: [], channels: [general.id, other.id] } });
    const again = await fx.join({ seed: bia.seed, nickname: 'Bia' });
    expect(again.welcome.hermesView).toMatchObject({ access: { channels: [general.id] }, hiddenChannels: 1 });
    for (const seen of [JSON.stringify(bia.events), JSON.stringify(asked)]) expect(seen).not.toContain(secret.id);
    expect(JSON.stringify(again.welcome)).not.toContain(other.id);
  });

  it('after an ownership transfer the old owner without the role gets view: null, then nothing', async () => {
    const { fx, caio } = await withViewer();
    await fx.owner.event<ViewEvent>('hermes.view');
    await fx.owner.ok('server.transferOwnership', { userId: caio.userId });
    await fx.owner.event<ViewEvent>('hermes.view', lost);
    expect((await caio.event<ViewEvent>('hermes.view')).view).toHaveProperty('memory');
    const after = fx.owner.seen('hermes.view').length;
    await caio.ok('hermes.update', { models: { primary: { provider: 'deepseek', model: 'deepseek-v4-flash' }, fallback: null } });
    await caio.event<ViewEvent>('hermes.view', (d) => d.view?.models.primary.model === 'deepseek-v4-flash');
    await fx.owner.sync();
    expect(fx.owner.seen('hermes.view')).toHaveLength(after);
    expect(await fx.owner.fail('hermes.view', {})).toBe('FORBIDDEN');
  });

  it('a kicked role holder gets nothing more, even back as a plain member', async () => {
    const { fx, bia } = await withViewer();
    await fx.owner.ok('member.kick', { userId: bia.userId });
    await bia.closed;
    fx.clock.now += 600_001; // past the 10 minutes a kick blocks the rejoin
    const back = await fx.join({ seed: bia.seed, nickname: 'Bia' });
    expect(back.welcome.hermesView).toBeUndefined();
    await fx.owner.ok('hermes.update', { models: { primary: { provider: 'deepseek', model: 'deepseek-v4-flash' }, fallback: null } });
    await fx.owner.event<ViewEvent>('hermes.view', (d) => d.view?.models.primary.model === 'deepseek-v4-flash');
    await back.sync();
    expect(back.seen('hermes.view')).toEqual([]);
    expect(await back.fail('hermes.view', {})).toBe('FORBIDDEN');
  });

  it('deleting the role resets it to none; only an existing role other than @everyone is taken', async () => {
    const { fx, role, bia } = await withViewer();
    fx.owner.clear();
    await fx.owner.ok('role.delete', { id: role.id });
    expect((await fx.owner.event<HermesState>('hermes.state')).viewerRoleId).toBeNull();
    await bia.event<ViewEvent>('hermes.view', lost);
    expect((await fx.owner.ok<HermesState>('hermes.get', {})).viewerRoleId).toBeNull();
    expect(await fx.owner.fail('hermes.update', { viewerRoleId: role.id })).toBe('NOT_FOUND');
    const everyone = fx.owner.text.roles.find((r) => r.isDefault)!;
    expect(await fx.owner.fail('hermes.update', { viewerRoleId: everyone.id })).toBe('BAD_REQUEST');
    expect(await bia.fail('hermes.update', { viewerRoleId: null })).toBe('FORBIDDEN');
  });
});

describe('the API tab (spec 2026-10-03-aba-api-e-sites §1)', () => {
  it('only the owner saves and deletes keys; the app sees the last 4, only the company Hermes the keys', async () => {
    const { fx } = await setup();
    const ana = await admin(fx);
    const created = await fx.owner.ok<BotCreateResult>('hermes.create', { name: 'TC Hermes' });
    const other = await fx.owner.ok<BotCreateResult>('bot.create', { name: 'Outro bot' });
    const hermes = (await connectBot(fx, created.connectionToken)).client!;
    const impostor = (await connectBot(fx, other.connectionToken)).client!;
    await hermes.event<HermesConfig>('hermes.config');
    const eleven = fakeKey('eleven');
    const mine = fakeKey('mine');
    const gemini = fakeKey('gemini');

    expect(await ana.fail('hermes.update', { apis: { ELEVENLABS_API_KEY: { value: eleven } } })).toBe('FORBIDDEN');
    const state = await fx.owner.ok<HermesState>('hermes.update', {
      keys: { gemini },
      apis: { ELEVENLABS_API_KEY: { value: eleven }, MINHA_API_KEY: { name: 'Minha API', value: mine } },
    });
    expect(state.keys.gemini).toEqual({ last4: gemini.slice(-4) });
    expect(state.apis).toEqual([
      { envVar: 'ELEVENLABS_API_KEY', name: 'ElevenLabs', last4: eleven.slice(-4) },
      { envVar: 'MINHA_API_KEY', name: 'Minha API', last4: mine.slice(-4) },
    ]);
    const config = await hermes.event<HermesConfig>('hermes.config', (c) => c.version === 1);
    expect(config.keys.gemini).toBe(gemini);
    expect(config.apis).toEqual({ ELEVENLABS_API_KEY: eleven, MINHA_API_KEY: mine });

    await Promise.all([impostor.sync(), ana.sync(), fx.owner.sync()]);
    expect(impostor.seen('hermes.config')).toEqual([]);
    const answers = [JSON.stringify(fx.owner.events), JSON.stringify(ana.events), JSON.stringify(state), JSON.stringify(await fx.owner.ok('hermes.get', {}))];
    for (const seen of answers) for (const key of [eleven, mine, gemini]) expect(seen).not.toContain(key);

    const after = await fx.owner.ok<HermesState>('hermes.update', { apis: { MINHA_API_KEY: null } });
    expect(after.apis.map((a) => a.envVar)).toEqual(['ELEVENLABS_API_KEY']);
    expect((await hermes.event<HermesConfig>('hermes.config', (c) => c.version === 2)).apis).toEqual({ ELEVENLABS_API_KEY: eleven });
  });

  it('refuses system, Hermes and GhostLink variables, a name without a key suffix, an AI in apis, a nameless one and the 31st key', async () => {
    const { fx } = await setup();
    for (const name of ['PATH', 'LD_PRELOAD', 'PYTHONPATH', 'NODE_OPTIONS', 'HTTPS_PROXY', 'HERMES_HOME', 'GHOSTLINK_BOT', 'DEEPSEEK_API_KEY', 'MINHA_API', 'MY_PROXY_KEY_X']) {
      expect(await fx.owner.fail('hermes.update', { apis: { [name]: { name: 'x', value: fakeKey('x') } } }), name).toBe('BAD_REQUEST');
    }
    expect(await fx.owner.fail('hermes.update', { apis: { SEM_NOME_KEY: { value: fakeKey('x') } } })).toBe('BAD_REQUEST');
    const thirty = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`API_${i}_KEY`, { name: `API ${i}`, value: fakeKey(String(i)) }]));
    await fx.owner.ok('hermes.update', { apis: thirty });
    expect(await fx.owner.fail('hermes.update', { keys: { 'openai-api': fakeKey('openai') } })).toBe('BAD_REQUEST');
    expect((await fx.owner.ok<HermesState>('hermes.get', {})).apis).toHaveLength(30);
  });
});
