import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { ErrorCode } from '@ghostlink/shared';

// What /upload, /avatars and /files share (main spec §4): CORS without credentials (the token
// in the URL is the only authorization), nosniff, JSON errors `{ code }`.

export const CORS = { 'Access-Control-Allow-Origin': '*' } as const;

export function pathOf(url: string | undefined): string {
  return (url ?? '/').split('?')[0]!;
}

export function queryOf(url: string | undefined): string {
  const q = (url ?? '').indexOf('?');
  return q < 0 ? '' : (url ?? '').slice(q + 1);
}

/** An errno code (ENOSPC, EACCES…) and nothing else: fs messages carry paths, and paths carry names and hashes. */
export function errnoOf(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

export function reply(res: ServerResponse, status: number, body: object | null, headers: Record<string, string> = {}): void {
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

/** The HTTP status each upload or download refusal is sent with; the body is `{ code }`. */
const STATUS: Partial<Record<ErrorCode, number>> = {
  BAD_REQUEST: 400,
  IMAGE_TOO_LARGE: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  FILE_TOO_LARGE: 413,
  QUOTA_EXCEEDED: 507,
  INTERNAL: 500,
};

export function statusOf(code: ErrorCode): number {
  return STATUS[code] ?? 400;
}

export function fail(res: ServerResponse, code: ErrorCode, headers?: Record<string, string>): void {
  reply(res, statusOf(code), { code }, headers);
}

export function preflight(res: ServerResponse, methods: string): void {
  res.writeHead(204, {
    ...CORS,
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Content-Type, Range',
    'Access-Control-Max-Age': '600',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end();
}

/**
 * Refuses an upload whose body may still be arriving: stop reading it and close the
 * connection after the answer, so a client cannot keep streaming into the server.
 */
export function refuseUpload(req: IncomingMessage, res: ServerResponse, code: ErrorCode): void {
  req.pause();
  fail(res, code, { Connection: 'close' });
}

/** A body written to disk in full, exactly `size` bytes long. */
export interface ReceivedBody {
  /** A temp file (`upload-<hex>.tmp`) in the folder given; the caller renames or deletes it. */
  staged: string;
  /** SHA-256 of the bytes, lower-case hex. */
  sha256: string;
  /** The first bytes, to read the type from (fileInfo / imageInfo). */
  head: Buffer;
  size: number;
}

export type ReceiveResult =
  | ({ ok: true } & ReceivedBody)
  /** too-large: more than `limit` bytes; aborted: cut, idle or gone (nobody to answer); error: the disk refused. */
  | { ok: false; reason: 'too-large' | 'aborted' | 'error'; error?: unknown };

/** An upload being written, or left half-written by a crash, in any store folder. */
export const STAGED_NAME = /^upload-[0-9a-f]+\.tmp$/;

/**
 * Streams a request body into a new temp file in `dir`, hashing it on the way: never more
 * than `limit` bytes (one byte more and it gives up at once), never more than `headBytes` in
 * memory. A body with no byte for `idleMs` is cut, and so is one the client aborts; the temp
 * file is gone before `done` hears of any failure.
 */
export function receiveBody(
  req: IncomingMessage,
  opts: { dir: string; limit: number; idleMs: number; headBytes: number },
  done: (r: ReceiveResult) => void,
): void {
  const staged = join(opts.dir, `upload-${randomBytes(8).toString('hex')}.tmp`);
  const out = createWriteStream(staged, { flags: 'wx', mode: 0o600 });
  const hash = createHash('sha256');
  const head: Buffer[] = [];
  let headLength = 0;
  let received = 0;
  let ended = false;
  let settled = false;

  const stopListening = () => {
    settled = true;
    clearTimeout(idle);
    req.off('data', onData);
    req.off('end', onEnd);
    req.off('close', onClose);
  };
  const abort = (reason: 'too-large' | 'aborted' | 'error', error?: unknown) => {
    if (settled) return;
    stopListening();
    if (reason !== 'aborted') req.pause();
    const removeAndTell = () => {
      try {
        rmSync(staged, { force: true });
      } catch {
        // A later sweep of the folder removes it.
      }
      done({ ok: false, reason, error });
    };
    if (out.closed) removeAndTell();
    else {
      out.once('close', removeAndTell);
      out.destroy();
    }
  };
  const idle = setTimeout(() => {
    abort('aborted');
    req.socket.destroy();
  }, opts.idleMs);
  const onData = (chunk: Buffer) => {
    received += chunk.length;
    if (received > opts.limit) return abort('too-large');
    hash.update(chunk);
    if (headLength < opts.headBytes) {
      const part = chunk.subarray(0, opts.headBytes - headLength);
      head.push(part);
      headLength += part.length;
    }
    idle.refresh();
    if (!out.write(chunk)) {
      req.pause();
      out.once('drain', () => {
        if (!settled) req.resume();
      });
    }
  };
  const onEnd = () => {
    ended = true;
    clearTimeout(idle);
    out.end(() => {
      if (settled) return;
      stopListening();
      done({ ok: true, staged, sha256: hash.digest('hex'), head: Buffer.concat(head, headLength), size: received });
    });
  };
  const onClose = () => {
    if (!ended) abort('aborted'); // the client went away mid-body
  };
  out.on('error', (e) => abort('error', e));
  req.on('data', onData);
  req.on('end', onEnd);
  req.on('close', onClose);
}
