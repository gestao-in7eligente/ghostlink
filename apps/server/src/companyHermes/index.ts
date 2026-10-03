import {
  FEATURE_ENTERPRISE_HERMES,
  FEATURE_ENTERPRISE_HERMES_VIEW,
  HERMES_LIMITS,
  ProtocolError,
  hermesCreateSchema,
  hermesGetSchema,
  hermesMemoryDeleteSchema,
  hermesReportSchema,
  hermesUpdateSchema,
  hermesViewGetSchema,
  type BotCreateResult,
  type HermesConfig,
  type HermesSkill,
  type HermesState,
  type HermesView,
} from '@ghostlink/shared';
import { BOTS_MODULE_NAME, type BotsModule } from '../bots/index.js';
import { getMeta } from '../db/serverMeta.js';
import { enterpriseOf, type EnterpriseModule } from '../enterprise/index.js';
import type { ModuleContext, RequestHandler, ServerEvent, ServerModule, SessionInfo } from '../modules.js';
import { SlidingWindowLimiter } from '../ratelimit/limiter.js';
import { TEXT_MODULE_NAME, type TextModule } from '../text/index.js';
import { HermesStore, type HermesRecord } from './store.js';

export const COMPANY_HERMES_MODULE_NAME = 'companyHermes';

/**
 * The company's own Hermes (spec 2026-10-02-enterprise-e-hermes-da-empresa-design.md §2) and its
 * page for the owner and a chosen role (spec 2026-10-03-pagina-do-hermes-da-empresa-design.md).
 * Register after bots and enterprise.
 */
export interface CompanyHermesModule extends ServerModule {
  readonly name: typeof COMPANY_HERMES_MODULE_NAME;
}

interface State {
  ctx: ModuleContext;
  store: HermesStore;
  bots: BotsModule;
  enterprise: EnterpriseModule | null;
  text: TextModule;
  changes: SlidingWindowLimiter;
  reports: SlidingWindowLimiter;
}

