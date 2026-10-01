import { join } from 'node:path';
import {
  AVATAR_LIMITS,
  FEATURE_AVATARS,
  FEATURE_SERVER_ICON,
  PERMISSIONS,
  ProtocolError,
  avatarClearSchema,
  has,
  serverIconClearSchema,
  uploadBeginSchema,
  type AvatarUploadResult,
  type IconUploadResult,
  type UploadBeginResult,
  type UploadPurpose,
} from '@ghostlink/shared';
import type { ModuleContext, ServerModule } from '../modules.js';
import { SlidingWindowLimiter } from '../ratelimit/limiter.js';
import { TEXT_MODULE_NAME, type TextModule } from '../text/index.js';
import { AVATARS_PREFIX, UPLOAD_PATH, pathOf, serveAvatar, serveUpload, type AvatarHttpDeps } from './http.js';
import { AvatarStore } from './store.js';
import { MAX_OPEN_UPLOADS_PER_SESSION, UploadTokens } from './uploads.js';

export const AVATARS_MODULE_NAME = 'avatars';

export interface AvatarsModule extends ServerModule {
  readonly name: typeof AVATARS_MODULE_NAME;
}

export interface AvatarsModuleOptions {
  /** Tests only: cut an upload after this long without a byte (default 60 s). */
  uploadIdleMs?: number;
}

const UPLOAD_IDLE_MS = 60_000;

/** The limiter's key: a person's photo changes and their icon changes are counted apart. */
const changeKey = (purpose: UploadPurpose, userId: string): string => (purpose === 'icon' ? `icon:${userId}` : userId);
const SWEEP_INTERVAL_MS = 60_000;
const CHANGES_WINDOW_MS = 60_000;

interface State {
  ctx: ModuleContext;
  text: TextModule;
  store: AvatarStore;
  tokens: UploadTokens;
  /** Changes per person: their photo (upload.begin and avatar.clear), and apart the server icon. */
  changes: SlidingWindowLimiter;
  http: AvatarHttpDeps;
}

