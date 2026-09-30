// Proxy mode (spec §8.5): behind a TCP proxy that forwards ONE port, the public port
// carries HTTPS/WSS and voice. The first byte tells them apart: 0x16 is a TLS handshake
// record, 0x00-0x02 the length prefix of an ICE-TCP frame (RFC 4571), which is piped to
// the loopback port a module offers (LiveKit's rtc.tcp_port). Anything else is closed.
import { createHash, randomBytes } from 'node:crypto';
import { request } from 'node:https';
import { connect as netConnect, createServer as createNetServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerModule } from '../../src/index.js';
import { connectRaw, connectTestClient, startTestServer, type TestClient, type TestServer } from '../helpers/testClient.js';

const cleanups: Array<() => unknown> = [];
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const c of cleanups.splice(0).reverse()) await c();
});

const PROXY = { host: 'proxy.example.net', port: 25_889 };

/** A loopback TCP server standing in for LiveKit's ICE-TCP port: records every byte, optionally echoes. */
class FakeIce {
  readonly server: Server;
  readonly sockets: Socket[] = [];
  readonly received: Buffer[] = [];
  echo = true;
  port = 0;

  constructor() {
    this.server = createNetServer((socket) => {
      this.sockets.push(socket);
      socket.on('error', () => {});
      socket.on('data', (chunk: Buffer) => {
        this.received.push(chunk);
        if (this.echo) socket.write(chunk);
      });
    });
  }

  async listen(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
    cleanups.push(() => this.close());
    return this;
  }

  bytes(): Buffer {
    return Buffer.concat(this.received);
  }

  close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

/** A module that offers `target()` as the ICE-TCP port, like the voice module behind a proxy. */
function iceModule(target: () => number | null): ServerModule {
  return { name: 'ice-stub', iceTcpPort: target };
}

async function proxied(opts: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const t = await startTestServer({ joinMode: 'open', proxy: PROXY, ...opts });
  cleanups.push(() => t.cleanup());
  return t;
}

interface RawTcp {
  socket: Socket;
  data: Buffer[];
  closed: Promise<number>; // ms the socket stayed open
}

function tcp(port: number): Promise<RawTcp> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ port, host: '127.0.0.1' });
    cleanups.push(() => socket.destroy());
    const data: Buffer[] = [];
    socket.on('data', (c: Buffer) => data.push(c));
    socket.on('error', () => {});
    socket.once('connect', () => {
      const opened = Date.now();
      resolve({ socket, data, closed: new Promise((r) => socket.once('close', () => r(Date.now() - opened))) });
    });
    socket.once('close', () => reject(new Error('closed before connecting')));
  });
}

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms))]);
}

const stillOpen = async (s: RawTcp, ms: number): Promise<boolean> => (await Promise.race([s.closed.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), ms))]));

/** The start of an ICE-TCP connection: a 2-byte length, then a STUN binding request header. */
function iceFrame(payload: Buffer = Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xa4, 0x42]), randomBytes(12)])): Buffer {
  const header = Buffer.alloc(2);
  header.writeUInt16BE(payload.length);
  return Buffer.concat([header, payload]);
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function health(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/health', rejectUnauthorized: false, agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('proxy mode: TLS on the shared public port', () => {
  it('serves /health and the WebSocket handshake; the pin is still checked', async () => {
    const ice = await new FakeIce().listen();
    const t = await proxied({ modules: [iceModule(() => ice.port)] });
    expect(await health(t.server.port)).toBe(200);
    const c = await connectTestClient(t.server);
    clients.push(c);
    expect(c.welcome).toBeDefined();
    expect(await c.request('ping')).toMatchObject({ ok: true });
    // A client pinned to another key refuses the server before the upgrade.
    await expect(connectRaw(t.server, { pin: 'A'.repeat(43) })).rejects.toMatchObject({ code: 'PIN_MISMATCH' });
    expect(ice.sockets).toHaveLength(0); // TLS never reaches the ICE target
  });

  it('a TLS client that sends one byte and stalls is closed by the TLS handshake deadline', async () => {
    const t = await proxied({ limits: { tlsHandshakeTimeoutMs: 300 } });
    const s = await tcp(t.server.port);
    s.socket.write(Buffer.from([0x16]));
    expect(await within(s.closed, 5_000)).toBeGreaterThanOrEqual(250);
  });
});

