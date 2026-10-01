// One HTTPS request to a GhostLink server, over TLS pinned to its serverKeyId (spec §3.3), the
// way the WSS connects: a server with another key never receives a byte. Used for profile photos
// (avatars/avatarHttp.ts) and the owner's version checks (railway/serverStatus.ts). URLs and
// Node's error messages (they can name the host) never reach an error or a log line.
import { request as httpsRequest } from 'node:https';
import type { ClientRequestArgs } from 'node:http';
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
