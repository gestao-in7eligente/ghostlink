import {
  FEATURE_SERVER_DELETE,
  ProtocolError,
  SERVER_DELETE_LIMITS,
  serverDeleteSchema,
  serverRestoreSchema,
  type ServerDeleteResult,
  type ServerDeleteWelcome,
  type ServerDeletingEvent,
  type ServerRestoreResult,
} from '@ghostlink/shared';
import { getMeta } from '../db/serverMeta.js';
import type { ModuleContext, RequestContext, ServerModule } from '../modules.js';
import { SlidingWindowLimiter } from '../ratelimit/limiter.js';
import { eraseDatabase, eraseFiles } from './erase.js';
import { clearDeleting, deletionState, markDeleting } from './state.js';

export const SERVER_DELETE_MODULE = 'serverDelete';

export interface ServerDeleteModuleOptions {
  /** Tests only: how often the deadline is checked (default SERVER_DELETE_LIMITS.checkIntervalMs). */
  checkIntervalMs?: number;
}

/** The `serverDelete` module plus what tests may call. */
export interface ServerDeleteModule extends ServerModule {
  readonly name: typeof SERVER_DELETE_MODULE;
  /** The periodic check, run now: past the deadline, closes every session and erases the data. */
  check(): void;
}

/** An errno code (EBUSY…) or SQLite's message, never a path. */
function errorOf(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code !== 'ERR_SQLITE_ERROR') return code;
  return e instanceof Error ? e.message : 'unknown';
}

/**
 * Deleting the server (spec 2026-10-01-sair-e-excluir-servidor-design.md §3–§4):
 *   - `server.delete {}` (owner only, 5 per hour): sets `deleting_at = now + 48 h`, sends
 *     `server.deleting { at }` to everyone and closes every session but the owner's with
 *     SERVER_DELETING (the error carries `at`). A repeat keeps the first deadline.
 *   - `server.restore {}` (owner only, 5 per hour, before the deadline): clears it and sends
 *     `server.restored {}`.
 *   - At the deadline (checked at start-up and every minute): closes every session with
 *     SERVER_DELETED and erases the data (erase.ts); the TLS certificate stays.
 * The handshake (auth/) refuses everyone but the owner while the deadline runs, and everyone
 * after it, from server_meta alone, so the refusal holds even before this module checks.
 * Register it last: its onSessionOpened may close the session it was told about.
 */
export function createServerDeleteModule(opts: ServerDeleteModuleOptions = {}): ServerDeleteModule {
  let ctx: ModuleContext | null = null;
  let deletes!: SlidingWindowLimiter;
  let restores!: SlidingWindowLimiter;
  let timer: NodeJS.Timeout | null = null;
  /** Set once an erase finished without leftovers; until then every check past the deadline erases again. */
  let erased = false;

  const need = (): ModuleContext => {
    if (!ctx) throw new Error('the serverDelete module is not initialized');
    return ctx;
  };

  const state = (c: ModuleContext) => deletionState(getMeta(c.db), c.now());

  const requireOwner = (c: RequestContext): void => {
    if (getMeta(c.db).ownerUserId !== c.userId) throw new ProtocolError('FORBIDDEN');
  };

  const erase = (c: ModuleContext): void => {
    // Sessions first, while the data still exists: the other modules' close hooks see a normal server.
    for (const session of c.sessions.list()) c.sessions.closeUser(session.userId, 'SERVER_DELETED');
    if (erased) return;
    let ok = true;
    try {
      eraseDatabase(c.db, c.now());
    } catch (e) {
      ok = false;
      c.logger.error('server deletion: the database could not be erased yet; trying again at the next check', { error: errorOf(e) });
    }
    const failed = eraseFiles(c.dataDir);
    if (failed > 0) {
      ok = false;
      c.logger.warn('server deletion: some files could not be deleted yet; trying again at the next check', { failed });
    }
    if (ok) {
      erased = true;
      c.logger.info('server deleted: its data was erased (the TLS certificate stays)');
    }
  };

  const check = (): void => {
    const c = need();
    deletes.sweep();
    restores.sweep();
    if (state(c).phase === 'deleted') erase(c);
  };

  /** The deadline passed between two checks: erase now and answer SERVER_DELETED. */
  const deletedNow = (c: ModuleContext): ProtocolError => {
    erase(c);
    return new ProtocolError('SERVER_DELETED');
  };

  return {
    name: SERVER_DELETE_MODULE,
    features: [FEATURE_SERVER_DELETE],
    check,

    handlers: {
      'server.delete': (rc, payload) => {
        serverDeleteSchema.parse(payload ?? {});
        const c = need();
        requireOwner(rc);
        if (!deletes.hit(rc.userId)) throw new ProtocolError('RATE_LIMITED');
        const current = state(c);
        if (current.phase === 'deleted') throw deletedNow(c);
        const at = markDeleting(c.db, current.phase === 'deleting' ? current.at : c.now() + SERVER_DELETE_LIMITS.graceMs);
        if (at === null) throw deletedNow(c);
        if (current.phase === 'active') c.logger.info('server deletion requested by the owner', { at: new Date(at).toISOString() });
        const event: ServerDeletingEvent = { at };
        c.sessions.broadcast({ t: 'server.deleting', d: event });
        for (const session of c.sessions.list()) {
          if (session.userId !== rc.userId) c.sessions.closeUser(session.userId, 'SERVER_DELETING', { at });
        }
        const result: ServerDeleteResult = { at };
        return result;
      },

      'server.restore': (rc, payload) => {
        serverRestoreSchema.parse(payload ?? {});
        const c = need();
        requireOwner(rc);
        if (!restores.hit(rc.userId)) throw new ProtocolError('RATE_LIMITED');
        const current = state(c);
        if (current.phase === 'deleted') throw deletedNow(c);
        if (current.phase === 'deleting' && clearDeleting(c.db)) {
          c.logger.info('server deletion cancelled by the owner');
          c.sessions.broadcast({ t: 'server.restored', d: {} });
        }
        const result: ServerRestoreResult = {};
        return result;
      },
    },

    init(c) {
      ctx = c;
      erased = false;
      deletes = new SlidingWindowLimiter(SERVER_DELETE_LIMITS.perWindow, SERVER_DELETE_LIMITS.windowMs, c.now);
      restores = new SlidingWindowLimiter(SERVER_DELETE_LIMITS.perWindow, SERVER_DELETE_LIMITS.windowMs, c.now);
      // A server that starts after its deadline erases before it listens (spec §3.5).
      check();
    },

    start() {
      timer = setInterval(check, opts.checkIntervalMs ?? SERVER_DELETE_LIMITS.checkIntervalMs);
      timer.unref();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },

    welcome: () => {
      const current = state(need());
      const serverDelete: ServerDeleteWelcome = { deletingAt: current.phase === 'deleting' ? current.at : null };
      return { serverDelete };
    },

    onSessionOpened(session) {
      // The handshake already refused this person; this only catches a server.delete that ran
      // between their admission and their welcome. Deferred so every module sees the open first.
      queueMicrotask(() => {
        const c = need();
        const current = state(c);
        if (current.phase === 'deleted') {
          c.sessions.closeUser(session.userId, 'SERVER_DELETED');
        } else if (current.phase === 'deleting' && session.userId !== getMeta(c.db).ownerUserId) {
          c.sessions.send(session.sessionId, { t: 'server.deleting', d: { at: current.at } satisfies ServerDeletingEvent });
          c.sessions.closeUser(session.userId, 'SERVER_DELETING', { at: current.at });
        }
      });
    },
  };
}
