import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { join } from 'node:path';
import type { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import { serverKeyFromSeed, type ServerKey } from '../../src/main/identity.js';

export function randomKey(): ServerKey {
  return serverKeyFromSeed(randomBytes(32));
}

export const TEST_HELLO = { nickname: 'Ana', locale: 'pt-BR', client: 'ghostlink-test/0.0.0 (test)' };

/** A port nothing listens on (bound once, then released). */
export async function deadPort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

/** Accepts TCP connections and never answers: a black hole. */
export async function silentServer(): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createTcpServer((s) => {
    sockets.add(s);
    s.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/**
 * An HTTPS server presenting a real GhostLink certificate (read from a test
 * server's data dir) that only counts what reaches it: TCP connections, HTTP
 * requests and WebSocket upgrade requests.
 */
export async function countingServer(dataDir: string): Promise<{
  port: number;
  counts: { connections: number; requests: number; upgrades: number };
  close(): Promise<void>;
}> {
  const counts = { connections: 0, requests: 0, upgrades: 0 };
  const server = createHttpsServer({
    cert: readFileSync(join(dataDir, 'tls', 'server.crt')),
    key: readFileSync(join(dataDir, 'tls', 'server.key')),
  }, (_req, res) => {
    counts.requests++;
    res.end();
  });
  server.on('connection', () => counts.connections++);
  server.on('upgrade', (_req, socket) => {
    counts.upgrades++;
    socket.destroy();
  });
  server.on('tlsClientError', () => {});
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    counts,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** Accepts the TLS connection and the WebSocket upgrade, then never says a word (a stuck handshake). */
export async function stallingServer(dataDir: string): Promise<{ port: number; close(): Promise<void> }> {
  const server = createHttpsServer({
    cert: readFileSync(join(dataDir, 'tls', 'server.crt')),
    key: readFileSync(join(dataDir, 'tls', 'server.key')),
  });
  const wss = new WebSocketServer({ server });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

export async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Resolves with the first `event` payload emitted from now on. */
export function nextEvent<T>(emitter: EventEmitter, event: string, timeoutMs = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, onEvent);
      reject(new Error(`no ${event} within ${timeoutMs} ms`));
    }, timeoutMs);
    const onEvent = (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    };
    emitter.once(event, onEvent);
  });
}
