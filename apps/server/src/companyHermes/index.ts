import {
  FEATURE_ENTERPRISE_HERMES,
  HERMES_LIMITS,
  ProtocolError,
  hermesCreateSchema,
  hermesGetSchema,
  hermesMemoryDeleteSchema,
  hermesReportSchema,
  hermesUpdateSchema,
  type BotCreateResult,
  type HermesConfig,
  type HermesState,
} from '@ghostlink/shared';
import { BOTS_MODULE_NAME, type BotsModule } from '../bots/index.js';
import { getMeta } from '../db/serverMeta.js';
import { enterpriseOf, type EnterpriseModule } from '../enterprise/index.js';
import type { ModuleContext, RequestHandler, ServerEvent, ServerModule, SessionInfo } from '../modules.js';
import { SlidingWindowLimiter } from '../ratelimit/limiter.js';
import { TEXT_MODULE_NAME, type TextModule } from '../text/index.js';
import { HermesStore } from './store.js';

export const COMPANY_HERMES_MODULE_NAME = 'companyHermes';

/**
 * The company's own Hermes (spec 2026-10-02-enterprise-e-hermes-da-empresa-design.md §2). Register
 * after bots and enterprise.
 */
export interface CompanyHermesModule extends ServerModule {
  readonly name: typeof COMPANY_HERMES_MODULE_NAME;
}

interface State {
  ctx: ModuleContext;
  store: HermesStore;
  bots: BotsModule;
  enterprise: EnterpriseModule | null;
  changes: SlidingWindowLimiter;
  reports: SlidingWindowLimiter;
}

export function createCompanyHermesModule(): CompanyHermesModule {
  let state: State | null = null;
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
    };
  };

  /** `hermes.config` to the company Hermes's session: the only place its keys ever go. */
  const sendConfig = (s: State, only?: SessionInfo): void => {
    const r = s.store.load();
    if (r.botId === null || !isEnterprise(s)) return;
    const event: ServerEvent = { t: 'hermes.config', d: { version: r.version, keys: r.keys, ...r.settings } satisfies HermesConfig };
    for (const x of only ? [only] : sessionsOf(s, r.botId)) s.ctx.sessions.send(x.sessionId, event);
  };

  /** `hermes.state` to the owner's sessions (the settings open there follow it live). */
  const announce = (s: State): void => {
    const owner = ownerId(s);
    if (owner === null) return;
    const sessions = sessionsOf(s, owner);
    if (sessions.length === 0) return;
    const d = stateOf(s);
    for (const x of sessions) s.ctx.sessions.send(x.sessionId, { t: 'hermes.state', d });
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
      const p = hermesUpdateSchema.parse(payload);
      const s = need();
      requireOwner(s, rc.userId);
      requireEnterprise(s);
      if (!s.changes.hit(rc.userId)) throw new ProtocolError('RATE_LIMITED');
      s.store.update(p);
      sendConfig(s);
      announce(s);
      return stateOf(s);
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
    features: [FEATURE_ENTERPRISE_HERMES],
    handlers,

    init(c) {
      state = {
        ctx: c,
        store: new HermesStore(c.db),
        bots: c.getModule<BotsModule>(BOTS_MODULE_NAME),
        enterprise: enterpriseOf(c),
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
      c.getModule<TextModule>(TEXT_MODULE_NAME).events.on('membership.removed', () => announce(s));
    },

    welcome: (session) => {
      const s = need();
      return session.userId === ownerId(s) ? { hermes: stateOf(s) } : {};
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
