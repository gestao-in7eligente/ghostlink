// Profile photos in main (spec 2026-10-01 §3, §4): my photo, the cache of others', the sync
// with the connected server and the app://ghostlink/_avatar route, wired together for index.ts.
import { join } from 'node:path';
import { FEATURE_BOTS, FEATURE_SERVER_ICON } from '@ghostlink/shared';
import { AppError, toAppErrorCode } from '../../shared/appErrors.js';
import type { AvatarInfo } from '../../shared/profileTypes.js';
import type { ActiveSession } from '../controller.js';
import type { ProfileIpcDeps } from '../profileIpc.js';
import { checkMyAvatar } from './avatarBytes.js';
import { AvatarCache } from './avatarCache.js';
import { clearAvatar, downloadAvatar, uploadAvatar, uploadBotAvatar, uploadServerIcon, type AvatarHttpOptions } from './avatarHttp.js';
import { AvatarRoute } from './avatarRoute.js';
import { AvatarStore } from './avatarStore.js';
import { AvatarSync } from './avatarSync.js';

export interface Avatars {
  /** IpcDeps.profile. */
  profile: ProfileIpcDeps;
  /** The app:// handler's `_avatar` route. */
  route(request: Request): Promise<Response>;
  /** ControllerDeps.onSession. */
  onSession(session: ActiveSession | null): void;
  /** Resolves once no upload or clear is in flight. */
  idle(): Promise<void>;
}

export interface AvatarsOptions {
  userDataDir: string;
  warn(message: string): void;
  /** The connected session of a saved server (the controller's sessionOf), for its icon. */
  sessionOf?(serverId: string): ActiveSession | null;
  /** Tests shorten the HTTP timeout. */
  http?: AvatarHttpOptions;
  cacheMaxBytes?: number;
}

export function createAvatars(opts: AvatarsOptions): Avatars {
  const store = AvatarStore.load(opts.userDataDir);
  const cache = AvatarCache.open(join(opts.userDataDir, 'avatars'), { maxBytes: opts.cacheMaxBytes });
  let session: ActiveSession | null = null;
  const sync = new AvatarSync({
    store,
    upload: (s, bytes) => uploadAvatar(s, bytes, opts.http),
    clear: (s) => clearAvatar(s),
    warn: opts.warn,
  });
  const route = new AvatarRoute({
    mine: () => store.current(),
    cache,
    session: () => session,
    download: (s, hash) => downloadAvatar(s, hash, opts.http),
    warn: opts.warn,
  });
  return {
    profile: {
      avatar: () => store.get(),
      // Stored first and answered at once; the upload to the connected server follows.
      setAvatar: async (bytes): Promise<AvatarInfo> => {
        const info = store.set(bytes);
        sync.changed();
        return info;
      },
      clearAvatar: async () => {
        store.clear();
        sync.changed();
        return null;
      },
      // The server icon (spec 2026-10-01-icone-do-servidor): the photo's checks, then kept in the
      // cache (so app://ghostlink/_avatar shows it at once) and sent with purpose 'icon'.
      setServerIcon: async (serverId, bytes): Promise<AvatarInfo> => {
        const info = checkMyAvatar(bytes);
        const target = opts.sessionOf?.(serverId) ?? null;
        if (target === null) throw new AppError('CONNECTION_LOST', 'not connected to that server');
        if (!target.welcome.features.includes(FEATURE_SERVER_ICON)) throw new AppError('SERVER_OUTDATED', 'the server has no icons');
        try {
          cache.put(info.hash, bytes);
        } catch (e) {
          opts.warn(`[avatars] could not keep the server icon: ${toAppErrorCode(e)}`);
        }
        const held = await uploadServerIcon(target, bytes, opts.http);
        return { hash: held, mime: info.mime };
      },
      // A bot's photo (bots spec §3): the same checks and cache, sent as the bot's avatar.
      setBotAvatar: async (serverId, botId, bytes): Promise<AvatarInfo> => {
        const info = checkMyAvatar(bytes);
        const target = opts.sessionOf?.(serverId) ?? null;
        if (target === null) throw new AppError('CONNECTION_LOST', 'not connected to that server');
        if (!target.welcome.features.includes(FEATURE_BOTS)) throw new AppError('SERVER_OUTDATED', 'the server has no bots');
        try {
          cache.put(info.hash, bytes);
        } catch (e) {
          opts.warn(`[avatars] could not keep the bot photo: ${toAppErrorCode(e)}`);
        }
        const held = await uploadBotAvatar(target, botId, bytes, opts.http);
        return { hash: held, mime: info.mime };
      },
    },
    route: (request) => route.handle(request),
    onSession: (s) => {
      session = s;
      sync.onSession(s);
    },
    idle: () => sync.idle(),
  };
}
