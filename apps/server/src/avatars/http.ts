import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AVATAR_HASH, AVATAR_LIMITS, avatarTarget, imageInfo, type AvatarUploadResult, type ErrorCode } from '@ghostlink/shared';
import type { Logger } from '../logger.js';
import { verifySignedQuery } from './signedUrl.js';
import type { AvatarStore } from './store.js';
import type { UploadGrant, UploadTokens } from './uploads.js';

/** What the two routes need from the module. */
export interface AvatarHttpDeps {
  now(): number;
  logger: Logger;
  store: AvatarStore;
  tokens: UploadTokens;
  /** An upload is cut after this long without a byte. */
  idleMs: number;
  /** See SessionsApi.fileToken: non-null only for a current session. */
  fileToken(sessionId: string): string | null;
  /** True while the grant may still change the photo: its session is current and its user a member. */
  canApply(grant: UploadGrant): boolean;
  /** Points the member at the stored photo, cleans up and tells everyone. Synchronous. */
  apply(userId: string, hash: string): void;
  /** True when a current member uses this photo. */
  inUse(hash: string): boolean;
}

export const UPLOAD_PATH = '/upload';
export const AVATARS_PREFIX = '/avatars/';

const CORS = { 'Access-Control-Allow-Origin': '*' } as const;

export function pathOf(url: string | undefined): string {
  return (url ?? '/').split('?')[0]!;
}

function queryOf(url: string | undefined): string {
  const q = (url ?? '').indexOf('?');
  return q < 0 ? '' : (url ?? '').slice(q + 1);
}

/** An errno code (ENOSPC, EACCES…) and nothing else: fs messages carry paths, and paths carry hashes. */
function errnoOf(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

function reply(res: ServerResponse, status: number, body: object | null, headers: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const text = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    ...CORS,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    ...(body === null ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
    'Content-Length': String(Buffer.byteLength(text)),
    ...headers,
  });
  res.end(text);
}

const fail = (res: ServerResponse, status: number, code: ErrorCode, headers?: Record<string, string>) => reply(res, status, { code }, headers);

