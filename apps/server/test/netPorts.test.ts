import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { findFreeTcpPort, portInUseError, probeTcpPort, probeUdpPort } from '../src/net/ports.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function hold(port: number, host: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer((c) => {
      c.on('error', () => {});
      c.destroy();
    });
    s.once('error', reject);
    s.listen(port, host, () => {
      cleanups.push(() => new Promise<void>((r) => s.close(() => r())));
      resolve(s);
    });
  });
}

function holdUdp(port: number, host: string): Promise<UdpSocket> {
  return new Promise((resolve, reject) => {
    const s = createSocket('udp4');
    s.once('error', reject);
    s.bind(port, host, () => {
      cleanups.push(() => new Promise<void>((r) => s.close(() => r())));
      resolve(s);
    });
  });
}

/** A port nothing uses right now, with room for +10/+20 above it. */
async function freeBase(): Promise<number> {
  for (;;) {
    const s = await new Promise<Server>((r) => {
      const srv = createServer();
      srv.listen(0, '127.0.0.1', () => r(srv));
    });
    const port = (s.address() as { port: number }).port;
    await new Promise<void>((r) => s.close(() => r()));
    if (port > 1024 && port < 60_000) return port;
  }
}

describe('probeTcpPort (spec §8.5, Windows shadowing bug)', () => {
  it('reports a free port as free', async () => {
    const port = await freeBase();
    expect(await probeTcpPort(port, { bindHost: '0.0.0.0' })).toEqual({ free: true, busyOn: [] });
  });

  it('sees a listener on 127.0.0.1 even when binding 0.0.0.0 would succeed (Windows lets both coexist)', async () => {
    const port = await freeBase();
    await hold(port, '127.0.0.1');
    const probe = await probeTcpPort(port, { bindHost: '0.0.0.0' });
    expect(probe.free).toBe(false);
    expect(probe.busyOn).toEqual(expect.arrayContaining(['127.0.0.1']));
  });

  it('sees a wildcard listener when we would bind loopback only (it answers a connect)', async () => {
    const port = await freeBase();
    await hold(port, '0.0.0.0');
    expect((await probeTcpPort(port, { bindHost: '127.0.0.1' })).free).toBe(false);
  });

  it('checks every local IPv4 it is given', async () => {
    const port = await freeBase();
    await hold(port, '127.0.0.1');
    const probe = await probeTcpPort(port, { bindHost: '0.0.0.0', localIps: ['127.0.0.1'] });
    expect(probe.free).toBe(false);
  });
});

/** A UDP port the OS just handed out (free on 0.0.0.0 and 127.0.0.1 a moment ago). */
async function freeUdp(): Promise<number> {
  const s = createSocket('udp4');
  await new Promise<void>((r) => s.bind(0, '0.0.0.0', () => r()));
  const { port } = s.address();
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe('probeUdpPort (media 7882/UDP)', () => {
  it('reports free and busy UDP ports', async () => {
    const port = await freeUdp();
    expect(await probeUdpPort(port)).toEqual({ free: true, busyOn: [] });
    await holdUdp(port, '127.0.0.1');
    expect((await probeUdpPort(port)).free).toBe(false);
  });
});

describe('findFreeTcpPort (7710, 7720, …)', () => {
  it('steps by 10 past busy ports', async () => {
    const base = await freeBase();
    await hold(base, '127.0.0.1');
    await hold(base + 10, '127.0.0.1').catch(() => {}); // already taken by someone else is just as busy
    // Other suites run in parallel and may hold base+20 by chance: any later step of 10 is right.
    const found = await findFreeTcpPort(base, { bindHost: '0.0.0.0' });
    expect(found).not.toBeNull();
    expect(found! - base).toBeGreaterThanOrEqual(20);
    expect((found! - base) % 10).toBe(0);
  });

  it('gives up after the allowed tries and never goes past 65535', async () => {
    expect(await findFreeTcpPort(65_530, { bindHost: '0.0.0.0', tries: 3 })).toBe(null);
    expect(await findFreeTcpPort(7700, { bindHost: '0.0.0.0', tries: 2, probe: async () => ({ free: false, busyOn: ['x'] }) })).toBe(null);
    const seen: number[] = [];
    await findFreeTcpPort(7700, { tries: 3, probe: async (p) => (seen.push(p), { free: false, busyOn: [] }) });
    expect(seen).toEqual([7710, 7720, 7730]);
  });
});

describe('portInUseError', () => {
  it('looks like the listen error Node throws', () => {
    const e = portInUseError(7700, '0.0.0.0', ['127.0.0.1']);
    expect(e).toMatchObject({ code: 'EADDRINUSE', port: 7700 });
    expect(e.message).toMatch(/EADDRINUSE.*7700/);
  });
});
