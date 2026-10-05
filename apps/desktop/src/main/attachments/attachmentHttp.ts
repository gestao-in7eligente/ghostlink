// Attachments over HTTPS to the connected server (spec 2026-10-01-anexos §2, main spec §7):
// upload.begin over the session, then POST /upload?u=<token> with the bytes in chunks (progress);
// the signed GET /files/<fileId>, streamed, with Range passed through. Every request goes through
// the session's pin (pinnedHttp.ts). URLs, tokens, names and bytes never reach a log or an error.
import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import {
  FEATURE_ATTACHMENTS,
  ProtocolError,
  entityIdSchema,
  fileSignatureInput,
  fileTarget,
  fileUrlExpiry,
  isErrorCode,
  type AttachmentUploadBegin,
} from '@ghostlink/shared';
import { AppError } from '../../shared/appErrors.js';
import { CLOCK_MARGIN_MS, type AvatarServer } from '../avatars/avatarHttp.js';
import { parseJson, pinnedStream, type PinnedStreamResponse } from '../pinnedHttp.js';

/** What the HTTP side needs from the live session: the same as for photos (controller's ActiveSession). */
export type FileServer = AvatarServer & { welcome: AvatarServer['welcome'] & { features: readonly string[] } };

export interface AttachmentHttpOptions {
  /** No byte either way for this long ends the transfer (default 30 s). */
  idleMs?: number;
  now?: () => number;
}

const DEFAULT_IDLE_MS = 30_000;
/** The JSON answers of POST /upload and the error bodies are tiny. */
const MAX_JSON_BYTES = 64 * 1024;

const beginAnswerSchema = z.object({
  uploadToken: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/),
  fileId: entityIdSchema,
});
const uploadAnswerSchema = z.object({ fileId: entityIdSchema });
const errorBodySchema = z.object({ code: z.string().max(64) });

export function takesAttachments(server: Pick<FileServer, 'welcome'>): boolean {
  return server.welcome.features.includes(FEATURE_ATTACHMENTS);
}

/**
 * The `s` of a file's signed URL (main spec §7): base64url of HMAC-SHA256 keyed with the
 * fileToken text (as for photos, avatarHttp.avatarSignature), over the fileId as the target.
 */
export function fileSignature(fileToken: string, fileId: string, sessionId: string, expUnix: number): string {
  return createHmac('sha256', Buffer.from(fileToken, 'utf8')).update(fileSignatureInput(fileTarget(fileId), sessionId, expUnix), 'utf8').digest('base64url');
}

/** `/files/<fileId>?sid=&e=&s=`, valid until the end of the next 10-minute window of the server's clock. */
export function signedFilePath(server: Pick<AvatarServer, 'welcome' | 'clockOffsetMs'>, fileId: string, nowMs: number = Date.now()): string {
  const { sessionId, fileToken } = server.welcome;
  const e = fileUrlExpiry(nowMs + server.clockOffsetMs - CLOCK_MARGIN_MS);
  return `/files/${fileId}?sid=${encodeURIComponent(sessionId)}&e=${e}&s=${fileSignature(fileToken, fileId, sessionId, e)}`;
}

export interface AttachmentUpload {
  channelId: string;
  name: string;
  bytes: Uint8Array;
  /** Bytes sent so far, as they leave. */
  onProgress?(sent: number, total: number): void;
  signal?: AbortSignal;
}

/**
 * upload.begin { purpose: 'attachment' } over the session, then the bytes to POST /upload.
 * Resolves with the file id for msg.send. SERVER_OUTDATED on a server without `attachments`;
 * the server's own refusals (FILE_TOO_LARGE, QUOTA_EXCEEDED, IMAGE_TOO_LARGE…) keep their code.
 */
export async function uploadAttachment(server: FileServer, upload: AttachmentUpload, opts: AttachmentHttpOptions = {}): Promise<string> {
  if (!takesAttachments(server)) throw new AppError('SERVER_OUTDATED', 'the server takes no attachments');
  const { bytes } = upload;
  const begin: AttachmentUploadBegin = {
    purpose: 'attachment',
    channelId: upload.channelId,
    name: upload.name,
    size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const answer = beginAnswerSchema.safeParse(await server.request('upload.begin', begin));
  if (!answer.success) throw new ProtocolError('BAD_REQUEST', 'invalid upload.begin answer');
  const res = await pinnedStream(server, {
    method: 'POST',
    path: `/upload?u=${encodeURIComponent(answer.data.uploadToken)}`,
    body: bytes,
    onSent: upload.onProgress,
    idleMs: opts.idleMs ?? DEFAULT_IDLE_MS,
    signal: upload.signal,
  });
  const body = await readSmall(res);
  if (res.status !== 200) throw statusError(res.status, body);
  const result = uploadAnswerSchema.safeParse(parseJson(body));
  if (!result.success || result.data.fileId !== answer.data.fileId) throw new ProtocolError('BAD_REQUEST', 'invalid upload answer');
  return result.data.fileId;
}

/**
 * The signed GET (or HEAD) of a file, as a stream: 200 or 206 with the body to read, or the
 * server's refusal as an error (NOT_FOUND also when access to the channel is gone).
 */
export async function openFile(
  server: FileServer,
  fileId: string,
  req: { method?: 'GET' | 'HEAD'; range?: string | null; signal?: AbortSignal } = {},
  opts: AttachmentHttpOptions = {},
): Promise<PinnedStreamResponse> {
  if (!entityIdSchema.safeParse(fileId).success) throw new AppError('BAD_REQUEST', 'not a file id');
  const now = opts.now ?? Date.now;
  const res = await pinnedStream(server, {
    method: req.method ?? 'GET',
    path: signedFilePath(server, fileId, now()),
    headers: req.range ? { Range: req.range } : undefined,
    idleMs: opts.idleMs ?? DEFAULT_IDLE_MS,
    // Range comes from the page's video and audio players, which may pause reading for long.
    idleAfterHead: !req.range,
    signal: req.signal,
  });
  if (res.status === 200 || res.status === 206 || res.status === 416) return res;
  throw statusError(res.status, await readSmall(res));
}

/** At most MAX_JSON_BYTES of a body (answers and error bodies); more is cut and the rest discarded. */
export function readSmall(res: PinnedStreamResponse): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    res.body.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_JSON_BYTES) {
        res.body.destroy();
        resolve(Buffer.concat(chunks));
      } else chunks.push(chunk);
    });
    res.body.on('end', () => resolve(Buffer.concat(chunks)));
    res.body.on('error', (e) => reject(e instanceof AppError ? e : new AppError('CONNECTION_LOST')));
  });
}

/** The server's `{ code }` when it is one; otherwise a code for the status. */
export function statusError(status: number, body: Buffer): Error {
  const parsed = errorBodySchema.safeParse(parseJson(body));
  if (parsed.success && isErrorCode(parsed.data.code)) return new ProtocolError(parsed.data.code);
  switch (status) {
    case 400:
      return new ProtocolError('BAD_REQUEST');
    case 403:
      return new ProtocolError('FORBIDDEN');
    case 404:
      return new ProtocolError('NOT_FOUND');
    case 413:
      return new ProtocolError('FILE_TOO_LARGE');
    case 429:
      return new ProtocolError('RATE_LIMITED');
    case 507:
      return new ProtocolError('QUOTA_EXCEEDED');
    default:
      return new ProtocolError('INTERNAL', `HTTP ${status}`);
  }
}
