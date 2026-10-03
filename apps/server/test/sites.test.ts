import { describe, expect, it } from 'vitest';
import { PERMISSIONS, type BotCreateResult, type Channel, type Edition, type HermesConfig, type Site } from '@ghostlink/shared';
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

describe('the Sites category: visibility, limits and refusals', () => {
  it("a role or channel permission change adds or removes the site in that person's sites.state and welcome", async () => {
    const { fx } = await setup();
    const { role } = await fx.owner.ok<{ role: { id: string } }>('role.create', { name: 'Interno', permissions: 0 });
    const bia = await fx.join({ nickname: 'Bia' });
    const { channel } = await fx.owner.ok<{ channel: Channel }>('channel.create', { name: 'interno', type: 'text', private: true, allowedRoleIds: [role.id] });
    const { site } = await fx.owner.ok<{ site: Site }>('site.create', { name: 'Interno', domain: 'interno.tcflag.com.br', channelId: channel.id });
    await bia.sync();
    expect(bia.seen('sites.state')).toEqual([]);

    // Granting the role shows the site; removing it hides it again.
    await fx.owner.ok('member.setRoles', { userId: bia.userId, roleIds: [role.id] });
    expect(await sitesOf(bia, (s) => s.length === 1)).toEqual([site]);
    bia.clear();
    await fx.owner.ok('member.setRoles', { userId: bia.userId, roleIds: [] });
    expect(await sitesOf(bia, (s) => s.length === 0)).toEqual([]);

    // The welcome leaves out a site whose channel the person does not see.
    const cy = await fx.join({ nickname: 'Cy' });
    expect(cy.welcome.sites).toEqual([]);

    // channel.update to private / allowed roles.
    const { channel: open } = await fx.owner.ok<{ channel: Channel }>('channel.create', { name: 'aberto', type: 'text' });
    const { site: openSite } = await fx.owner.ok<{ site: Site }>('site.create', { name: 'Aberto', domain: 'aberto.tcflag.com.br', channelId: open.id });
    expect(await sitesOf(bia, (s) => s.length === 1)).toEqual([openSite]);
    bia.clear();
    await fx.owner.ok('channel.update', { id: open.id, private: true, allowedRoleIds: [] });
    expect(await sitesOf(bia, (s) => s.length === 0)).toEqual([]);
    bia.clear();
    await fx.owner.ok('channel.update', { id: open.id, allowedRoleIds: [role.id] });
    await fx.owner.ok('member.setRoles', { userId: bia.userId, roleIds: [role.id] });
    expect((await sitesOf(bia, (s) => s.length === 2)).map((x) => x.id).sort()).toEqual([openSite.id, site.id].sort());
    const joined = await fx.join({ nickname: 'Bia', seed: bia.seed });
    expect((joined.welcome.sites as Site[]).length).toBe(2);
    expect(cy.welcome.sites).toEqual([]);
  });

  it("a normal server's welcome has no sites; after a renewal the list reaches those who joined meanwhile", async () => {
    const { fx, enterprise } = await setup();
    const { site } = await fx.owner.ok<{ site: Site }>('site.create', { name: 'Loja', domain: 'loja.tcflag.com.br', channelId: null });
    enterprise.set('normal');
    const bia = await fx.join({ nickname: 'Bia' });
    expect(bia.welcome.sites).toBeUndefined();
    enterprise.set('enterprise');
    expect(await sitesOf(bia, (s) => s.length === 1)).toEqual([site]);
  });

  it('a site on a hidden channel is NOT_FOUND for the role holder (create, update, delete)', async () => {
    const { fx } = await setup();
    const ana = await pageRole(fx);
    const { channel } = await fx.owner.ok<{ channel: Channel }>('channel.create', { name: 'interno', type: 'text', private: true });
    const { site } = await fx.owner.ok<{ site: Site }>('site.create', { name: 'Interno', domain: 'interno.tcflag.com.br', channelId: channel.id });
    expect(await ana.fail('site.create', { name: 'X', domain: 'x.tcflag.com.br', channelId: channel.id })).toBe('NOT_FOUND');
    expect(await ana.fail('site.update', { id: site.id, name: 'X' })).toBe('NOT_FOUND');
    expect(await ana.fail('site.delete', { id: site.id })).toBe('NOT_FOUND');
  });

  it('BAD_REQUEST: a voice channel, a pasted URL, a domain in use', async () => {
    const { fx } = await setup();
    const { channel: voice } = await fx.owner.ok<{ channel: Channel }>('channel.create', { name: 'sala', type: 'voice' });
    expect(await fx.owner.fail('site.create', { name: 'V', domain: 'v.tcflag.com.br', channelId: voice.id })).toBe('BAD_REQUEST');
    expect(await fx.owner.fail('site.create', { name: 'X', domain: 'https://X.com/', channelId: null })).toBe('BAD_REQUEST');
    const { site } = await fx.owner.ok<{ site: Site }>('site.create', { name: 'A', domain: 'a.tcflag.com.br', channelId: null });
    const { site: b } = await fx.owner.ok<{ site: Site }>('site.create', { name: 'B', domain: 'b.tcflag.com.br', channelId: null });
    expect(await fx.owner.fail('site.update', { id: b.id, domain: site.domain })).toBe('BAD_REQUEST');
  });

  it('50 sites at most; 60 changes a minute per person', async () => {
    const { fx } = await setup();
    for (let i = 0; i < 50; i++) {
      const { channel } = await fx.owner.ok<{ channel: Channel }>('channel.create', { name: `ch${i}`, type: 'text' });
      await fx.owner.ok('site.create', { name: `S${i}`, domain: `d${i}.tcflag.com.br`, channelId: channel.id });
    }
    const { channel } = await fx.owner.ok<{ channel: Channel }>('channel.create', { name: 'extra', type: 'text' });
    expect(await fx.owner.fail('site.create', { name: 'S', domain: 'extra.tcflag.com.br', channelId: channel.id })).toBe('BAD_REQUEST');

    const other = await setup();
    const { site } = await other.fx.owner.ok<{ site: Site }>('site.create', { name: 'A', domain: 'a.tcflag.com.br', channelId: null });
    for (let i = 0; i < 59; i++) await other.fx.owner.ok('site.update', { id: site.id, name: `N${i}` });
    expect(await other.fx.owner.fail('site.update', { id: site.id, name: 'N' })).toBe('RATE_LIMITED');
  });

  it('"Criar canal novo" is limited to 10 new channels an hour; an existing channel named after the domain is reused; removing keeps the channel', async () => {
    const { fx } = await setup();
    let firstChannel = '';
    for (let i = 0; i < 10; i++) {
      const { site } = await fx.owner.ok<{ site: Site }>('site.create', { name: `S${i}`, domain: `n${i}.tcflag.com.br`, channelId: null });
      if (i === 0) firstChannel = site.channelId;
      await fx.owner.ok('site.delete', { id: site.id });
      // The channel stays, with its history.
      await fx.owner.ok('msg.history', { channelId: site.channelId });
    }
    expect(await fx.owner.fail('site.create', { name: 'S', domain: 'n10.tcflag.com.br', channelId: null })).toBe('RATE_LIMITED');
    // The channel named after the address is reused, which costs nothing.
    fx.owner.clear();
    const again = await fx.owner.ok<{ site: Site }>('site.create', { name: 'S0 de novo', domain: 'n0.tcflag.com.br', channelId: null });
    await fx.owner.sync();
    expect(fx.owner.seen('channel.created')).toEqual([]);
    expect(again.site.channelId).toBe(firstChannel);
  });

  it('every site change bumps the hermes.config version', async () => {
    const { fx } = await setup();
    const created = await fx.owner.ok<BotCreateResult>('hermes.create', { name: 'TC Hermes' });
    const hermes = (await connectBot(fx, created.connectionToken)).client!;
    let version = (await hermes.event<HermesConfig>('hermes.config')).version;
    const next = async (): Promise<void> => {
      const c = await hermes.event<HermesConfig>('hermes.config', (x) => x.version > version);
      version = c.version;
    };
    const { site } = await fx.owner.ok<{ site: Site }>('site.create', { name: 'A', domain: 'a.tcflag.com.br', channelId: null });
    await next();
    await fx.owner.ok('site.update', { id: site.id, name: 'B' });
    await next();
    await fx.owner.ok('site.delete', { id: site.id });
    await next();
  });
});

