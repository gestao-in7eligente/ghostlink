import { describe, expect, it } from 'vitest';
import type { Channel, HermesView, Site } from '@ghostlink/shared';
import { canManageSites, freeTextChannels, showSitesSection, siteFormProblem, siteLikeChannels, siteRows, withoutSites } from '../../src/renderer/features/sites/siteModel.js';

const channel = (id: string, name: string, position: number, type: Channel['type'] = 'text'): Channel => ({ id, name, type, topic: '', position, private: false, allowedRoleIds: [], userLimit: 0, lastMessageId: 0 });
const byId = {
  g: channel('g', 'geral', 0),
  e: channel('e', 'es.profetacristao.com', 1),
  l: channel('l', 'loja.tcflag.com.br', 2),
  v: channel('v', 'v0.6.3', 3),
  c: channel('c', 'Chamada', 4, 'voice'),
};
const site = (id: string, name: string, channelId: string): Site => ({ id, name, domain: `${id}.com`, channelId });
const view = {} as HermesView;

describe('the SITES category (spec 2026-10-03-aba-api-e-sites §2)', () => {
  it('the owner and the page role manage sites, in an Enterprise server with the function', () => {
    expect(canManageSites({ supported: true, edition: 'enterprise', owner: true, view: null })).toBe(true);
    expect(canManageSites({ supported: true, edition: 'enterprise', owner: false, view })).toBe(true);
    expect(canManageSites({ supported: true, edition: 'enterprise', owner: false, view: null })).toBe(false);
    expect(canManageSites({ supported: true, edition: 'normal', owner: true, view: null })).toBe(false);
    expect(canManageSites({ supported: false, edition: 'enterprise', owner: true, view: null })).toBe(false);
  });

  it('SITES shows with a site, or to whoever manages them', () => {
    expect(showSitesSection({ supported: true, edition: 'enterprise', sites: 1, canManage: false })).toBe(true);
    expect(showSitesSection({ supported: true, edition: 'enterprise', sites: 0, canManage: true })).toBe(true);
    expect(showSitesSection({ supported: true, edition: 'enterprise', sites: 0, canManage: false })).toBe(false);
    expect(showSitesSection({ supported: true, edition: 'normal', sites: 2, canManage: true })).toBe(false);
  });

  it('a site’s channel leaves "Canais de texto"; sites sort by name and need their channel', () => {
    const sites = [site('z', 'Zeta', 'l'), site('a', 'Alfa', 'e'), site('x', 'Sem canal', 'gone')];
    expect(siteRows(sites, byId).map((r) => [r.site.name, r.channel.id])).toEqual([['Alfa', 'e'], ['Zeta', 'l']]);
    expect(withoutSites(Object.values(byId), sites).map((c) => c.id)).toEqual(['g', 'v', 'c']);
    expect(freeTextChannels(byId, sites).map((c) => c.id)).toEqual(['g', 'v']);
  });

  it('suggests the text channels named like a site that are not sites yet (decision 3)', () => {
    expect(siteLikeChannels(byId, []).map((c) => c.id)).toEqual(['e', 'l']);
    expect(siteLikeChannels(byId, [site('a', 'Alfa', 'e')]).map((c) => c.id)).toEqual(['l']);
  });

  it('checks the form: a name, a bare address, at most 50', () => {
    expect(siteFormProblem({ name: 'Loja', domain: 'https://loja.tcflag.com.br/', creating: true, count: 0 })).toBeNull();
    expect(siteFormProblem({ name: ' ', domain: 'loja.tcflag.com.br', creating: true, count: 0 })).toBe('name');
    expect(siteFormProblem({ name: 'Loja', domain: 'loja.tcflag.com.br/blog', creating: true, count: 0 })).toBe('domain');
    expect(siteFormProblem({ name: 'Loja', domain: 'loja.tcflag.com.br', creating: true, count: 50 })).toBe('limit');
    expect(siteFormProblem({ name: 'Loja', domain: 'loja.tcflag.com.br', creating: false, count: 50 })).toBeNull();
  });
});
