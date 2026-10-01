import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AVATAR_HASH, AVATAR_LIMITS, avatarTarget, imageInfo, type AvatarUploadResult, type ImageInfo } from '@ghostlink/shared';
import type { Logger } from '../logger.js';
import { discardStaged, type UploadAnswer } from '../uploads/hub.js';
import { CORS, errnoOf, fail, preflight, queryOf, reply, type ReceivedBody } from '../uploads/http.js';
import { verifySignedQuery } from '../uploads/signedUrl.js';
import type { UploadGrant } from '../uploads/tokens.js';
import type { AvatarStore } from './store.js';

/** What the photo upload and GET /avatars need from the module. */
export interface AvatarHttpDeps {
  now(): number;
  logger: Logger;
  store: AvatarStore;
  /** See SessionsApi.fileToken: non-null only for a current session. */
  fileToken(sessionId: string): string | null;
  /** True while the grant may still change the photo: its session is current and its user a member. */
  canApply(grant: UploadGrant): boolean;
  /** Points the member at the stored photo, cleans up and tells everyone. Synchronous. */
  apply(userId: string, hash: string): void;
  /** True when a current member uses this photo. */
  inUse(hash: string): boolean;
}

export const AVATARS_PREFIX = '/avatars/';

/** The image checks of spec §4 (the upload hub already checked the size and the hash). */
function validImage(head: Buffer): ImageInfo | null {
  const info = imageInfo(head);
  if (!info) return null;
  const { minSide, maxSide } = AVATAR_LIMITS;
  if (info.width < minSide || info.height < minSide || info.width > maxSide || info.height > maxSide) return null;
  return info;
}

/**
 * The end of a photo's `POST /upload` (spec 2026-10-01-foto-de-perfil §4): 200 `{ avatar }`,
 * 400 for anything but a PNG, JPEG, WebP or GIF of 16 to 512 px a side, 403 when the member
 * was removed or the session replaced while the body arrived. Synchronous from the check to
 * the database, so a sweep never sees a stored photo nobody references.
 */
export function finishAvatarUpload(deps: AvatarHttpDeps, grant: UploadGrant, body: ReceivedBody): UploadAnswer {
  const info = validImage(body.head);
  if (!info) {
    discardStaged(body.staged);
    return { ok: false, code: 'BAD_REQUEST' };
  }
  if (!deps.canApply(grant)) {
    discardStaged(body.staged);
    return { ok: false, code: 'FORBIDDEN' };
  }
  deps.store.commit(body.staged, grant.sha256, info.mime);
  deps.apply(grant.userId, grant.sha256);
  const result: AvatarUploadResult = { avatar: grant.sha256 };
  return { ok: true, body: result };
}

/**
 * `GET /avatars/<hash>?sid=…&e=…&s=…` (main spec §7, target `avatar:<hash>`): any current
 * session of this server may read any photo a member uses. 404 for a malformed hash or a
 * photo no one has, 403 for a bad, expired or foreign signature.
 */
export function serveAvatar(deps: AvatarHttpDeps, req: IncomingMessage, res: ServerResponse, hash: string): void {
  if (req.method === 'OPTIONS') return preflight(res, 'GET, HEAD, OPTIONS');
  if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, null, { Allow: 'GET, HEAD, OPTIONS' });
  if (!AVATAR_HASH.test(hash)) return fail(res, 'NOT_FOUND');
  if (!verifySignedQuery(queryOf(req.url), avatarTarget(hash), deps.now(), (sid) => deps.fileToken(sid))) return fail(res, 'FORBIDDEN');
  const found = deps.inUse(hash) ? deps.store.find(hash) : null;
  if (!found) return fail(res, 'NOT_FOUND');
  readFile(found.path).then(
    (bytes) => {
      if (res.headersSent) return;
      res.writeHead(200, {
        ...CORS,
        'Content-Type': found.mime,
        'Content-Length': String(bytes.length),
        'X-Content-Type-Options': 'nosniff',
        // The bytes never change for a hash.
        'Cache-Control': 'private, max-age=86400',
      });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    },
    (e: unknown) => {
      if (errnoOf(e) === 'ENOENT') return fail(res, 'NOT_FOUND'); // cleaned up meanwhile
      deps.logger.error('avatar could not be read', { error: errnoOf(e) });
      fail(res, 'INTERNAL');
    },
  );
}
