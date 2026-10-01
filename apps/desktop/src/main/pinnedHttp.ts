// One HTTPS request to a GhostLink server, over TLS pinned to its serverKeyId (spec §3.3), the
// way the WSS connects: a server with another key never receives a byte. Used for profile photos
// (avatars/avatarHttp.ts), attachments (attachments/attachmentHttp.ts, streamed) and the owner's
// version checks (railway/serverStatus.ts). URLs and
// Node's error messages (they can name the host) never reach an error or a log line.
import { request as httpsRequest } from 'node:https';
import type { ClientRequest, ClientRequestArgs, IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { parseHostPort } from '@ghostlink/shared';
import { AppError } from '../shared/appErrors.js';
import { pinnedTlsConnect } from './connection.js';

export interface PinnedTarget {
  /** host:port. */
  address: string;
  /** The pinned serverKeyId. */
  serverKeyId: string;
}

export interface PinnedRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: Uint8Array;
  maxResponseBytes: number;
  timeoutMs: number;
}

export interface PinnedResponse {
  status: number;
  body: Buffer;
}

/** Rejects with AppError PIN_MISMATCH, CONNECTION_LOST, UNREACHABLE, TIMEOUT or BAD_REQUEST (response too large). */
export function pinnedRequest(server: PinnedTarget, r: PinnedRequest): Promise<PinnedResponse> {
  const { host, port } = parseHostPort(server.address);
  const pin = server.serverKeyId;
  return new Promise<PinnedResponse>((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, value?: PinnedResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        req.destroy();
        reject(error);
      } else {
        resolve(value!);
      }
    };
    const headers: Record<string, string | number> = { Accept: '*/*' };
    if (r.body) {
      headers['Content-Type'] = 'application/octet-stream';
      headers['Content-Length'] = r.body.byteLength;
    }
    // No agent: with createConnection, Node opens one socket for this request alone, and the
    // pin check runs on 'secureConnect' before the request line is written (as for the WSS).
    const req = httpsRequest(
      {
        host,
        port,
        method: r.method,
        path: r.path,
        headers,
        createConnection: ((options: ClientRequestArgs) => pinnedTlsConnect(options, pin)) as unknown as ClientRequestArgs['createConnection'],
      },
      (res) => {
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > r.maxResponseBytes) return finish(new AppError('BAD_REQUEST', 'response too large'));
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > r.maxResponseBytes) finish(new AppError('BAD_REQUEST', 'response too large'));
          else chunks.push(chunk);
        });
        res.on('end', () => finish(null, { status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        res.on('error', (e) => finish(networkError(e)));
        res.on('aborted', () => finish(new AppError('CONNECTION_LOST')));
      },
    );
    req.on('error', (e) => finish(networkError(e)));
    const timer = setTimeout(() => finish(new AppError('TIMEOUT')), r.timeoutMs);
    req.end(r.body ? Buffer.from(r.body.buffer, r.body.byteOffset, r.body.byteLength) : undefined);
  });
}

export interface PinnedStreamRequest {
  method: 'GET' | 'HEAD' | 'POST';
  path: string;
  /** Extra request headers (e.g. Range). */
  headers?: Readonly<Record<string, string>>;
  /** Sent in chunks of STREAM_CHUNK_BYTES; `onSent` hears after each one has left. */
  body?: Uint8Array;
  onSent?(sent: number, total: number): void;
  /** No byte either way (connecting, sending, receiving) for this long: TIMEOUT. */
  idleMs: number;
  /** Aborting destroys the request (CONNECTION_LOST). */
  signal?: AbortSignal;
}

export interface PinnedStreamResponse {
  status: number;
  headers: IncomingHttpHeaders;
  /** The body as it arrives; the caller reads or destroys it. Stalls past `idleMs` end it with an error. */
  body: IncomingMessage;
}

/** Upload bodies leave in pieces of this size, so progress moves and memory stays flat. */
export const STREAM_CHUNK_BYTES = 256 * 1024;

/**
 * One HTTPS exchange with a GhostLink server over the pinned TLS, for files: the body goes out
 * in chunks with progress, and the response comes back as a stream (Range for video, large
 * downloads). Resolves at the response head; rejects like pinnedRequest. Nothing logs the path.
 */
export function pinnedStream(server: PinnedTarget, r: PinnedStreamRequest): Promise<PinnedStreamResponse> {
  const { host, port } = parseHostPort(server.address);
  const pin = server.serverKeyId;
  return new Promise<PinnedStreamResponse>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      r.signal?.removeEventListener('abort', onAbort);
      req.destroy();
      reject(error);
    };
    const onAbort = () => fail(new AppError('CONNECTION_LOST', 'cancelled'));
    const headers: Record<string, string | number> = { Accept: '*/*', ...r.headers };
    if (r.body) {
      headers['Content-Type'] = 'application/octet-stream';
      headers['Content-Length'] = r.body.byteLength;
    }
    const req = httpsRequest(
      {
        host,
        port,
        method: r.method,
        path: r.path,
        headers,
        createConnection: ((options: ClientRequestArgs) => pinnedTlsConnect(options, pin)) as unknown as ClientRequestArgs['createConnection'],
      },
      (res) => {
        if (settled) {
          res.destroy();
          return;
        }
        settled = true;
        r.signal?.removeEventListener('abort', onAbort);
        // After the head, a stall or an abort ends the body stream with an error the reader sees.
        r.signal?.addEventListener('abort', () => res.destroy(new AppError('CONNECTION_LOST', 'cancelled')), { once: true });
        res.on('aborted', () => res.destroy(new AppError('CONNECTION_LOST')));
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res });
      },
    );
    req.setTimeout(r.idleMs, () => {
      const timeout = new AppError('TIMEOUT');
      if (!settled) fail(timeout);
      else req.destroy(timeout);
    });
    req.on('error', (e) => fail(e instanceof AppError ? e : networkError(e)));
    if (r.signal?.aborted) return onAbort();
    r.signal?.addEventListener('abort', onAbort, { once: true });
    if (!r.body) {
      req.end();
      return;
    }
    void writeBody(req, r.body, r.onSent).then(
      () => req.end(),
      (e: unknown) => fail(e instanceof Error ? e : new AppError('CONNECTION_LOST')),
    );
  });
}

/** Writes `body` in chunks, waiting for 'drain' when the socket is full; `onSent` after each chunk is flushed. */
async function writeBody(req: ClientRequest, body: Uint8Array, onSent?: (sent: number, total: number) => void): Promise<void> {
  const total = body.byteLength;
  const bytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  for (let at = 0; at < total; at += STREAM_CHUNK_BYTES) {
    if (req.destroyed) throw new AppError('CONNECTION_LOST');
    const chunk = bytes.subarray(at, Math.min(total, at + STREAM_CHUNK_BYTES));
    const end = at + chunk.length;
    // The callback runs once the chunk is flushed: waiting for it is the backpressure.
    await new Promise<void>((resolve, reject) => {
      req.write(chunk, (e) => (e ? reject(e) : resolve()));
    });
    onSent?.(end, total);
  }
}

/** Never the original message: Node's can name the host, and nothing here may carry the URL. */
function networkError(e: Error & { code?: unknown }): AppError {
  if (e.code === 'PIN_MISMATCH') return new AppError('PIN_MISMATCH');
  if (e.code === 'ECONNRESET') return new AppError('CONNECTION_LOST');
  return new AppError('UNREACHABLE');
}

/** The body as JSON; undefined when it is not JSON. */
export function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
}
