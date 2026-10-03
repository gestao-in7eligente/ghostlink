import {
  FEATURE_ENTERPRISE_SITES,
  PERMISSIONS,
  ProtocolError,
  SITE_LIMITS,
  sanitizeLabel,
  siteCreateSchema,
  siteDeleteSchema,
  siteUpdateSchema,
  type Site,
} from '@ghostlink/shared';
import { COMPANY_HERMES_MODULE_NAME, type CompanyHermesModule } from '../companyHermes/index.js';
import { enterpriseOf, type EnterpriseModule } from '../enterprise/index.js';
import type { ModuleContext, RequestHandler, ServerModule } from '../modules.js';
import { SlidingWindowLimiter } from '../ratelimit/limiter.js';
import { TEXT_MODULE_NAME, type TextModule } from '../text/index.js';
import { newEntityId } from '../text/repo.js';

export const SITES_MODULE_NAME = 'sites';

/**
 * The Sites category (spec 2026-10-03-aba-api-e-sites-design.md §2): sites are rows pointing at text
 * channels (the sidebar shows those channels under SITES). Managed by the owner and the company Hermes
 * page's role in an Enterprise server; each member sees the sites whose channel they see; the company
 * Hermes gets them all in hermes.config. Register after companyHermes.
 */
export interface SitesModule extends ServerModule {
  readonly name: typeof SITES_MODULE_NAME;
}

interface Row {
  id: string;
  name: string;
  domain: string;
  channel_id: string;
}

interface State {
  ctx: ModuleContext;
  text: TextModule;
  enterprise: EnterpriseModule | null;
  hermes: CompanyHermesModule;
  changes: SlidingWindowLimiter;
  /** "Criar canal novo" without MANAGE_CHANNELS: new channels per person per hour (a create/delete loop must not flood the server). */
  newChannels: SlidingWindowLimiter;
}

const NEW_CHANNELS_PER_HOUR = 10;

const toSite = (r: Row): Site => ({ id: r.id, name: r.name, domain: r.domain, channelId: r.channel_id });

