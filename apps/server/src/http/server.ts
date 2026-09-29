import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { PROTOCOL } from '@ghostlink/shared';
import type { ServerLimits } from '../limits.js';
import { ipKey } from '../ratelimit/limiter.js';

/** Pre-TLS admission (spec §13); the WebSocket limits only start after the upgrade. */
export type SocketLimits = Pick<ServerLimits, 'tlsHandshakeTimeoutMs' | 'maxSockets' | 'maxSocketsPerIp'>;

export interface HttpServerDeps {
  certPem: string;
  keyPem: string;
  /** Public, non-sensitive facts for /health. */
  health: () => { name: string; version: string };
  onUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  /** Module routes, tried after the built-in ones; true when handled. */
  moduleRequest?: (req: IncomingMessage, res: ServerResponse) => boolean;
  /** Module upgrades for any path but /ws; true when handled. */
  moduleUpgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  limits: SocketLimits;
}

function pathOf(url: string | undefined): string {
  return (url ?? '/').split('?')[0]!;
}

function route(deps: HttpServerDeps, req: IncomingMessage, res: ServerResponse): void {
  const path = pathOf(req.url);
  const readOnly = req.method === 'GET' || req.method === 'HEAD';
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (path === '/health' && readOnly) {
    const { name, version } = deps.health();
    const body = JSON.stringify({ ok: true, name, version, protocol: { min: PROTOCOL.min, max: PROTOCOL.max } });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }
  if (path === '/' && readOnly) {
    // livekit-client HEADs the origin to decide when to reconnect (spec §4).
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': 2 });
    res.end(req.method === 'HEAD' ? undefined : 'OK');
    return;
  }
  if (deps.moduleRequest?.(req, res)) return;
  res.writeHead(404, { 'Content-Length': 0 });
  res.end();
}

/**
 * Counts every raw TCP socket from 'connection' to 'close': at most `maxSockets` in total
 * and `maxSocketsPerIp` per address (IPv6 per /64); one more is destroyed at once, before
 * TLS sees it. The sockets guardAddresses() forwards arrive through this same event
 * (server.emit('connection')), so they are counted here, exactly once.
 */
function capSockets(server: Server, limits: SocketLimits): void {
  const perIp = new Map<string, number>();
  let total = 0;
  server.prependListener('connection', (socket: Socket) => {
    const address = socket.remoteAddress;
    if (socket.destroyed || address === undefined) {
      socket.destroy(); // already gone: nothing to count
      return;
    }
    const key = ipKey(address);
    const fromHere = perIp.get(key) ?? 0;
    if (total >= limits.maxSockets || fromHere >= limits.maxSocketsPerIp) {
      socket.destroy();
      return;
    }
    total++;
    perIp.set(key, fromHere + 1);
    socket.once('close', () => {
      total--;
      const left = (perIp.get(key) ?? 1) - 1;
      if (left > 0) perIp.set(key, left);
      else perIp.delete(key);
    });
  });
}

/**
 * HTTPS server with /health, HEAD|GET / and the /ws upgrade (spec §4). Other
 * requests and upgrades are offered to the modules; unclaimed ones get 404.
 * Before any of that, raw sockets are capped (capSockets) and a TLS handshake
 * must finish within `tlsHandshakeTimeoutMs` (Node's default is 120 s).
 */
export function createHttpServer(deps: HttpServerDeps): Server {
  const server = createServer(
    {
      cert: deps.certPem,
      key: deps.keyPem,
      handshakeTimeout: deps.limits.tlsHandshakeTimeoutMs,
      headersTimeout: 10_000,
      requestTimeout: 30_000,
    },
    (req, res) => route(deps, req, res),
  );
  // The kernel-level cap for direct connections; capSockets also covers the forwarded ones.
  server.maxConnections = deps.limits.maxSockets;
  capSockets(server, deps.limits);
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (pathOf(req.url) === '/ws') {
      deps.onUpgrade(req, socket, head);
      return;
    }
    if (deps.moduleUpgrade?.(req, socket, head)) return;
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  return server;
}