/**
 * Profile photos (spec 2026-10-01-foto-de-perfil-design.md §4): the `avatars` flag,
 * `upload.begin` + `POST /upload`, `avatar.clear`, the signed `GET /avatars/<hash>` and
 * the clean-up of files no member uses. The member's photo is `users.avatar_file_id`
 * (the SHA-256 in hex), which the text module already puts in every Member. Register it
 * after the text module. URLs, tokens, hashes and bytes never reach the log.
 *
 * The server icon (spec 2026-10-01-icone-do-servidor) takes the same path: the `serverIcon`
 * flag, `upload.begin { purpose: 'icon' }` and `server.iconClear` with MANAGE_SERVER, the hash
 * in `server_meta.icon_file_id` (the text module puts it in ServerInfo) and `server.updated`.
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

  const managesServer = (s: State, userId: string): boolean => isMember(s, userId) && has(s.text.serverPermissions(userId), PERMISSIONS.MANAGE_SERVER);

  const serverIcon = (s: State): string | null =>
    s.ctx.db.get<{ h: string | null }>('SELECT icon_file_id AS h FROM server_meta WHERE id = 1')?.h ?? null;

  /** Deletes every stored image nobody points at (members' photos and the server icon). Synchronous (see AvatarStore). */
  const cleanUp = (s: State): void => {
    const used = new Set(
      s.ctx.db.all<{ h: string }>('SELECT DISTINCT avatar_file_id AS h FROM users WHERE avatar_file_id IS NOT NULL').map((r) => r.h),
    );
    const icon = serverIcon(s);
    if (icon !== null) used.add(icon);
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
    // An icon whose file is gone: initials until someone sets it again.
    const icon = serverIcon(s);
    if (icon !== null && !stored.has(icon)) s.ctx.db.run('UPDATE server_meta SET icon_file_id = NULL WHERE id = 1');
    cleanUp(s);
  };

  return {
    name: AVATARS_MODULE_NAME,
    features: [FEATURE_AVATARS, FEATURE_SERVER_ICON],

    handlers: {
      'upload.begin': (ctx, payload) => {
        const p = uploadBeginSchema.parse(payload);
        const s = need();
        requireMember(s, ctx.userId);
        if (p.purpose === 'icon' && !managesServer(s, ctx.userId)) throw new ProtocolError('FORBIDDEN');
        if (s.tokens.open(ctx.sessionId) >= MAX_OPEN_UPLOADS_PER_SESSION) throw new ProtocolError('RATE_LIMITED');
        if (!s.changes.hit(changeKey(p.purpose, ctx.userId))) throw new ProtocolError('RATE_LIMITED');
        const result: UploadBeginResult = {
          uploadToken: s.tokens.issue({ purpose: p.purpose, sessionId: ctx.sessionId, userId: ctx.userId, size: p.size, sha256: p.sha256 }),
        };
        return result;
      },

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

      'server.iconClear': (ctx, payload) => {
        serverIconClearSchema.parse(payload ?? {});
        const s = need();
        if (!managesServer(s, ctx.userId)) throw new ProtocolError('FORBIDDEN');
        if (!s.changes.hit(changeKey('icon', ctx.userId))) throw new ProtocolError('RATE_LIMITED');
        const changed = s.ctx.db.run('UPDATE server_meta SET icon_file_id = NULL WHERE id = 1 AND icon_file_id IS NOT NULL').changes > 0;
        if (changed) {
          cleanUp(s);
          s.text.announceServer();
        }
        return {};
      },
    },

    init(ctx) {
      const text = ctx.getModule<TextModule>(TEXT_MODULE_NAME);
      const store = new AvatarStore(join(ctx.dataDir, 'avatars'));
      const tokens = new UploadTokens(ctx.now);
      const s: State = {
        ctx,
        text,
        store,
        tokens,
        changes: new SlidingWindowLimiter(AVATAR_LIMITS.changesPerMinute, CHANGES_WINDOW_MS, ctx.now),
        http: {
          now: ctx.now,
          logger: ctx.logger,
          store,
          tokens,
          idleMs: opts.uploadIdleMs ?? UPLOAD_IDLE_MS,
          fileToken: (sessionId) => ctx.sessions.fileToken(sessionId),
          canApply: (grant) =>
            ctx.sessions.fileToken(grant.sessionId) !== null && (grant.purpose === 'icon' ? managesServer(s, grant.userId) : isMember(s, grant.userId)),
          apply: (grant): AvatarUploadResult | IconUploadResult => {
            if (grant.purpose === 'icon') {
              ctx.db.run('UPDATE server_meta SET icon_file_id = ? WHERE id = 1', grant.sha256);
              cleanUp(s);
              text.announceServer();
              return { icon: grant.sha256 };
            }
            ctx.db.run('UPDATE users SET avatar_file_id = ? WHERE id = ? AND removed_at IS NULL', grant.sha256, grant.userId);
            cleanUp(s);
            text.announceMember(grant.userId);
            return { avatar: grant.sha256 };
          },
          inUse: (hash) =>
            serverIcon(s) === hash || ctx.db.get('SELECT 1 AS x FROM users WHERE avatar_file_id = ? AND removed_at IS NULL LIMIT 1', hash) !== undefined,
        },
      };
      reconcile(s);
      // Kick, ban and leave: the photo goes with the membership.
      unsubscribe = text.events.on('membership.removed', ({ userId }) => {
        ctx.db.run('UPDATE users SET avatar_file_id = NULL WHERE id = ? AND avatar_file_id IS NOT NULL', userId);
        cleanUp(s);
      });
      state = s;
      sweepTimer = setInterval(() => {
        s.changes.sweep();
        s.tokens.sweep();
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
      if (!info.graceExpired) state?.tokens.dropSession(session.sessionId);
    },

    http(req, res) {
      const path = pathOf(req.url);
      if (path === UPLOAD_PATH) {
        serveUpload(need().http, req, res);
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