export function createCompanyHermesModule(): CompanyHermesModule {
  let state: State | null = null;
  /** The last known company-Hermes bot id and owner id: a removal or a transfer only matters for these. */
  let lastBot: string | null = null;
  let lastOwner: string | null = null;
  /** The last known viewer role: deleting it (ON DELETE SET NULL) changes the owner's state. */
  let lastViewerRole: string | null = null;
  /** Per user, the page their apps have now (JSON): a change goes out once, a loss as `view: null`. */
  const sentViews = new Map<string, string>();
  const need = (): State => {
    if (!state) throw new Error('the companyHermes module is not initialized');
    return state;
  };

  const isEnterprise = (s: State): boolean => s.enterprise?.edition === 'enterprise';
  const ownerId = (s: State): string | null => getMeta(s.ctx.db).ownerUserId;
  const requireOwner = (s: State, userId: string): void => {
    if (userId !== ownerId(s)) throw new ProtocolError('FORBIDDEN');
  };
  const requireEnterprise = (s: State): void => {
    if (!isEnterprise(s)) throw new ProtocolError('ENTERPRISE_REQUIRED');
  };
  const sessionsOf = (s: State, userId: string): SessionInfo[] => s.ctx.sessions.list().filter((x) => x.userId === userId);

  /** The owner's view: keys only as their last 4 characters. */
  const stateOf = (s: State): HermesState => {
    const r = s.store.load();
    const last4 = (key: string | null) => (key === null ? null : { last4: key.slice(-4) });
    return {
      botId: r.botId,
      connected: r.botId !== null && sessionsOf(s, r.botId).length > 0,
      locked: !isEnterprise(s),
      keys: { deepseek: last4(r.keys.deepseek), openrouter: last4(r.keys.openrouter) },
      settings: r.settings,
      version: r.version,
      report: r.report,
      reportAt: r.reportAt,
      viewerRoleId: r.viewerRoleId,
    };
  };

  const idsIn = (s: State, table: 'roles' | 'channels'): Set<string> => new Set(s.ctx.db.all<{ id: string }>(`SELECT id FROM ${table}`).map((x) => x.id));

  /**
   * The page (spec 2026-10-03 §2), built once per change, then per viewer: no key, no memory. The
   * skills on as the Skills tab shows them; the access with only the roles and channels that still
   * exist. A role holder gets only the chosen channels they can see, the rest counted in
   * `hiddenChannels` and never named; `viewer` null is the owner, who sees them all.
   */
  const pagesOf = (s: State, r: HermesRecord): ((viewer: string | null) => HermesView) => {
    const disabled = r.settings.disabledSkills;
    const on = (k: HermesSkill) => k.locked || (disabled === null ? k.enabled : !disabled.includes(k.name));
    const { roleIds, channels } = r.settings.access;
    const roles = idsIn(s, 'roles');
    const existing = channels === 'all' ? null : idsIn(s, 'channels');
    const chosen = channels === 'all' ? null : channels.filter((id) => existing?.has(id) === true);
    const base = {
      botId: r.botId,
      connected: r.botId !== null && sessionsOf(s, r.botId).length > 0,
      models: r.settings.models,
      modelInUse: r.report?.status.model ?? null,
      skills: r.report === null ? null : r.report.skills.filter(on).map(({ name, description }) => ({ name, description })),
    };
    const shownRoles = roleIds.filter((id) => roles.has(id));
    return (viewer) => {
      const shown = chosen === null || viewer === null ? chosen : chosen.filter((id) => s.text.voiceAccess.permissions(viewer, id) !== 0);
      return {
        ...base,
        access: { roleIds: shownRoles, channels: shown ?? 'all' },
        hiddenChannels: chosen === null || shown === null ? 0 : chosen.length - shown.length,
      };
    };
  };

  /** The owner's page: every chosen channel, plus how many memory items there are (never their text). */
  const ownerPageOf = (r: HermesRecord, page: (viewer: string | null) => HermesView): HermesView => ({
    ...page(null),
    memory: r.report === null ? null : { company: r.report.memory.company.length, people: r.report.memory.people.length },
  });

  /** The viewer role's members, who see the page while the server is Enterprise (spec 2026-10-03 §1). */
  const roleHolders = (s: State, r: HermesRecord): string[] =>
    r.viewerRoleId === null || !isEnterprise(s)
      ? []
      : s.ctx.db.all<{ user_id: string }>('SELECT user_id FROM user_roles WHERE role_id = ?', r.viewerRoleId).map((x) => x.user_id);

  /** The page this user may see now, or null. */
  const viewFor = (s: State, userId: string): HermesView | null => {
    const r = s.store.load();
    const page = pagesOf(s, r);
    if (userId === ownerId(s)) return ownerPageOf(r, page);
    return roleHolders(s, r).includes(userId) ? page(userId) : null;
  };

  /** `hermes.view` to whoever sees the page when what they see changed; `view: null` to whoever just lost it. */
  const announceView = (s: State): void => {
    const r = s.store.load();
    const page = pagesOf(s, r);
    const audience = new Map<string, HermesView>(roleHolders(s, r).map((userId) => [userId, page(userId)]));
    const owner = ownerId(s);
    if (owner !== null) audience.set(owner, ownerPageOf(r, page));
    const send = (userId: string, view: HermesView | null) => {
      for (const x of sessionsOf(s, userId)) s.ctx.sessions.send(x.sessionId, { t: 'hermes.view', d: { view } });
    };
    for (const [userId, view] of audience) {
      const json = JSON.stringify(view);
      if (sentViews.get(userId) === json) continue;
      sentViews.set(userId, json);
      send(userId, view);
    }
    for (const userId of [...sentViews.keys()]) {
      if (audience.has(userId)) continue;
      sentViews.delete(userId);
      send(userId, null);
    }
  };

  /** `hermes.config` to the company Hermes's session: the only place its keys ever go. */
  const sendConfig = (s: State, only?: SessionInfo): void => {
    const r = s.store.load();
    if (r.botId === null || !isEnterprise(s)) return;
    const event: ServerEvent = { t: 'hermes.config', d: { version: r.version, keys: r.keys, ...r.settings } satisfies HermesConfig };
    for (const x of only ? [only] : sessionsOf(s, r.botId)) s.ctx.sessions.send(x.sessionId, event);
  };

  /** `hermes.state` to the owner's sessions (the settings open there follow it live), then the page. */
  const announce = (s: State): void => {
    const r = s.store.load();
    lastBot = r.botId;
    lastViewerRole = r.viewerRoleId;
    const owner = ownerId(s);
    if (owner !== null) {
      lastOwner = owner;
      const sessions = sessionsOf(s, owner);
      const d = sessions.length > 0 ? stateOf(s) : null;
      for (const x of sessions) s.ctx.sessions.send(x.sessionId, { t: 'hermes.state', d });
    }
    announceView(s);
  };

  const handlers: Record<string, RequestHandler> = {
    'hermes.create': (rc, payload): BotCreateResult => {
      const p = hermesCreateSchema.parse(payload);
      const s = need();
      requireOwner(s, rc.userId);
      requireEnterprise(s);
      if (s.store.load().botId !== null) throw new ProtocolError('BAD_REQUEST', 'the company Hermes exists');
      const created = s.bots.createBot(rc, p.name);
      s.store.setBot(created.bot.userId);
      announce(s);
      return created;
    },

    'hermes.get': (rc, payload): HermesState => {
      hermesGetSchema.parse(payload ?? {});
      const s = need();
      requireOwner(s, rc.userId);
      return stateOf(s);
    },

    'hermes.update': (rc, payload): HermesState => {
      const { viewerRoleId, ...change } = hermesUpdateSchema.parse(payload);
      const s = need();
      requireOwner(s, rc.userId);
      requireEnterprise(s);
      if (!s.changes.hit(rc.userId)) throw new ProtocolError('RATE_LIMITED');
      if (viewerRoleId !== undefined && viewerRoleId !== null) {
        const role = s.ctx.db.get<{ is_default: number }>('SELECT is_default FROM roles WHERE id = ?', viewerRoleId);
        if (!role) throw new ProtocolError('NOT_FOUND');
        if (Number(role.is_default) === 1) throw new ProtocolError('BAD_REQUEST', 'the viewer role cannot be @everyone');
      }
      // The viewer role is GhostLink's alone: changing only it sends the Hermes nothing.
      const forHermes = change.keys !== undefined || change.models !== undefined || change.disabledSkills !== undefined || change.access !== undefined;
      s.ctx.db.tx(() => {
        if (forHermes) s.store.update(change);
        if (viewerRoleId !== undefined) s.store.setViewerRole(viewerRoleId);
      });
      if (forHermes) sendConfig(s);
      announce(s);
      return stateOf(s);
    },

    'hermes.view': (rc, payload): { view: HermesView } => {
      hermesViewGetSchema.parse(payload ?? {});
      const view = viewFor(need(), rc.userId);
      if (view === null) throw new ProtocolError('FORBIDDEN');
      return { view };
    },

    'hermes.memory.delete': (rc, payload) => {
      const p = hermesMemoryDeleteSchema.parse(payload);
      const s = need();
      requireOwner(s, rc.userId);
      requireEnterprise(s);
      if (!s.changes.hit(rc.userId)) throw new ProtocolError('RATE_LIMITED');
      const botId = s.store.load().botId;
      if (botId === null) throw new ProtocolError('NOT_FOUND');
      const sent = sessionsOf(s, botId).filter((x) => s.ctx.sessions.send(x.sessionId, { t: 'hermes.memory.delete', d: p })).length;
      if (sent === 0) throw new ProtocolError('BOT_OFFLINE');
      return {};
    },

    'hermes.report': (rc, payload) => {
      const p = hermesReportSchema.parse(payload);
      const s = need();
      if (s.store.load().botId !== rc.userId) throw new ProtocolError('FORBIDDEN');
      requireEnterprise(s);
      if (!s.reports.hit(rc.userId)) throw new ProtocolError('RATE_LIMITED');
      s.store.saveReport(p, s.ctx.now());
      announce(s);
      return {};
    },
  };

  return {
    name: COMPANY_HERMES_MODULE_NAME,
    features: [FEATURE_ENTERPRISE_HERMES, FEATURE_ENTERPRISE_HERMES_VIEW],
    handlers,

    init(c) {
      state = {
        ctx: c,
        store: new HermesStore(c.db),
        bots: c.getModule<BotsModule>(BOTS_MODULE_NAME),
        enterprise: enterpriseOf(c),
        text: c.getModule<TextModule>(TEXT_MODULE_NAME),
        changes: new SlidingWindowLimiter(HERMES_LIMITS.changesPerMinute, 60_000, c.now),
        reports: new SlidingWindowLimiter(HERMES_LIMITS.reportsPerMinute, 60_000, c.now),
      };
      const s = state;
      s.enterprise?.onChange((edition) => {
        const botId = s.store.load().botId;
        // Lapsed: disconnected now, refused at the door (auth/botAuth.ts) until a renewal.
        if (edition === 'normal' && botId !== null) s.ctx.sessions.closeUser(botId, 'ENTERPRISE_REQUIRED');
        announce(s);
      });
      // The company Hermes deleted: its bot_id is NULL now; the owner's panel follows.
      const r = s.store.load();
      lastBot = r.botId;
      lastViewerRole = r.viewerRoleId;
      lastOwner = ownerId(s);
      const text = s.text;
      text.events.on('membership.removed', ({ userId }) => {
        if (userId === lastBot) announce(s);
        else announceView(s); // a viewer who left stops getting the page
      });
      // An ownership transfer: the new owner's open apps learn the state. The viewer role deleted:
      // the owner's state says "nenhum". A role given or taken: the page starts or stops at once.
      text.events.on('access.changed', () => {
        const owner = ownerId(s);
        const transfer = owner !== lastOwner && lastOwner !== null; // not the server's first owner
        lastOwner = owner;
        if (transfer || s.store.load().viewerRoleId !== lastViewerRole) announce(s);
        else announceView(s);
      });
      // A channel it answers in was deleted: the page lists the ones left.
      text.events.on('channel.deleted', () => announceView(s));
    },

    welcome: (session) => {
      const s = need();
      const owner = session.userId === ownerId(s);
      const view = viewFor(s, session.userId);
      if (view === null) return owner ? { hermes: stateOf(s) } : {};
      sentViews.set(session.userId, JSON.stringify(view));
      return owner ? { hermes: stateOf(s), hermesView: view } : { hermesView: view };
    },

    onSessionOpened(session) {
      const s = need();
      if (s.store.load().botId !== session.userId) return;
      // The handshake refuses it on a normal server; this covers a lapse in between.
      if (!isEnterprise(s)) {
        s.ctx.sessions.closeUser(session.userId, 'ENTERPRISE_REQUIRED');
        return;
      }
      sendConfig(s, session);
      announce(s);
    },

    onSessionClosed(session, info) {
      const s = need();
      if (!info.graceExpired && s.store.load().botId === session.userId) announce(s);
    },
  };
}
