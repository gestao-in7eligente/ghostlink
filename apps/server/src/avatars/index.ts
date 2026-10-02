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
  type AvatarUploadResult,
  type IconUploadResult,
} from '@ghostlink/shared';
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
   * answers for every purpose; it registers `avatar` and `icon` itself. Others register theirs
   * in their init (the files module: `attachment`). Usable once this module's init ran: register
   * those modules after it.
   */
  readonly uploads: UploadHub;
}

export interface AvatarsModuleOptions {
  /** Tests only: cut an upload after this long without a byte (default 60 s). */
  uploadIdleMs?: number;
}

const UPLOAD_IDLE_MS = 60_000;

/** The limiter's key: a person's photo changes, their icon changes and a bot's photo changes are counted apart. */
const changeKey = (purpose: 'avatar' | 'icon' | 'bot', userId: string): string => (purpose === 'avatar' ? userId : `${purpose}:${userId}`);
const SWEEP_INTERVAL_MS = 60_000;
const CHANGES_WINDOW_MS = 60_000;

interface State {
  ctx: ModuleContext;
  text: TextModule;
  store: AvatarStore;
  hub: UploadHub;
  /** Changes per person: their photo (upload.begin and avatar.clear), and apart the server icon. */
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
 *
 * The server icon (spec 2026-10-01-icone-do-servidor) takes the same path: the `serverIcon`
 * flag, the hub's `icon` purpose and `server.iconClear` with MANAGE_SERVER, the hash
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

  /** A bot's photo (bots spec §2): someone with MANAGE_SERVER, for a bot that is a member. */
  const managesBot = (s: State, userId: string, botId: string): boolean =>
    managesServer(s, userId) && s.ctx.db.get('SELECT 1 AS x FROM users WHERE id = ? AND is_bot = 1 AND removed_at IS NULL', botId) !== undefined;

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

    get uploads(): UploadHub {
      return need().hub;
    },

    handlers: {
      // Every purpose: the hub checks the schema and the open tokens, the purpose the rest.
      'upload.begin': (ctx, payload) => need().hub.begin(ctx, payload),

      'avatar.clear': (ctx, payload) => {
        const p = avatarClearSchema.parse(payload ?? {});
        const s = need();
        if (p.botId !== undefined) {
          if (!managesBot(s, ctx.userId, p.botId)) throw new ProtocolError('FORBIDDEN');
          if (!s.changes.hit(changeKey('bot', p.botId))) throw new ProtocolError('RATE_LIMITED');
        } else {
          requireMember(s, ctx.userId);
          if (!s.changes.hit(changeKey('avatar', ctx.userId))) throw new ProtocolError('RATE_LIMITED');
        }
        const target = p.botId ?? ctx.userId;
        const changed = s.ctx.db.run('UPDATE users SET avatar_file_id = NULL WHERE id = ? AND avatar_file_id IS NOT NULL', target).changes > 0;
        if (changed) {
          cleanUp(s);
          s.text.announceMember(target);
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
          canApply: (grant) =>
            ctx.sessions.fileToken(grant.sessionId) !== null &&
            (grant.purpose === 'icon'
              ? managesServer(s, grant.userId)
              : grant.botId !== undefined
                ? managesBot(s, grant.userId, grant.botId)
                : isMember(s, grant.userId)),
          apply: (grant): AvatarUploadResult | IconUploadResult => {
            if (grant.purpose === 'icon') {
              ctx.db.run('UPDATE server_meta SET icon_file_id = ? WHERE id = 1', grant.sha256);
              cleanUp(s);
              text.announceServer();
              return { icon: grant.sha256 };
            }
            const target = grant.botId ?? grant.userId;
            ctx.db.run('UPDATE users SET avatar_file_id = ? WHERE id = ? AND removed_at IS NULL', grant.sha256, target);
            cleanUp(s);
            text.announceMember(target);
            return { avatar: grant.sha256 };
          },
          inUse: (hash) =>
            serverIcon(s) === hash || ctx.db.get('SELECT 1 AS x FROM users WHERE avatar_file_id = ? AND removed_at IS NULL LIMIT 1', hash) !== undefined,
        },
      };
      uploads.register('avatar', {
        stagingDir: store.dir,
        maxBytes: () => AVATAR_LIMITS.maxBytes,
        begin: (rctx, payload) => {
          const botId = payload.purpose === 'avatar' ? payload.botId : undefined;
          if (botId !== undefined) {
            if (!managesBot(s, rctx.userId, botId)) throw new ProtocolError('FORBIDDEN');
            if (!s.changes.hit(changeKey('bot', botId))) throw new ProtocolError('RATE_LIMITED');
            return { botId };
          }
          requireMember(s, rctx.userId);
          if (!s.changes.hit(changeKey('avatar', rctx.userId))) throw new ProtocolError('RATE_LIMITED');
          return {};
        },
        canApply: (grant) => s.http.canApply(grant),
        finish: (grant, body) => finishAvatarUpload(s.http, grant, body),
      });
      // The server icon: the same image path, with MANAGE_SERVER and its own rate limit.
      uploads.register('icon', {
        stagingDir: store.dir,
        maxBytes: () => AVATAR_LIMITS.maxBytes,
        begin: (rctx) => {
          if (!managesServer(s, rctx.userId)) throw new ProtocolError('FORBIDDEN');
          if (!s.changes.hit(changeKey('icon', rctx.userId))) throw new ProtocolError('RATE_LIMITED');
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
