import {
  ENTERPRISE_LIMITS,
  FEATURE_ENTERPRISE,
  LICENSE_LIMITS,
  LICENSE_PUBLIC_KEY,
  ProtocolError,
  checkLicense,
  enterpriseLicenseSetSchema,
  fromBase64Url,
  grantsEnterprise,
  type Edition,
  type EnterpriseLicenseInfo,
  type EnterpriseState,
  type LicenseCheck,
} from '@ghostlink/shared';
import { verifyAuthSignature } from '../auth/identity.js';
import { getMeta } from '../db/serverMeta.js';
import type { ModuleContext, ServerModule } from '../modules.js';
import { SlidingWindowLimiter } from '../ratelimit/limiter.js';
import { TEXT_MODULE_NAME, type TextModule } from '../text/index.js';

export const ENTERPRISE_MODULE_NAME = 'enterprise';

/**
 * Enterprise servers (spec 2026-10-02-enterprise-e-hermes-da-empresa-design.md §1): the license,
 * `enterprise.license.set`, the welcome's `enterprise` and the `enterprise.state` event. Register
 * after text, before companyHermes and ghostDj (they read the edition in their init).
 */
export interface EnterpriseModule extends ServerModule {
  readonly name: typeof ENTERPRISE_MODULE_NAME;
  /** 'enterprise' while the stored license is valid for this server, up to 7 days past its validity. */
  readonly edition: Edition;
  /** Runs after each change of edition (pasted, renewed, lapsed); returns the unsubscribe. */
  onChange(listener: (edition: Edition) => void): () => void;
  /** Checks the stored license again now (it also runs at start, when one is pasted and every hour). */
  recheck(): void;
}

export interface EnterpriseModuleOptions {
  /** The license public key (raw base64url); default LICENSE_PUBLIC_KEY. Tests pass a key made for the run. */
  publicKey?: string;
  /** How often the license is checked again; default 1 h. */
  checkEveryMs?: number;
}

/** The enterprise module, or null where a test server runs without it (then the server is normal). */
export function enterpriseOf(ctx: Pick<ModuleContext, 'getModule'>): EnterpriseModule | null {
  try {
    return ctx.getModule<EnterpriseModule>(ENTERPRISE_MODULE_NAME);
  } catch {
    return null;
  }
}

const CHECK_EVERY_MS = 3_600_000;

/** The raw 32-byte key, or null ('' before the key ceremony: every license is then invalid). */
function rawKey(b64u: string): Uint8Array | null {
  try {
    const raw = fromBase64Url(b64u);
    return raw.length === 32 ? raw : null;
  } catch {
    return null;
  }
}

