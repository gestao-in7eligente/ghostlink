// The owner's bug: on Windows a server bound to 0.0.0.0:7700 while an old CLI server
// already listened on 127.0.0.1:7700; local connections reached the old server.
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:https';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger, startServer, type GhostServer } from '../../src/index.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ghostlink-test-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

function listen(port: number, host: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer((c) => {
      c.on('error', () => {}); // the probe connects and drops
      c.end('not ghostlink\n');
    });
    s.once('error', reject);
    s.listen({ port, host, exclusive: true }, () => resolve(s));
  });
}

async function freePort(): Promise<number> {
  for (;;) {
    const s = await listen(0, '127.0.0.1');
    const { port } = s.address() as { port: number };
    await new Promise<void>((r) => s.close(() => r()));
    if (port > 1024) return port;
  }
}

async function start(port: number, host: string): Promise<GhostServer> {
  const server = await startServer({ dataDir: dataDir(), port, host, logger: silentLogger });
  cleanups.push(() => server.close());
  return server;
}

function health(port: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/health', rejectUnauthorized: false }, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => (body += d.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('busy-port detection before listening (spec §8.5)', () => {
  it('refuses 0.0.0.0:<port> when another listener holds 127.0.0.1:<port>, before touching the data dir', async () => {
    const port = await freePort();
    const old = await listen(port, '127.0.0.1');
    cleanups.push(() => new Promise<void>((r) => old.close(() => r())));
    const dir = dataDir();
    await expect(startServer({ dataDir: dir, port, host: '0.0.0.0', logger: silentLogger })).rejects.toMatchObject({
      code: 'EADDRINUSE',
      port,
      busyOn: expect.arrayContaining(['127.0.0.1']),
    });
  });

  it('refuses 127.0.0.1:<port> when a wildcard listener already answers there', async () => {
    const port = await freePort();
    const old = await listen(port, '0.0.0.0');
    cleanups.push(() => new Promise<void>((r) => old.close(() => r())));
    await expect(startServer({ dataDir: dataDir(), port, host: '127.0.0.1', logger: silentLogger })).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });

  it('port 0 (tests) skips the probe', async () => {
    const server = await start(0, '127.0.0.1');
    expect(server.port).toBeGreaterThan(0);
  });
});

describe.runIf(process.platform === 'win32')('shadowing guard on Windows', () => {
  it('holds 127.0.0.1 after a wildcard listen: nobody can bind it later, and it serves GhostLink', async () => {
    const port = await freePort();
    await start(port, '0.0.0.0');
    await expect(listen(port, '127.0.0.1')).rejects.toMatchObject({ code: 'EADDRINUSE' });
    const res = await health(port);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true });
  });

  it('releases the guards on close', async () => {
    const port = await freePort();
    const server = await startServer({ dataDir: dataDir(), port, host: '0.0.0.0', logger: silentLogger });
    await server.close();
    const again = await listen(port, '127.0.0.1');
    await new Promise<void>((r) => again.close(() => r()));
  });
});
