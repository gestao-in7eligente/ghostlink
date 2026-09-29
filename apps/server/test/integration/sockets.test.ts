// Pre-TLS admission (spec §13): the WebSocket limits only apply after TLS, HTTP and the
// upgrade, so raw TCP sockets are capped before that — a TLS handshake deadline, a
// global cap and a per-address cap — or one host could hold every file descriptor.
import { mkdtempSync, rmSync } from 'node:fs';
import { request, type Server } from 'node:https';
import { connect as netConnect, createServer as createNetServer, type AddressInfo, type Socket } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpServer } from '../../src/http/server.js';
import { resolveLimits } from '../../src/limits.js';
import { guardAddresses } from '../../src/net/ports.js';
import { loadOrCreateCertificate } from '../../src/tls/certificate.js';
import { startTestServer, type TestServer } from '../helpers/testClient.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function server(opts: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const t = await startTestServer(opts);
  cleanups.push(() => t.cleanup());
  return t;
}

/** A raw TCP socket that never sends a byte; `closed` resolves with how long it stayed open (ms). */
function silentSocket(port: number, host = '127.0.0.1'): Promise<{ closed: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const socket: Socket = netConnect({ port, host });
    cleanups.push(() => socket.destroy());
    socket.on('error', () => {});
    socket.once('connect', () => {
      const opened = Date.now();
      resolve({ closed: new Promise((r) => socket.once('close', () => r(Date.now() - opened))) });
    });
    socket.once('close', () => reject(new Error('closed before connecting')));
  });
}

/** A finished TLS handshake, i.e. a socket the server admitted; rejects when the server refused it. */
function tlsSocket(port: number, host = '127.0.0.1'): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ port, host, rejectUnauthorized: false });
    cleanups.push(() => socket.destroy());
    socket.once('secureConnect', () => resolve(socket));
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('closed during the TLS handshake')));
  });
}

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`still open after ${ms} ms`)), ms))]);
}

function health(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host, port, path: '/health', rejectUnauthorized: false, agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

/** The server frees a slot when it sees the close: poll instead of guessing a delay. */
async function eventuallyAdmitted(port: number): Promise<TLSSocket> {
  let last: unknown;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      return await tlsSocket(port);
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  throw last;
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createNetServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

const hasIPv6Loopback = Object.values(networkInterfaces()).some((list) => list?.some((i) => i.address === '::1'));

describe('TLS handshake deadline', () => {
  it('closes a TCP socket that never sends a ClientHello once the handshake timeout passes', async () => {
    const t = await server({ limits: { tlsHandshakeTimeoutMs: 300 } });
    const { closed } = await silentSocket(t.server.port);
    expect(await within(closed, 5_000)).toBeGreaterThanOrEqual(250);
  });

  it('leaves a finished handshake alone', async () => {
    const t = await server({ limits: { tlsHandshakeTimeoutMs: 300 } });
    const s = await tlsSocket(t.server.port);
    await new Promise((r) => setTimeout(r, 600));
    expect(s.destroyed).toBe(false);
  });
});

describe('open sockets per address and in total', () => {
  it.runIf(hasIPv6Loopback)('refuses the socket over the per-address cap at once; other addresses still connect; a close frees the slot', async () => {
    // Dual stack: 127.0.0.1 arrives as ::ffff:127.0.0.1 (one key) and ::1 is another address.
    // On Windows the 127.0.0.1 connections also go through the guard listener (guardAddresses).
    const t = await server({ host: '::', limits: { maxSocketsPerIp: 3 } });
    const port = t.server.port;
    const admitted = [await tlsSocket(port), await tlsSocket(port), await tlsSocket(port)];

    const extra = await silentSocket(port);
    await within(extra.closed, 2_000); // long before the 10 s handshake deadline
    await expect(tlsSocket(port)).rejects.toThrow();

    expect(await health(port, '::1')).toBe(200);
    expect((await tlsSocket(port, '::1')).destroyed).toBe(false);

    admitted[0]!.destroy();
    expect((await eventuallyAdmitted(port)).destroyed).toBe(false);
    for (const s of admitted.slice(1)) expect(s.destroyed).toBe(false);
  });

  it('caps open sockets in total, whatever their address', async () => {
    const t = await server({ limits: { maxSockets: 2, maxSocketsPerIp: 100 } });
    const admitted = [await tlsSocket(t.server.port), await tlsSocket(t.server.port)];
    await expect(tlsSocket(t.server.port)).rejects.toThrow();
    admitted[1]!.destroy();
    expect((await eventuallyAdmitted(t.server.port)).destroyed).toBe(false);
  });

  it('counts a socket forwarded by guardAddresses exactly once', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ghostlink-test-'));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const certificate = await loadOrCreateCertificate(dataDir);
    const http: Server = createHttpServer({
      certPem: certificate.certPem,
      keyPem: certificate.keyPem,
      health: () => ({ name: 'x', version: '0' }),
      onUpgrade: (_req, socket) => socket.destroy(),
      limits: resolveLimits({ maxSocketsPerIp: 3 }),
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
    cleanups.push(
      () =>
        new Promise<void>((r) => {
          http.close(() => r());
          http.closeAllConnections();
        }),
    );
    // A guard on another port of the same address, so this runs on every OS (Windows guards the same port).
    const guardPort = await freePort();
    const guards = await guardAddresses(http, guardPort, ['127.0.0.1']);
    expect(guards).toHaveLength(1);
    cleanups.push(() => Promise.all(guards.map((g) => new Promise<void>((r) => g.close(() => r())))));

    const viaGuard = [await tlsSocket(guardPort), await tlsSocket(guardPort), await tlsSocket(guardPort)];
    const extra = await silentSocket(guardPort);
    await within(extra.closed, 2_000);
    await expect(tlsSocket((http.address() as AddressInfo).port)).rejects.toThrow(); // same address, direct

    viaGuard[0]!.destroy();
    expect((await eventuallyAdmitted(guardPort)).destroyed).toBe(false);
  });
});
