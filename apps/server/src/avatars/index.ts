import { join } from 'node:path';
import { AVATAR_LIMITS, FEATURE_AVATARS, ProtocolError, avatarClearSchema } from '@ghostlink/shared';
import type { ModuleContext, ServerModule } from '../modules.js';
import { SlidingWindowLimiter } from '../ratelimit/limiter.js';
import { TEXT_MODULE_NAME, type TextModule } from '../text/index.js';
import { UploadHub } from '../uploads/hub.js';
import { pathOf } from '../uploads/http.js';
import { AVATARS_PREFIX, finishAvatarUpload, serveAvatar, type AvatarHttpDeps } from './http.js';
import { AvatarStore } from './store.js';

export const AVATARS_MODULE_NAME = 'avatars';
export const UPLOAD_PATH = '/upload';

export interface AvatarsModule extends ServerModule {
  readonly name: typeof AVATARS_MODULE_NAME;
  /**
   * The upload hub behind `upload.begin` and `POST /upload` (main spec §4), which this module
   * answers for every purpose. Others register theirs in their init (the files module:
   * `attachment`). Usable once this module's init ran: register those modules after it.
   */
  readonly uploads: UploadHub;
}

export interface AvatarsModuleOptions {
  /** Tests only: cut an upload after this long without a byte (default 60 s). */
  uploadIdleMs?: number;
}

const UPLOAD_IDLE_MS = 60_000;
const SWEEP_INTERVAL_MS = 60_000;
const CHANGES_WINDOW_MS = 60_000;

interface State {
  ctx: ModuleContext;
  text: TextModule;
  store: AvatarStore;
  hub: UploadHub;
  /** Photo changes per person (upload.begin and avatar.clear together). */
  changes: SlidingWindowLimiter;
  http: AvatarHttpDeps;
}

/**
 * Profile photos (spec 2026-10-01-foto-de-perfil-design.md §4): the `avatars` flag,
 * `upload.begin` + `POST /upload` (for every purpose, through the upload hub: see
 * `uploads`), `avatar.clear`, the signed `GET /avatars/<hash>` and
 * the clean-up of files no member uses. The member's photo is `users.avatar_file_id`
 * (the SHA-256 in hex), which the text module already puts in every Member. Register it
 * after the text module. URLs, tokens, hashes and bytes never reach the log.
 */