export function createEnterpriseModule(opts: EnterpriseModuleOptions = {}): EnterpriseModule {
  const publicKey = rawKey(opts.publicKey ?? LICENSE_PUBLIC_KEY);
  const listeners = new Set<(edition: Edition) => void>();
  let ctx: ModuleContext | null = null;
  let limiter: SlidingWindowLimiter | null = null;
  let timer: NodeJS.Timeout | null = null;
  let edition: Edition = 'normal';
  let license: EnterpriseLicenseInfo | null = null;
  let lastOwner: string | null = null;

  const need = (): ModuleContext => {
    if (!ctx) throw new Error('the enterprise module is not initialized');
    return ctx;
  };
  const ownerId = (c: ModuleContext): string | null => getMeta(c.db).ownerUserId;

  const check = (c: ModuleContext, text: string): LicenseCheck =>
    checkLicense(text, {
      serverKeyId: c.serverKeyId,
      now: c.now(),
      verify: (signed, signature) => publicKey !== null && verifyAuthSignature(publicKey, signed, signature),
    });

  const infoOf = (r: LicenseCheck): EnterpriseLicenseInfo => ({
    state: r.state,
    company: r.data?.company ?? null,
    issuedAt: r.data?.issuedAt ?? null,
    expiresAt: r.data?.expiresAt ?? null,
    graceEndsAt: r.data ? r.data.expiresAt + LICENSE_LIMITS.graceMs : null,
  });

  const stateFor = (c: ModuleContext, userId: string): EnterpriseState => (userId === ownerId(c) ? { edition, license } : { edition });

  const sendToOwner = (c: ModuleContext): void => {
    const owner = ownerId(c);
    for (const s of c.sessions.list()) if (s.userId === owner) c.sessions.send(s.sessionId, { t: 'enterprise.state', d: stateFor(c, s.userId) });
  };

  /** Evaluates the stored license; mirrors the edition for the bot handshake; tells whoever must know. */
  const recheck = (): void => {
    const c = ctx;
    if (!c) return;
    const text = c.db.get<{ license: string | null }>('SELECT license FROM enterprise WHERE id = 1')?.license ?? null;
    const result = text === null ? null : check(c, text);
    const nextLicense = result ? infoOf(result) : null;
    const nextEdition: Edition = result !== null && grantsEnterprise(result.state) ? 'enterprise' : 'normal';
    const editionChanged = nextEdition !== edition;
    const licenseChanged = JSON.stringify(nextLicense) !== JSON.stringify(license);
    edition = nextEdition;
    license = nextLicense;
    // auth/botAuth.ts reads it: the company Hermes is refused at a normal server's door.
    c.db.run("INSERT INTO enterprise (id, edition) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET edition = excluded.edition", edition);
    if (editionChanged) {
      c.logger.info('server edition changed', { edition });
      for (const s of c.sessions.list()) c.sessions.send(s.sessionId, { t: 'enterprise.state', d: stateFor(c, s.userId) });
      for (const listener of [...listeners]) {
        try {
          listener(edition);
        } catch (e) {
          c.logger.error('an edition listener failed', { error: String(e) });
        }
      }
    } else if (licenseChanged) {
      sendToOwner(c);
    }
  };

  const module: EnterpriseModule = {
    name: ENTERPRISE_MODULE_NAME,
    features: [FEATURE_ENTERPRISE],
    get edition() {
      return edition;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    recheck,

    handlers: {
      'enterprise.license.set': (rc, payload): EnterpriseState => {
        const p = enterpriseLicenseSetSchema.parse(payload);
        const c = need();
        if (rc.userId !== ownerId(c)) throw new ProtocolError('FORBIDDEN');
        if (!limiter!.hit(rc.userId)) throw new ProtocolError('RATE_LIMITED');
        const text = p.license.trim();
        const result = check(c, text);
        if (result.state === 'expired') throw new ProtocolError('LICENSE_EXPIRED');
        if (!grantsEnterprise(result.state)) throw new ProtocolError('LICENSE_INVALID');
        c.db.run(
          `INSERT INTO enterprise (id, license, set_by, set_at) VALUES (1, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET license = excluded.license, set_by = excluded.set_by, set_at = excluded.set_at`,
          text,
          rc.userId,
          c.now(),
        );
        recheck();
        return stateFor(c, rc.userId);
      },
    },

    init(c) {
      ctx = c;
      limiter = new SlidingWindowLimiter(ENTERPRISE_LIMITS.licenseSetsPerMinute, 60_000, c.now);
      recheck();
      lastOwner = ownerId(c);
      try {
        // An ownership transfer: the new owner's open sessions learn the license.
        c.getModule<TextModule>(TEXT_MODULE_NAME).events.on('access.changed', () => {
          const owner = ownerId(c);
          if (owner === lastOwner) return;
          lastOwner = owner;
          sendToOwner(c);
        });
      } catch {
        // no text module (a unit test): nothing to follow
      }
    },

    start() {
      timer = setInterval(() => {
        try {
          recheck();
          limiter?.sweep();
        } catch (e) {
          // One failed check must not stop the server; the next one tries again.
          ctx?.logger.error('the license check failed', { error: e instanceof Error ? e.name : 'error' });
        }
      }, opts.checkEveryMs ?? CHECK_EVERY_MS);
      timer.unref();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },

    welcome: (session) => ({ enterprise: stateFor(need(), session.userId) }),
  };
  return module;
}
