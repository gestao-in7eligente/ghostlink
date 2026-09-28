import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';

/** The only LiveKit routes the client uses (livekit-client 2.x: v1 path, v0 fallback, validate). */
const RTC_PATHS: ReadonlySet<string> = new Set(['/rtc', '/rtc/v1', '/rtc/validate', '/rtc/v1/validate']);

export function pathOf(url: string | undefined): string {
  return (url ?? '/').split('?')[0]!;
}

/** Everything under /rtc belongs to the proxy: unknown sub-paths get 403, never 404 (spec §4). */
export function isRtcRequest(url: string | undefined): boolean {
  const path = pathOf(url);
  return path === '/rtc' || path.startsWith('/rtc/');
}

/** `access_token` from the query string (livekit-client always sends it there). */
export function accessTokenOf(url: string | undefined): string | null {
  const q = (url ?? '').indexOf('?');
  if (q < 0) return null;
  const params = new URLSearchParams((url ?? '').slice(q + 1));
  const values = params.getAll('access_token');
  return values.length === 1 ? values[0]! : null;
}

export interface RtcProxyDeps {
  /** The LiveKit signaling port on 127.0.0.1, or null when voice is down. */
  target(): number | null;
  /** The authorization decision for this token, evaluated now (spec §4). */
  authorize(token: string | null): boolean;
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);

function refuseSocket(socket: Duplex, status: 403 | 503): void {
  const text = status === 403 ? 'Forbidden' : 'Service Unavailable';
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * The authorized /rtc* reverse proxy (spec §4): HTTP and WebSocket to LiveKit's
 * loopback port, path and query forwarded byte for byte, status and body returned
 * unchanged. A refusal is 403 — a 404 would make livekit-client fall back to /rtc.
 * URLs are never logged: the query carries the token.
 */
export class RtcProxy {
  readonly #deps: RtcProxyDeps;

  constructor(deps: RtcProxyDeps) {
    this.#deps = deps;
  }

  http(req: IncomingMessage, res: ServerResponse): boolean {
    if (!isRtcRequest(req.url)) return false;
    const port = this.#deps.target();
    const allowed = RTC_PATHS.has(pathOf(req.url)) && (req.method === 'GET' || req.method === 'HEAD');
    if (!allowed || !this.#deps.authorize(accessTokenOf(req.url))) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': 9 }).end('forbidden');
      return true;
    }
    if (port === null) {
      res.writeHead(503, { 'Content-Length': 0 }).end();
      return true;
    }
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !HOP_BY_HOP.has(k)));
    const upstream = request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers, timeout: 15_000 }, (up) => {
      const raw: string[] = [];
      for (let i = 0; i < up.rawHeaders.length; i += 2) {
        if (!HOP_BY_HOP.has(up.rawHeaders[i]!.toLowerCase())) raw.push(up.rawHeaders[i]!, up.rawHeaders[i + 1]!);
      }
      res.writeHead(up.statusCode ?? 502, up.statusMessage, raw);
      up.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Length': 0 });
      res.end();
    });
    req.pipe(upstream);
    return true;
  }

  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    if (!isRtcRequest(req.url)) return false;
    if (!RTC_PATHS.has(pathOf(req.url)) || req.method !== 'GET' || !this.#deps.authorize(accessTokenOf(req.url))) {
      refuseSocket(socket, 403);
      return true;
    }
    const port = this.#deps.target();
    if (port === null) {
      refuseSocket(socket, 503);
      return true;
    }
    const upstream = connect({ host: '127.0.0.1', port });
    const destroyBoth = () => {
      socket.destroy();
      upstream.destroy();
    };
    upstream.once('connect', () => {
      let preamble = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) preamble += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      upstream.write(`${preamble}\r\n`);
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', () => {
      if (socket.writable && upstream.bytesRead === 0) refuseSocket(socket, 503);
      else destroyBoth();
    });
    socket.on('error', destroyBoth);
    upstream.on('close', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
    return true;
  }
}
