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
  status: { model: { provider: 'deepseek', model: 'deepseek-v4-pro' }, fallback: null, keys: { deepseek: 'ok', openrouter: 'missing' }, unsupported: null, envOverride: [] },
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
    expect(state.keys).toEqual({ deepseek: { last4: key.slice(-4) }, openrouter: null });
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
});