describe('the Sites category: which channels a role holder may use', () => {
  it('never reuses a hidden or private channel named after the domain; makes a public one', async () => {
    const { fx } = await setup();
    const ana = await pageRole(fx);
    const { channel: hidden } = await fx.owner.ok<{ channel: Channel }>('channel.create', { name: 'oculto.tcflag.com.br', type: 'text', private: true });
    const { site } = await ana.ok<{ site: Site }>('site.create', { name: 'Oculto', domain: 'oculto.tcflag.com.br', channelId: null });
    expect(site.channelId).not.toBe(hidden.id);
    const created = await fx.owner.event<{ channel: Channel }>('channel.created', (d) => d.channel.id === site.channelId);
    expect(created.channel.private).toBe(false);
    // The owner sees the private one but gets a public channel too: reuse is for public channels only.
    const { site: mine } = await fx.owner.ok<{ site: Site }>('site.create', { name: 'Meu', domain: 'meu.tcflag.com.br', channelId: null });
    const { channel: priv } = await fx.owner.ok<{ channel: Channel }>('channel.create', { name: 'privado.tcflag.com.br', type: 'text', private: true });
    const { site: other } = await fx.owner.ok<{ site: Site }>('site.create', { name: 'Privado', domain: 'privado.tcflag.com.br', channelId: null });
    expect(other.channelId).not.toBe(priv.id);
    expect(mine.channelId).toBeTruthy();
  });

  it('the role holder needs SEND_MESSAGES in an existing channel; the owner is not asked', async () => {
    const { fx } = await setup();
    const ana = await pageRole(fx);
    const geral = channelId(fx.owner, 'geral');
    const everyone = fx.owner.text.roles.find((r) => r.isDefault)!;
    await fx.owner.ok('role.update', { id: everyone.id, permissions: everyone.permissions & ~PERMISSIONS.SEND_MESSAGES });
    expect(await ana.fail('site.create', { name: 'Loja', domain: 'loja.tcflag.com.br', channelId: geral })).toBe('FORBIDDEN');
    await fx.owner.ok('site.create', { name: 'Loja', domain: 'loja.tcflag.com.br', channelId: geral });
  });
});
