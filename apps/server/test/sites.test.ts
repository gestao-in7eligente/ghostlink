import { describe, expect, it } from 'vitest';
import type { BotCreateResult, Channel, Edition, HermesConfig, Site } from '@ghostlink/shared';
import { createAvatarsModule } from '../src/avatars/index.js';
import { createBotsModule } from '../src/bots/index.js';
import { createCompanyHermesModule } from '../src/companyHermes/index.js';
import { createSitesModule } from '../src/sites/index.js';
import { connectBot } from './helpers/botClient.js';
import { fakeEnterprise } from './helpers/enterprise.js';
import { channelId, nextClientMsgId, textFixture, type TextClient, type TextFixture } from './text/helpers.js';

async function setup(edition: Edition = 'enterprise') {
  const enterprise = fakeEnterprise(edition);
  const fx = await textFixture({ extraModules: [createAvatarsModule(), createBotsModule(), enterprise, createCompanyHermesModule(), createSitesModule()] });
  return { fx, enterprise };
}

/** Ana, in a role without permissions that the owner makes the company Hermes page's role. */
async function pageRole(fx: TextFixture): Promise<TextClient> {
  const { role } = await fx.owner.ok<{ role: { id: string } }>('role.create', { name: 'Marketing', permissions: 0 });
  const ana = await fx.join({ nickname: 'Ana' });
  await fx.owner.ok('member.setRoles', { userId: ana.userId, roleIds: [role.id] });
  await fx.owner.ok('hermes.update', { viewerRoleId: role.id });
  return ana;
}

const sitesOf = (c: TextClient, pred: (sites: Site[]) => boolean) => c.event<{ sites: Site[] }>('sites.state', (d) => pred(d.sites)).then((d) => d.sites);

describe('the Sites category (spec 2026-10-03-aba-api-e-sites §2)', () => {
  it('the owner and the page role register sites; anyone else FORBIDDEN; a normal server ENTERPRISE_REQUIRED', async () => {
    const { fx } = await setup();
    const ana = await pageRole(fx);
    const bia = await fx.join({ nickname: 'Bia' });
    expect(await bia.fail('site.create', { name: 'Loja', domain: 'loja.tcflag.com.br', channelId: null })).toBe('FORBIDDEN');

    // "Criar canal novo": a public text channel named after the address, even without MANAGE_CHANNELS.
    const { site } = await ana.ok<{ site: Site }>('site.create', { name: 'Profeta Cristão ES', domain: 'es.profetacristao.com', channelId: null });
    expect(site).toMatchObject({ name: 'Profeta Cristão ES', domain: 'es.profetacristao.com' });
    const created = await bia.event<{ channel: Channel }>('channel.created', (d) => d.channel.id === site.channelId);
    expect(created.channel).toMatchObject({ name: 'es.profetacristao.com', type: 'text', private: false });
    expect(await sitesOf(bia, (s) => s.length === 1)).toEqual([site]);
    expect(await ana.fail('site.create', { name: 'De novo', domain: 'es.profetacristao.com', channelId: null })).toBe('BAD_REQUEST');

    const edited = await ana.ok<{ site: Site }>('site.update', { id: site.id, name: 'Profeta ES' });
    expect(edited.site).toEqual({ ...site, name: 'Profeta ES' });
    expect(await bia.fail('site.delete', { id: site.id })).toBe('FORBIDDEN');

    const normal = await setup('normal');
    expect(await normal.fx.owner.fail('site.create', { name: 'Loja', domain: 'loja.tcflag.com.br', channelId: null })).toBe('ENTERPRISE_REQUIRED');
  });

  it('an existing channel becomes a site with its history; removing the site gives the channel back', async () => {
    const { fx } = await setup();
    const geral = channelId(fx.owner, 'geral');
    const sent = await fx.owner.ok<{ message: { id: number } }>('msg.send', { channelId: geral, content: 'histórico', clientMsgId: nextClientMsgId() });
    const { site } = await fx.owner.ok<{ site: Site }>('site.create', { name: 'Loja', domain: 'loja.tcflag.com.br', channelId: geral });
    expect(site.channelId).toBe(geral);
    const history = await fx.owner.ok<{ messages: { id: number }[] }>('msg.history', { channelId: geral });
    expect(history.messages.map((m) => m.id)).toContain(sent.message.id);
    expect(await fx.owner.fail('site.create', { name: 'Outro', domain: 'outro.tcflag.com.br', channelId: geral })).toBe('BAD_REQUEST');

    await fx.owner.ok('site.delete', { id: site.id });
    expect(await sitesOf(fx.owner, (s) => s.length === 0)).toEqual([]);
    const again = await fx.owner.ok<{ messages: { id: number }[] }>('msg.history', { channelId: geral });
    expect(again.messages.map((m) => m.id)).toContain(sent.message.id);
  });

  it('who cannot see the channel cannot see the site; the company Hermes gets every site, another bot nothing', async () => {
    const { fx, enterprise } = await setup();
    const ana = await fx.join({ nickname: 'Ana' });
    const { channel } = await fx.owner.ok<{ channel: Channel }>('channel.create', { name: 'interno', type: 'text', private: true });
    const created = await fx.owner.ok<BotCreateResult>('hermes.create', { name: 'TC Hermes' });
    const other = await fx.owner.ok<BotCreateResult>('bot.create', { name: 'Outro bot' });
    const hermes = (await connectBot(fx, created.connectionToken)).client!;
    const impostor = (await connectBot(fx, other.connectionToken)).client!;
    await hermes.event<HermesConfig>('hermes.config');

    const { site } = await fx.owner.ok<{ site: Site }>('site.create', { name: 'Interno', domain: 'interno.tcflag.com.br', channelId: channel.id });
    expect((await hermes.event<HermesConfig>('hermes.config', (c) => c.sites.length === 1)).sites).toEqual([site]);
    await Promise.all([ana.sync(), impostor.sync()]);
    expect(ana.seen('sites.state')).toEqual([]);
    expect(impostor.seen('hermes.config')).toEqual([]);
    expect(await ana.fail('site.update', { id: site.id, name: 'x' })).toBe('FORBIDDEN');

    // The server stops being Enterprise: the owner's list empties; the rows stay for a renewal.
    fx.owner.clear();
    enterprise.set('normal');
    expect(await sitesOf(fx.owner, (s) => s.length === 0)).toEqual([]);
    fx.owner.clear();
    enterprise.set('enterprise');
    expect(await sitesOf(fx.owner, (s) => s.length === 1)).toEqual([site]);

    // Deleting the channel takes its site: the Hermes gets the new list.
    const back = (await connectBot(fx, created.connectionToken)).client!;
    await back.event<HermesConfig>('hermes.config', (c) => c.sites.length === 1);
    fx.owner.clear();
    await fx.owner.ok('channel.delete', { id: channel.id });
    expect((await back.event<HermesConfig>('hermes.config', (c) => c.sites.length === 0)).sites).toEqual([]);
    expect(await sitesOf(fx.owner, (s) => s.length === 0)).toEqual([]);
  });
});
