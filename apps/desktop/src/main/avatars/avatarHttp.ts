// Profile photos over HTTPS to the connected server (spec 2026-10-01 §4, main spec §7):
// upload.begin over the session, then POST /upload?u=<token>; the signed GET /avatars/<hash>.
// The server icon (spec 2026-10-01-icone-do-servidor) takes the same path with `purpose: 'icon'`.
// Every request goes through pinnedTlsConnect with the session's pin, so a server with another
// key never receives a byte (pinnedHttp.ts). URLs, tokens, hashes and bytes are never logged nor put in errors.
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import {
  AVATAR_LIMITS,
  ProtocolError,
  avatarHashSchema,
  avatarTarget,
  fileSignatureInput,
  fileUrlExpiry,
  isErrorCode,
  type UploadBegin,
  type UploadPurpose,
  type WelcomePayload,
} from '@ghostlink/shared';
import { AppError } from '../../shared/appErrors.js';
import { parseJson, pinnedRequest, type PinnedResponse } from '../pinnedHttp.js';
import { sha256Hex } from './avatarBytes.js';

/** What the HTTP side needs from the live session (the controller's ActiveSession has it). */
export interface AvatarServer {
  /** host:port of the current connection. */
  address: string;
  /** The pinned serverKeyId. */
  serverKeyId: string;
  welcome: Pick<WelcomePayload, 'sessionId' | 'fileToken'>;
  /** welcome.serverTime minus the local clock when the welcome arrived. */
  clockOffsetMs: number;
  request<T>(type: string, payload?: unknown): Promise<T>;
}

export interface AvatarHttpOptions {
  /** The whole request, connection included (default 30 s). */
  timeoutMs?: number;
  /** The local clock (tests). */
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** The JSON answer of POST /upload is tiny. */
const MAX_JSON_BYTES = 64 * 1024;

const uploadBeginResultSchema = z.object({ uploadToken: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/) });
const uploadResultSchema = z.object({ avatar: avatarHashSchema });
const iconUploadResultSchema = z.object({ icon: avatarHashSchema });
const errorBodySchema = z.object({ code: z.string().max(64) });

/**
 * The `s` of a signed URL (main spec §7): base64url (no padding) of
 * HMAC-SHA256(key, fileSignatureInput(avatarTarget(hash), sid, e)).
 *
 * The key is the fileToken TEXT exactly as the welcome carries it (the 43-character base64url
 * string, as UTF-8 bytes), not the 32 bytes it decodes to. The server holds that same string
 * (`randomBytes(32).toString('base64url')` in auth/handshake.ts), so both sides key with what they
 * already have and no decoding (lenient in Node: it skips stray characters) can make them differ.
 * The string still carries the 256 random bits. Server side:
 * `createHmac('sha256', session.fileToken).update(fileSignatureInput(avatarTarget(hash), sid, e)).digest('base64url')`.
 */
export function avatarSignature(fileToken: string, hash: string, sessionId: string, expUnix: number): string {
  return createHmac('sha256', Buffer.from(fileToken, 'utf8')).update(fileSignatureInput(avatarTarget(hash), sessionId, expUnix), 'utf8').digest('base64url');
}

/**
 * How far behind the server's clock the expiry is computed. `e` lands 10 to 20 min ahead and the
 * server refuses more than 20 min (FILE_URL_MAX_AHEAD_S): this keeps a clock that drifted or was
 * stepped since the welcome from crossing that edge. Only main fetches these URLs, so they need
 * not be stable for a browser cache.
 */
export const CLOCK_MARGIN_MS = 30_000;

/** `/avatars/<hash>?sid=&e=&s=`, valid until the end of the next 10-minute window of the server's clock. */
export function signedAvatarPath(server: AvatarServer, hash: string, nowMs: number = Date.now()): string {
  const { sessionId, fileToken } = server.welcome;
  const e = fileUrlExpiry(nowMs + server.clockOffsetMs - CLOCK_MARGIN_MS);
  const s = avatarSignature(fileToken, hash, sessionId, e);
  return `/avatars/${hash}?sid=${encodeURIComponent(sessionId)}&e=${e}&s=${s}`;
}

/** Someone's photo from the connected server. The caller verifies the bytes (avatarBytes.verifiedAvatar). */
export async function downloadAvatar(server: AvatarServer, hash: string, opts: AvatarHttpOptions = {}): Promise<Buffer> {
  if (!avatarHashSchema.safeParse(hash).success) throw new AppError('BAD_REQUEST', 'not a photo hash');
  const now = opts.now ?? Date.now;
  const res = await pinnedRequest(server, {
    method: 'GET',
    path: signedAvatarPath(server, hash, now()),
    maxResponseBytes: AVATAR_LIMITS.maxBytes,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (res.status !== 200) throw statusError(res);
  return res.body;
}

/** upload.begin over the session, then the bytes to POST /upload. Resolves with the hash the server now holds for me. */
export async function uploadAvatar(server: AvatarServer, bytes: Uint8Array, opts: AvatarHttpOptions = {}): Promise<string> {
  const result = uploadResultSchema.safeParse(await uploadImage(server, bytes, 'avatar', opts));
  if (!result.success) throw new ProtocolError('BAD_REQUEST', 'invalid upload answer');
  return result.data.avatar;
}

/** The same path for the server's icon (MANAGE_SERVER). Resolves with the icon's hash as the server now holds it. */
export async function uploadServerIcon(server: AvatarServer, bytes: Uint8Array, opts: AvatarHttpOptions = {}): Promise<string> {
  const result = iconUploadResultSchema.safeParse(await uploadImage(server, bytes, 'icon', opts));
  if (!result.success) throw new ProtocolError('BAD_REQUEST', 'invalid upload answer');
  return result.data.icon;
}

/** upload.begin, then POST /upload; the JSON of a 200 answer. */
async function uploadImage(server: AvatarServer, bytes: Uint8Array, purpose: UploadPurpose, opts: AvatarHttpOptions): Promise<unknown> {
  const begin: UploadBegin = { purpose, size: bytes.byteLength, sha256: sha256Hex(bytes) };
  const answer = uploadBeginResultSchema.safeParse(await server.request('upload.begin', begin));
  if (!answer.success) throw new ProtocolError('BAD_REQUEST', 'invalid upload.begin answer');
  const res = await pinnedRequest(server, {
    method: 'POST',
    path: `/upload?u=${encodeURIComponent(answer.data.uploadToken)}`,
    body: bytes,
    maxResponseBytes: MAX_JSON_BYTES,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (res.status !== 200) throw statusError(res);
  return parseJson(res.body);
}

/** Back to initials on the connected server. */
export async function clearAvatar(server: Pick<AvatarServer, 'request'>): Promise<void> {
  await server.request('avatar.clear', {});
}

function statusError(res: PinnedResponse): Error {
  switch (res.status) {
    case 400: {
      const parsed = errorBodySchema.safeParse(parseJson(res.body));
      return new ProtocolError(parsed.success && isErrorCode(parsed.data.code) ? parsed.data.code : 'BAD_REQUEST');
    }
    case 403:
      return new ProtocolError('FORBIDDEN');
    case 404:
      return new ProtocolError('NOT_FOUND');
    case 429:
      return new ProtocolError('RATE_LIMITED');
    default:
      return new ProtocolError('INTERNAL', `HTTP ${res.status}`);
  }
}
