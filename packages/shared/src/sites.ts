// The Sites category (spec 2026-10-03-aba-api-e-sites-design.md §2, `enterpriseSites`): in an Enterprise
// server a site is a text channel with a name and a bare domain, shown under SITES below BOTS. The
// channel keeps its history and its permissions; removing the site leaves the channel.
//
// Requests (the owner and the company Hermes page's viewer role, FORBIDDEN for anyone else; then
// ENTERPRISE_REQUIRED on a normal server):
//   - `site.create { name, domain, channelId }` → { site }: `channelId` a text channel the person sees
//     that is not a site yet, or null for a new public text channel named after the domain.
//   - `site.update { id, name?, domain? }` → { site }.
//   - `site.delete { id }` → {}: the channel stays and goes back to "Canais de texto".
//   NOT_FOUND: a site or channel the person cannot see. BAD_REQUEST: 50 sites, a domain in use, a channel
//   that already is a site, a voice channel, an empty name.
// Event `sites.state { sites }` to each member when the sites they see change (only those whose channel
//   they see); their welcome carries `sites` on an Enterprise server.
// To the company Hermes: hermes.config's `sites`, all of them (companyHermes.ts).
import { z } from 'zod';
import { entityIdSchema } from './chat.js';

/** welcome.features (v0.7.0): the Sites category. */
export const FEATURE_ENTERPRISE_SITES = 'enterpriseSites';

export const SITE_LIMITS = {
  maxSites: 50,
  /** Graphemes, after sanitizeLabel. */
  nameMax: 64,
  domainMax: 253,
  /** site.create / update / delete per person per minute ("Cadastrar como sites" sends one per channel). */
  changesPerMinute: 60,
} as const;

export interface Site {
  id: string;
  name: string;
  /** A bare domain, lowercase: "es.profetacristao.com". */
  domain: string;
  channelId: string;
}

/** A site as hermes.config carries it: no key, ever. */
export type HermesSite = Site;

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const TOP_LABEL = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/**
 * A pasted address as a bare domain, or null when it is not one: " https://Es.ProfetaCristao.com/ " →
 * "es.profetacristao.com". A path, a query, a port, a user or a password ("sem caminho e sem segredo"),
 * spaces, an IP address and a single label are refused.
 */
export function normalizeSiteDomain(raw: string): string | null {
  let s = raw.trim().toLowerCase().replace(/^https?:\/\//, '');
  if (s.endsWith('/')) s = s.slice(0, -1);
  if (s.endsWith('.')) s = s.slice(0, -1);
  if (s.length === 0 || s.length > SITE_LIMITS.domainMax) return null;
  const labels = s.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l)) || !TOP_LABEL.test(labels.at(-1)!)) return null;
  return s;
}

// ---- server side: strict ----

const siteName = z.string().min(1).max(256); // cut to SITE_LIMITS.nameMax graphemes by sanitizeLabel
const siteDomain = z
  .string()
  .max(SITE_LIMITS.domainMax)
  .refine((d) => normalizeSiteDomain(d) === d, 'not a bare lowercase domain');

export const siteCreateSchema = z.strictObject({ name: siteName, domain: siteDomain, channelId: entityIdSchema.nullable() });
export const siteUpdateSchema = z
  .strictObject({ id: entityIdSchema, name: siteName.optional(), domain: siteDomain.optional() })
  .refine((p) => p.name !== undefined || p.domain !== undefined, 'nothing to update');
export const siteDeleteSchema = z.strictObject({ id: entityIdSchema });

// ---- client side: lenient ----

export const siteSchemaClient: z.ZodType<Site> = z.object({
  id: z.string().max(64),
  name: z.string().max(256),
  domain: z.string().max(300),
  channelId: z.string().max(64),
});
export const sitesSchemaClient: z.ZodType<Site[]> = z.array(siteSchemaClient).max(200).catch([]);
/** The `sites.state` event. */
export const sitesStateSchemaClient = z.object({ sites: sitesSchemaClient });
