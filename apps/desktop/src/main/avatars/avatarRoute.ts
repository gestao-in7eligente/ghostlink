// app://ghostlink/_avatar/<hash> (spec 2026-10-01 §3): the only way the renderer loads a photo.
// Mine comes from the store, others' from the cache or, on a miss, from the connected server
// when it announces `avatars` (one download per hash however many <img> ask). The bytes are
// verified (SHA-256, image type, sides) before they are kept or served; anything else is a 404
// and the renderer shows initials. The renderer never learns a path, a URL or a token.
import { AVATAR_HASH, type ImageInfo } from '@ghostlink/shared';
import { toAppErrorCode } from '../../shared/appErrors.js';
import type { ActiveSession } from '../controller.js';
import { verifiedAvatar } from './avatarBytes.js';
import type { AvatarCache } from './avatarCache.js';
import type { MyAvatar } from './avatarStore.js';
import { takesAvatars } from './avatarSync.js';

export const AVATAR_ROUTE_HOST = 'ghostlink';
/** Every path under it belongs to this route: it never falls back to the app's index.html. */
export const AVATAR_ROUTE_PREFIX = '/_avatar';

/** After a failed download, the same session is not asked again for this long. */
export const AVATAR_RETRY_MS = 30_000;

const HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' } as const;

export interface AvatarRouteDeps {
  mine(): MyAvatar | null;
  cache: Pick<AvatarCache, 'get' | 'put'>;
  /** The connected session, or null. */
  session(): ActiveSession | null;
  download(session: ActiveSession, hash: string): Promise<Uint8Array>;
  warn(message: string): void;
  now?: () => number;
}

/** True for app://ghostlink/_avatar and anything under it. */
export function isAvatarRequest(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const path = parsed.pathname;
  return parsed.protocol === 'app:' && parsed.host === AVATAR_ROUTE_HOST && (path === AVATAR_ROUTE_PREFIX || path.startsWith(`${AVATAR_ROUTE_PREFIX}/`));
}

function hashOf(url: string): string | null {
  if (!isAvatarRequest(url)) return null;
  const rest = new URL(url).pathname.slice(AVATAR_ROUTE_PREFIX.length + 1);
  return AVATAR_HASH.test(rest) ? rest : null;
}

interface Photo {
  bytes: Uint8Array;
  info: Pick<ImageInfo, 'mime'>;
}

export class AvatarRoute {
  readonly #deps: AvatarRouteDeps;
  readonly #now: () => number;
  readonly #inflight = new Map<string, Promise<Photo | null>>();
  /** Failed downloads, per session: a reconnect starts with a clean slate. */
  #failures = new Map<string, number>();
  #failuresOf: ActiveSession | null = null;

  constructor(deps: AvatarRouteDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  async handle(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: HEADERS });
    const hash = hashOf(request.url);
    const photo = hash === null ? null : await this.#find(hash);
    if (photo === null) return new Response(null, { status: 404, headers: HEADERS });
    const body = request.method === 'HEAD' ? null : new Uint8Array(photo.bytes);
    return new Response(body, { status: 200, headers: { ...HEADERS, 'Content-Type': photo.info.mime } });
  }

  async #find(hash: string): Promise<Photo | null> {
    const mine = this.#deps.mine();
    if (mine !== null && mine.info.hash === hash) return mine;
    const cached = this.#deps.cache.get(hash);
    if (cached !== null) return cached;
    const running = this.#inflight.get(hash);
    if (running) return running;
    const session = this.#deps.session();
    if (session === null || !takesAvatars(session) || this.#recentlyFailed(session, hash)) return null;
    const download = this.#fetch(session, hash).finally(() => this.#inflight.delete(hash));
    this.#inflight.set(hash, download);
    return download;
  }

  async #fetch(session: ActiveSession, hash: string): Promise<Photo | null> {
    let bytes: Uint8Array;
    try {
      bytes = await this.#deps.download(session, hash);
    } catch (e) {
      const code = toAppErrorCode(e);
      if (code !== 'NOT_FOUND') this.#deps.warn(`[avatars] download failed: ${code}`);
      this.#failed(session, hash);
      return null;
    }
    const info = verifiedAvatar(hash, bytes);
    if (info === null) {
      this.#deps.warn('[avatars] the server sent bytes that are not the photo asked for');
      this.#failed(session, hash);
      return null;
    }
    try {
      this.#deps.cache.put(hash, bytes);
    } catch (e) {
      this.#deps.warn(`[avatars] could not keep a photo: ${toAppErrorCode(e)}`); // still served this time
    }
    return { bytes, info };
  }

  #recentlyFailed(session: ActiveSession, hash: string): boolean {
    if (this.#failuresOf !== session) return false;
    const until = this.#failures.get(hash);
    return until !== undefined && this.#now() < until;
  }

  #failed(session: ActiveSession, hash: string): void {
    if (this.#failuresOf !== session) {
      this.#failuresOf = session;
      this.#failures = new Map();
    }
    this.#failures.set(hash, this.#now() + AVATAR_RETRY_MS);
  }
}