export function createSitesModule(): SitesModule {
  let state: State | null = null;
  /** Per user, the list their apps have now (JSON): a change goes out once. Absent: none. */
  const sent = new Map<string, string>();
  /** What hermes.config last carried (JSON): a site lost with its channel sends a new version. */
  let forHermes = '[]';
  const need = (): State => {
    if (!state) throw new Error('the sites module is not initialized');
    return state;
  };

  const isEnterprise = (s: State): boolean => s.enterprise?.edition === 'enterprise';
  const all = (s: State): Site[] =>
    s.ctx.db
      .all<Row>('SELECT id, name, domain, channel_id FROM sites')
      .map(toSite)
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR') || a.id.localeCompare(b.id));
  const sees = (s: State, userId: string, channelId: string): boolean => s.text.voiceAccess.permissions(userId, channelId) !== 0;
  const listFor = (s: State, userId: string): Site[] => (isEnterprise(s) ? all(s).filter((x) => sees(s, userId, x.channelId)) : []);

  /** `sites.state` to whoever's list changed (`only`: just that user). */
  const announce = (s: State, only?: string): void => {
    const sessions = s.ctx.sessions.list();
    const users = new Set(sessions.map((x) => x.userId));
    for (const userId of only === undefined ? users : users.has(only) ? [only] : []) {
      const sites = listFor(s, userId);
      const json = JSON.stringify(sites);
      if ((sent.get(userId) ?? '[]') === json) continue;
      sent.set(userId, json);
      for (const x of sessions) if (x.userId === userId) s.ctx.sessions.send(x.sessionId, { t: 'sites.state', d: { sites } });
    }
  };

  /** A new hermes.config version when the company's sites changed. */
  const syncHermes = (s: State): void => {
    const json = JSON.stringify(all(s));
    if (json === forHermes) return;
    forHermes = json;
    s.hermes.sitesChanged();
  };

  const changed = (s: State): void => {
    announce(s);
    syncHermes(s);
  };

  const requireManager = (s: State, userId: string): void => {
    if (!s.hermes.seesPage(userId)) throw new ProtocolError('FORBIDDEN');
    if (!isEnterprise(s)) throw new ProtocolError('ENTERPRISE_REQUIRED');
    if (!s.changes.hit(userId)) throw new ProtocolError('RATE_LIMITED');
  };
  const visibleSite = (s: State, userId: string, id: string): Row => {
    const row = s.ctx.db.get<Row>('SELECT id, name, domain, channel_id FROM sites WHERE id = ?', id);
    if (!row || !sees(s, userId, row.channel_id)) throw new ProtocolError('NOT_FOUND');
    return row;
  };
  const cleanName = (raw: string): string => {
    const name = sanitizeLabel(raw, SITE_LIMITS.nameMax);
    if (name === '') throw new ProtocolError('BAD_REQUEST', 'empty site name');
    return name;
  };
  const requireFreeDomain = (s: State, domain: string, except?: string): void => {
    const row = s.ctx.db.get<{ id: string }>('SELECT id FROM sites WHERE domain = ?', domain);
    if (row && row.id !== except) throw new ProtocolError('BAD_REQUEST', 'a site has this domain');
  };

  const handlers: Record<string, RequestHandler> = {
    'site.create': (rc, payload) => {
      const p = siteCreateSchema.parse(payload);
      const s = need();
      requireManager(s, rc.userId);
      // Every check runs before anything is written, so a refusal never leaves a stray channel behind.
      // "Too many sites" and "domain in use" count hidden sites too: a role holder learns that one exists
      // (accepted: the company's sites are not secret from its managers, and the limit is global).
      const name = cleanName(p.name);
      if (all(s).length >= SITE_LIMITS.maxSites) throw new ProtocolError('BAD_REQUEST', 'too many sites');
      requireFreeDomain(s, p.domain);
      let channelId: string;
      if (p.channelId === null) {
        // Reuse a public text channel they see that is named after the domain and is not a site yet (the promise is a public channel).
        const reuse = s.ctx.db
          .all<{ id: string }>("SELECT id FROM channels WHERE type = 'text' AND private = 0 AND name = ? AND id NOT IN (SELECT channel_id FROM sites)", p.domain)
          .find((r) => sees(s, rc.userId, r.id));
        if (reuse) {
          channelId = reuse.id;
        } else {
          if (!s.newChannels.hit(rc.userId)) throw new ProtocolError('RATE_LIMITED');
          channelId = s.text.createTextChannel(p.domain);
        }
      } else {
        const channel = s.text.voiceAccess.channel(p.channelId);
        if (!channel || !sees(s, rc.userId, p.channelId)) throw new ProtocolError('NOT_FOUND');
        // The page role must not make the Hermes post where they cannot write themselves.
        if (!s.text.voiceAccess.isOwner(rc.userId) && (s.text.voiceAccess.permissions(rc.userId, p.channelId) & PERMISSIONS.SEND_MESSAGES) === 0) throw new ProtocolError('FORBIDDEN');
        if (channel.type !== 'text') throw new ProtocolError('BAD_REQUEST', 'a site needs a text channel');
        if (s.ctx.db.get('SELECT 1 AS x FROM sites WHERE channel_id = ?', p.channelId)) throw new ProtocolError('BAD_REQUEST', 'the channel already is a site');
        channelId = p.channelId;
      }
      const site: Site = { id: newEntityId(), name, domain: p.domain, channelId };
      s.ctx.db.run(
        'INSERT INTO sites (id, name, domain, channel_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        site.id, site.name, site.domain, site.channelId, rc.userId, s.ctx.now(),
      );
      changed(s);
      return { site };
    },

    'site.update': (rc, payload) => {
      const p = siteUpdateSchema.parse(payload);
      const s = need();
      requireManager(s, rc.userId);
      const row = visibleSite(s, rc.userId, p.id);
      const name = p.name === undefined ? row.name : cleanName(p.name);
      const domain = p.domain ?? row.domain;
      requireFreeDomain(s, domain, row.id);
      s.ctx.db.run('UPDATE sites SET name = ?, domain = ? WHERE id = ?', name, domain, row.id);
      changed(s);
      return { site: { id: row.id, name, domain, channelId: row.channel_id } satisfies Site };
    },

    'site.delete': (rc, payload) => {
      const p = siteDeleteSchema.parse(payload);
      const s = need();
      requireManager(s, rc.userId);
      const row = visibleSite(s, rc.userId, p.id);
      s.ctx.db.run('DELETE FROM sites WHERE id = ?', row.id);
      changed(s);
      return {};
    },
  };

  return {
    name: SITES_MODULE_NAME,
    features: [FEATURE_ENTERPRISE_SITES],
    handlers,

    init(c) {
      state = {
        ctx: c,
        text: c.getModule<TextModule>(TEXT_MODULE_NAME),
        enterprise: enterpriseOf(c),
        hermes: c.getModule<CompanyHermesModule>(COMPANY_HERMES_MODULE_NAME),
        changes: new SlidingWindowLimiter(SITE_LIMITS.changesPerMinute, 60_000, c.now),
        newChannels: new SlidingWindowLimiter(NEW_CHANNELS_PER_HOUR, 3_600_000, c.now),
      };
      const s = state;
      forHermes = JSON.stringify(all(s));
      s.hermes.useSites(() => all(s));
      s.enterprise?.onChange(() => announce(s));
      s.text.events.on('visibility.changed', ({ userId }) => announce(s, userId));
      s.text.events.on('access.changed', () => announce(s));
      // ON DELETE CASCADE took its site, if it had one.
      s.text.events.on('channel.deleted', () => changed(s));
      // The generated skill names each site's channel: a rename sends a new hermes.config (the list itself is the same).
      s.text.events.on('channel.renamed', ({ channelId }) => {
        if (s.ctx.db.get('SELECT 1 AS x FROM sites WHERE channel_id = ?', channelId)) s.hermes.sitesChanged();
      });
      s.text.events.on('membership.removed', ({ userId }) => sent.delete(userId));
    },

    welcome: (session) => {
      const s = need();
      if (!isEnterprise(s)) {
        // After a renewal announce() must send this user their list: their app has none.
        sent.set(session.userId, '[]');
        return {};
      }
      const sites = listFor(s, session.userId);
      sent.set(session.userId, JSON.stringify(sites));
      return { sites };
    },
  };
}
