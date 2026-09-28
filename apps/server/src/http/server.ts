import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { PROTOCOL } from '@ghostlink/shared';

export interface HttpServerDeps {
  certPem: string;
  keyPem: string;
  /** Public, non-sensitive facts for /health. */
  health: () => { name: string; version: string };
  onUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
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
  res.writeHead(404, { 'Content-Length': 0 });
  res.end();
}

/** HTTPS server with /health, HEAD|GET / and the /ws upgrade; everything else is 404 (spec §4). */
export function createHttpServer(deps: HttpServerDeps): Server {
  const server = createServer(
    { cert: deps.certPem, key: deps.keyPem, headersTimeout: 10_000, requestTimeout: 30_000 },
    (req, res) => route(deps, req, res),
  );
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (pathOf(req.url) === '/ws') {
      deps.onUpgrade(req, socket, head);
      return;
    }
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  return server;
}
