// Profile photos in main (spec 2026-10-01 §3, §4): my photo, the cache of others', the sync
// with the connected server and the app://ghostlink/_avatar route, wired together for index.ts.
import { join } from 'node:path';
import type { AvatarInfo } from '../../shared/profileTypes.js';
import type { ActiveSession } from '../controller.js';
import type { ProfileIpcDeps } from '../profileIpc.js';
import { AvatarCache } from './avatarCache.js';
import { clearAvatar, downloadAvatar, uploadAvatar, type AvatarHttpOptions } from './avatarHttp.js';
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
    },
    route: (request) => route.handle(request),
    onSession: (s) => {
      session = s;
      sync.onSession(s);
    },
    idle: () => sync.idle(),
  };
}