function preflight(res: ServerResponse, methods: string): void {
  res.writeHead(204, {
    ...CORS,
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end();
}

/**
 * Refuses an upload whose body may still be arriving: stop reading it and close the
 * connection after the answer, so a client cannot keep streaming into the server.
 */
function refuseUpload(req: IncomingMessage, res: ServerResponse, status: 400 | 403, code: ErrorCode): void {
  req.pause();
  fail(res, status, code, { Connection: 'close' });
}

type BodyResult = { ok: true; bytes: Buffer } | { ok: false };

/**
 * Reads at most `limit` bytes: one byte more and it gives up at once (ok: false). An upload
 * with no byte for `idleMs` is cut without an answer; so is one the client aborts.
 */
function readBody(req: IncomingMessage, limit: number, idleMs: number, done: (r: BodyResult) => void): void {
  const chunks: Buffer[] = [];
  let received = 0;
  let settled = false;
  const settle = () => {
    settled = true;
    clearTimeout(idle);
    req.off('data', onData);
    req.off('end', onEnd);
    req.off('close', onClose);
  };
  const idle = setTimeout(() => {
    settle();
    req.socket.destroy();
  }, idleMs);
  const onData = (chunk: Buffer) => {
    received += chunk.length;
    if (received > limit) {
      settle();
      done({ ok: false });
      return;
    }
    chunks.push(chunk);
    idle.refresh();
  };
  const onEnd = () => {
    settle();
    done({ ok: true, bytes: Buffer.concat(chunks, received) });
  };
  const onClose = () => {
    if (!settled) settle(); // aborted: nobody to answer
  };
  req.on('data', onData);
  req.on('end', onEnd);
  req.on('close', onClose);
}

/** The checks of spec §4, in order, on a complete body. */
function validUpload(grant: UploadGrant, bytes: Buffer): ReturnType<typeof imageInfo> {
  if (bytes.length !== grant.size) return null;
  if (createHash('sha256').update(bytes).digest('hex') !== grant.sha256) return null;
  const info = imageInfo(bytes);
  if (!info) return null;
  const { minSide, maxSide } = AVATAR_LIMITS;
  if (info.width < minSide || info.height < minSide || info.width > maxSide || info.height > maxSide) return null;
  return info;
}

async function storeUpload(deps: AvatarHttpDeps, res: ServerResponse, grant: UploadGrant, bytes: Buffer): Promise<void> {
  const info = validUpload(grant, bytes);
  if (!info) return fail(res, 400, 'BAD_REQUEST');
  let staged: string;
  try {
    staged = await deps.store.stage(bytes);
  } catch (e) {
    deps.logger.error('avatar upload could not be written', { error: errnoOf(e) });
    return fail(res, 500, 'INTERNAL');
  }
  // After the await: the member may have been kicked, or the session replaced, meanwhile.
  if (!deps.canApply(grant)) {
    deps.store.discard(staged);
    return fail(res, 403, 'FORBIDDEN');
  }
  try {
    deps.store.commit(staged, grant.sha256, info.mime);
  } catch (e) {
    deps.store.discard(staged);
    deps.logger.error('avatar upload could not be stored', { error: errnoOf(e) });
    return fail(res, 500, 'INTERNAL');
  }
  deps.apply(grant.userId, grant.sha256);
  const result: AvatarUploadResult = { avatar: grant.sha256 };
  reply(res, 200, result);
}

/**
 * `POST /upload?u=<uploadToken>` (spec 2026-10-01 §4): the token is consumed before
 * anything else; the body is cut as soon as it passes the size of upload.begin.
 * 200 `{ avatar }`, 400 `{ code: 'BAD_REQUEST' }`, 403 `{ code: 'FORBIDDEN' }`.
 */
export function serveUpload(deps: AvatarHttpDeps, req: IncomingMessage, res: ServerResponse): void {
  if (req.method === 'OPTIONS') return preflight(res, 'POST, OPTIONS');
  if (req.method !== 'POST') return reply(res, 405, null, { Allow: 'POST, OPTIONS' });
  const tokens = new URLSearchParams(queryOf(req.url)).getAll('u');
  const grant = tokens.length === 1 ? deps.tokens.take(tokens[0]!) : null;
  if (!grant || !deps.canApply(grant)) return refuseUpload(req, res, 403, 'FORBIDDEN');
  const declared = req.headers['content-length'];
  if (declared !== undefined && Number(declared) > grant.size) return refuseUpload(req, res, 400, 'BAD_REQUEST');
  readBody(req, grant.size, deps.idleMs, (body) => {
    if (!body.ok) return refuseUpload(req, res, 400, 'BAD_REQUEST');
    storeUpload(deps, res, grant, body.bytes).catch((e: unknown) => {
      deps.logger.error('avatar upload failed', { error: errnoOf(e) });
      fail(res, 500, 'INTERNAL');
    });
  });
}

/**
 * `GET /avatars/<hash>?sid=…&e=…&s=…` (main spec §7, target `avatar:<hash>`): any current
 * session of this server may read any photo a member uses. 404 for a malformed hash or a
 * photo no one has, 403 for a bad, expired or foreign signature.
 */
export function serveAvatar(deps: AvatarHttpDeps, req: IncomingMessage, res: ServerResponse, hash: string): void {
  if (req.method === 'OPTIONS') return preflight(res, 'GET, HEAD, OPTIONS');
  if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, null, { Allow: 'GET, HEAD, OPTIONS' });
  if (!AVATAR_HASH.test(hash)) return fail(res, 404, 'NOT_FOUND');
  if (!verifySignedQuery(queryOf(req.url), avatarTarget(hash), deps.now(), (sid) => deps.fileToken(sid))) return fail(res, 403, 'FORBIDDEN');
  const found = deps.inUse(hash) ? deps.store.find(hash) : null;
  if (!found) return fail(res, 404, 'NOT_FOUND');
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
      if (errnoOf(e) === 'ENOENT') return fail(res, 404, 'NOT_FOUND'); // cleaned up meanwhile
      deps.logger.error('avatar could not be read', { error: errnoOf(e) });
      fail(res, 500, 'INTERNAL');
    },
  );
}