export function createAvatarsModule(opts: AvatarsModuleOptions = {}): AvatarsModule {
  let state: State | null = null;
  let sweepTimer: NodeJS.Timeout | null = null;
  let unsubscribe: (() => void) | null = null;

  const need = (): State => {
    if (!state) throw new Error('the avatars module is not initialized');
    return state;
  };

  const isMember = (s: State, userId: string): boolean =>
    s.ctx.db.get('SELECT 1 AS x FROM users WHERE id = ? AND removed_at IS NULL', userId) !== undefined;

  const requireMember = (s: State, userId: string): void => {
    if (!isMember(s, userId)) throw new ProtocolError('FORBIDDEN');
  };

  /** Deletes every stored photo no user points at. Synchronous (see AvatarStore). */
  const cleanUp = (s: State): void => {
    const used = new Set(
      s.ctx.db.all<{ h: string }>('SELECT DISTINCT avatar_file_id AS h FROM users WHERE avatar_file_id IS NOT NULL').map((r) => r.h),
    );
    let failed: number;
    try {
      failed = s.store.sweep(used);
    } catch {
      failed = 1;
    }
    if (failed > 0) s.ctx.logger.warn('some unused profile photos could not be deleted yet', { failed });
  };

  /**
   * At start: nobody outside the server keeps a photo (removed members lose it, as leaving
   * does), a photo whose file is gone is forgotten (the app uploads it again at its next
   * welcome), and files from a crash or with no user go.
   */
  const reconcile = (s: State): void => {
    s.store.open();
    s.ctx.db.run('UPDATE users SET avatar_file_id = NULL WHERE removed_at IS NOT NULL AND avatar_file_id IS NOT NULL');
    const stored = s.store.hashes();
    const used = s.ctx.db.all<{ h: string }>('SELECT DISTINCT avatar_file_id AS h FROM users WHERE avatar_file_id IS NOT NULL').map((r) => r.h);
    for (const hash of used) {
      if (!stored.has(hash)) s.ctx.db.run('UPDATE users SET avatar_file_id = NULL WHERE avatar_file_id = ?', hash);
    }
    cleanUp(s);
  };

  return {
    name: AVATARS_MODULE_NAME,
    features: [FEATURE_AVATARS],

    get uploads(): UploadHub {
      return need().hub;
    },

    handlers: {
      // Every purpose: the hub checks the schema and the open tokens, the purpose the rest.
      'upload.begin': (ctx, payload) => need().hub.begin(ctx, payload),

      'avatar.clear': (ctx, payload) => {
        avatarClearSchema.parse(payload ?? {});
        const s = need();
        requireMember(s, ctx.userId);
        if (!s.changes.hit(ctx.userId)) throw new ProtocolError('RATE_LIMITED');
        const changed = s.ctx.db.run('UPDATE users SET avatar_file_id = NULL WHERE id = ? AND avatar_file_id IS NOT NULL', ctx.userId).changes > 0;
        if (changed) {
          cleanUp(s);
          s.text.announceMember(ctx.userId);
        }
        return {};
      },
    },

    init(ctx) {
      const text = ctx.getModule<TextModule>(TEXT_MODULE_NAME);
      const store = new AvatarStore(join(ctx.dataDir, 'avatars'));
      const uploads = new UploadHub({
        now: ctx.now,
        logger: ctx.logger,
        fileToken: (sessionId) => ctx.sessions.fileToken(sessionId),
        idleMs: opts.uploadIdleMs ?? UPLOAD_IDLE_MS,
      });
      const s: State = {
        ctx,
        text,
        store,
        hub: uploads,
        changes: new SlidingWindowLimiter(AVATAR_LIMITS.changesPerMinute, CHANGES_WINDOW_MS, ctx.now),
        http: {
          now: ctx.now,
          logger: ctx.logger,
          store,
          fileToken: (sessionId) => ctx.sessions.fileToken(sessionId),
          canApply: (grant) => ctx.sessions.fileToken(grant.sessionId) !== null && isMember(s, grant.userId),
          apply: (userId, hash) => {
            ctx.db.run('UPDATE users SET avatar_file_id = ? WHERE id = ? AND removed_at IS NULL', hash, userId);
            cleanUp(s);
            text.announceMember(userId);
          },
          inUse: (hash) => ctx.db.get('SELECT 1 AS x FROM users WHERE avatar_file_id = ? AND removed_at IS NULL LIMIT 1', hash) !== undefined,
        },
      };
      uploads.register('avatar', {
        stagingDir: store.dir,
        maxBytes: () => AVATAR_LIMITS.maxBytes,
        begin: (rctx) => {
          requireMember(s, rctx.userId);
          if (!s.changes.hit(rctx.userId)) throw new ProtocolError('RATE_LIMITED');
          return {};
        },
        canApply: (grant) => s.http.canApply(grant),
        finish: (grant, body) => finishAvatarUpload(s.http, grant, body),
      });
      reconcile(s);
      // Kick, ban and leave: the photo goes with the membership.
      unsubscribe = text.events.on('membership.removed', ({ userId }) => {
        ctx.db.run('UPDATE users SET avatar_file_id = NULL WHERE id = ? AND avatar_file_id IS NOT NULL', userId);
        cleanUp(s);
      });
      state = s;
      sweepTimer = setInterval(() => {
        s.changes.sweep();
        s.hub.tokens.sweep();
      }, SWEEP_INTERVAL_MS);
      sweepTimer.unref();
    },

    stop() {
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = null;
      unsubscribe?.();
      unsubscribe = null;
    },

    onSessionClosed(session, info) {
      if (!info.graceExpired) state?.hub.tokens.dropSession(session.sessionId);
    },

    http(req, res) {
      const path = pathOf(req.url);
      if (path === UPLOAD_PATH) {
        need().hub.serve(req, res);
        return true;
      }
      if (path.startsWith(AVATARS_PREFIX)) {
        serveAvatar(need().http, req, res, path.slice(AVATARS_PREFIX.length));
        return true;
      }
      return false;
    },
  };
}