describe('proxy mode: ICE-TCP on the shared public port', () => {
  it('pipes the bytes to the module\'s loopback port and back, byte for byte', async () => {
    const ice = await new FakeIce().listen();
    const t = await proxied({ modules: [iceModule(() => ice.port)] });
    const s = await tcp(t.server.port);
    s.socket.setNoDelay(true);
    const sent = Buffer.concat([iceFrame(), randomBytes(3 * 1024 * 1024)]);
    s.socket.write(sent);
    await until(() => ice.bytes().length === sent.length && Buffer.concat(s.data).length === sent.length, 15_000);
    expect(sha(ice.bytes())).toBe(sha(sent));
    expect(sha(Buffer.concat(s.data))).toBe(sha(sent));
    // Nagle off on both legs: media packets are small and late ones are useless.
    expect(ice.sockets).toHaveLength(1);
  });

  it('keeps every byte when the target reads slowly (backpressure)', async () => {
    const ice = await new FakeIce().listen();
    ice.echo = false;
    const t = await proxied({ modules: [iceModule(() => ice.port)] });
    const s = await tcp(t.server.port);
    const frame = iceFrame();
    s.socket.write(frame);
    await until(() => ice.sockets.length === 1);
    ice.sockets[0]!.pause();
    const bulk = randomBytes(64 * 1024 * 1024);
    const before = process.memoryUsage().arrayBuffers;
    s.socket.write(bulk);
    await new Promise((r) => setTimeout(r, 1_000));
    // The pipe stopped reading from the client once the target stopped: the data waits in
    // the client and the kernel, not in the server's memory. (On Windows the client's
    // kernel takes all of it at once, so only the server's memory shows the difference.)
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(16 * 1024 * 1024);
    expect(ice.bytes().length).toBeLessThan(frame.length + bulk.length);
    ice.sockets[0]!.resume();
    await until(() => ice.bytes().length === frame.length + bulk.length, 30_000);
    expect(sha(ice.bytes())).toBe(sha(Buffer.concat([frame, bulk])));
  });

  it('a close on either side closes the other', async () => {
    const ice = await new FakeIce().listen();
    const t = await proxied({ modules: [iceModule(() => ice.port)] });
    const a = await tcp(t.server.port);
    a.socket.write(iceFrame());
    await until(() => ice.sockets.length === 1);
    ice.sockets[0]!.destroy(); // LiveKit drops the connection
    await within(a.closed, 3_000);

    const b = await tcp(t.server.port);
    b.socket.write(iceFrame());
    await until(() => ice.sockets.length === 2);
    const upstreamClosed = new Promise<void>((r) => ice.sockets[1]!.once('close', () => r()));
    b.socket.destroy(); // the client goes away
    await within(upstreamClosed, 3_000);
  });

  it('closes an ICE-TCP connection while no module offers a target (voice down)', async () => {
    let target: number | null = null;
    const ice = await new FakeIce().listen();
    const t = await proxied({ modules: [iceModule(() => target)] });
    const s = await tcp(t.server.port);
    s.socket.write(iceFrame());
    await within(s.closed, 3_000);
    target = ice.port;
    const again = await tcp(t.server.port);
    again.socket.write(iceFrame());
    await until(() => ice.sockets.length === 1);
  });

  it('never pipes anything outside proxy mode', async () => {
    const ice = await new FakeIce().listen();
    const t = await startTestServer({ modules: [iceModule(() => ice.port)] });
    cleanups.push(() => t.cleanup());
    const s = await tcp(t.server.port);
    s.socket.write(iceFrame());
    await within(s.closed, 5_000); // the TLS server rejects it
    expect(ice.sockets).toHaveLength(0);
  });
});

describe('proxy mode: pre-classification limits', () => {
  it('closes a socket that sends nothing within firstByteTimeoutMs', async () => {
    const t = await proxied({ limits: { firstByteTimeoutMs: 300 } });
    const s = await tcp(t.server.port);
    const lasted = await within(s.closed, 5_000);
    expect(lasted).toBeGreaterThanOrEqual(250);
  });

  it('closes a connection that is neither TLS nor ICE-TCP at once', async () => {
    const ice = await new FakeIce().listen();
    const t = await proxied({ modules: [iceModule(() => ice.port)] });
    const http = await tcp(t.server.port);
    http.socket.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
    await within(http.closed, 2_000);
    const big = await tcp(t.server.port);
    big.socket.write(Buffer.from([0x03, 0x00])); // a first frame over 512 bytes: LiveKit would refuse it
    await within(big.closed, 2_000);
    expect(ice.sockets).toHaveLength(0);
  });

  it('caps the ICE-TCP pipes open at once', async () => {
    const ice = await new FakeIce().listen();
    const t = await proxied({ modules: [iceModule(() => ice.port)], limits: { maxIceTcpConnections: 2 } });
    const a = await tcp(t.server.port);
    const b = await tcp(t.server.port);
    a.socket.write(iceFrame());
    b.socket.write(iceFrame());
    await until(() => ice.sockets.length === 2);
    const c = await tcp(t.server.port);
    c.socket.write(iceFrame());
    await within(c.closed, 2_000);
    expect(ice.sockets).toHaveLength(2);
    a.socket.destroy();
    await new Promise((r) => setTimeout(r, 100));
    const d = await tcp(t.server.port);
    d.socket.write(iceFrame());
    await until(() => ice.sockets.length === 3);
    expect(await stillOpen(d, 300)).toBe(true);
  });

  it('caps open sockets in total, before anything is read', async () => {
    const t = await proxied({ limits: { maxSockets: 2 } });
    const a = await tcp(t.server.port);
    await tcp(t.server.port);
    const extra = await tcp(t.server.port);
    await within(extra.closed, 2_000);
    a.socket.destroy();
    await new Promise((r) => setTimeout(r, 100));
    expect(await stillOpen(await tcp(t.server.port), 300)).toBe(true);
  });

  it('close() ends the connections still waiting for a first byte and the ICE-TCP pipes', async () => {
    const ice = await new FakeIce().listen();
    const t = await startTestServer({ proxy: PROXY, modules: [iceModule(() => ice.port)] });
    const waiting = await tcp(t.server.port);
    const piped = await tcp(t.server.port);
    piped.socket.write(iceFrame());
    await until(() => ice.sockets.length === 1);
    await within(t.cleanup(), 10_000);
    await within(Promise.all([waiting.closed, piped.closed]), 3_000);
  });
});
