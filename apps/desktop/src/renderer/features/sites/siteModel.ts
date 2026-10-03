// The SITES category (spec 2026-10-03-aba-api-e-sites-design.md §2): who manages it, what it shows, the
// register form's checks. No React and no stores' state, so the tests load it.
import { SITE_LIMITS, normalizeSiteDomain, type Channel, type Edition, type HermesView, type Site } from '@ghostlink/shared';
import { sortedChannels } from '../../stores/channels.js';

/**
 * Who registers, edits and removes sites (plan decision 2): the owner and the page's role (whoever gets
 * the company Hermes's page), in an Enterprise server with the function.
 */
export function canManageSites(o: { supported: boolean; edition: Edition; owner: boolean; view: HermesView | null }): boolean {
  return o.supported && o.edition === 'enterprise' && (o.owner || o.view !== null);
}

/** SITES shows in an Enterprise server with the function, when it has a site or the person manages them. */
export function showSitesSection(o: { supported: boolean; edition: Edition; sites: number; canManage: boolean }): boolean {
  return o.supported && o.edition === 'enterprise' && (o.sites > 0 || o.canManage);
}

/** The sites whose channel this app knows, by name, each with its channel. */
export function siteRows(sites: readonly Site[], channels: Readonly<Record<string, Channel>>): { site: Site; channel: Channel }[] {
  return sites
    .filter((s) => Object.hasOwn(channels, s.channelId))
    .map((site) => ({ site, channel: channels[site.channelId]! }))
    .sort((a, b) => a.site.name.localeCompare(b.site.name, 'pt-BR') || a.site.id.localeCompare(b.site.id));
}

/** A channel list without the channels shown under SITES ("Canais de texto"). */
export function withoutSites(channels: readonly Channel[], sites: readonly Site[]): Channel[] {
  const taken = new Set(sites.map((s) => s.channelId));
  return channels.filter((c) => !taken.has(c.id));
}

/** The text channels a new site may take: not a site yet, in their order. */
export function freeTextChannels(channels: Readonly<Record<string, Channel>>, sites: readonly Site[]): Channel[] {
  return withoutSites(sortedChannels(channels, 'text'), sites);
}

/** Plan decision 3: the free text channels named like a site (a bare domain), for "Cadastrar como sites". */
export function siteLikeChannels(channels: Readonly<Record<string, Channel>>, sites: readonly Site[]): Channel[] {
  return freeTextChannels(channels, sites).filter((c) => normalizeSiteDomain(c.name) === c.name);
}

export type SiteFormProblem = 'name' | 'domain' | 'limit';

/** The register / edit form: what is wrong, or null. `domain` is what the person typed. */
export function siteFormProblem(f: { name: string; domain: string; creating: boolean; count: number }): SiteFormProblem | null {
  if (f.name.trim() === '') return 'name';
  if (normalizeSiteDomain(f.domain) === null) return 'domain';
  if (f.creating && f.count >= SITE_LIMITS.maxSites) return 'limit';
  return null;
}
