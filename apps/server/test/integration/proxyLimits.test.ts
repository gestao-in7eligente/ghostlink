// spec §13 behind a TCP proxy (spec §8.6): every client arrives from the proxy's address,
// so a per-IP limit would throttle the whole server as if it were one person. Without a
// real client address the per-IP limits become server-wide, sized for a whole server;
// last_ip is not recorded (it would be the proxy's), so an IP ban has nothing to ban.
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { LIMITS, PROTOCOL, buildAuthMessage, toBase64Url } from '@ghostlink/shared';
import type { Logger } from '../../src/logger.js';
import { withDb } from '../helpers/db.js';
import { connectRaw, connectTestClient, makeIdentity, startTestServer, type RawClient, type TestClient, type TestServer } from '../helpers/testClient.js';

const PROXY = { host: 'altaria.proxy.rlwy.net', port: 25_889 };

const servers: TestServer[] = [];
const sockets: Array<{ close(): void }> = [];
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of sockets.splice(0)) s.close();
  await Promise.all(servers.splice(0).map((s) => s.cleanup()));
});

async function server(opts: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const t = await startTestServer({ joinMode: 'open', proxy: PROXY, ...opts });
  servers.push(t);
  return t;
}
async function raw(t: TestServer): Promise<RawClient> {
  const r = await connectRaw(t.server);
  sockets.push(r);
  return r;
}
async function client(t: TestServer, opts: Parameters<typeof connectTestClient>[1] = {}): Promise<TestClient> {
  const c = await connectTestClient(t.server, opts);
  clients.push(c);
  return c;
}

/** One authentication failure: a proof signed with the wrong key. */
async function failOnce(t: TestServer): Promise<void> {
  const r = await raw(t);
  r.send({ t: 'hello', d: { protocol: PROTOCOL.current, publicKey: makeIdentity().publicKey, nickname: 'x', locale: 'en', client: 't' } });
  const { nonce } = (await r.next()).d as { nonce: string };
  r.send({ t: 'auth.proof', d: { signature: toBase64Url(makeIdentity().sign(buildAuthMessage(t.server.serverKeyId, nonce))) } });
  expect(await r.next()).toMatchObject({ t: 'error', d: { code: 'BAD_SIGNATURE' } });
}

async function hello(r: RawClient, i: number): Promise<string> {
  r.send({ t: 'hello', d: { protocol: 1, publicKey: makeIdentity().publicKey, nickname: `n${i}`, locale: 'en', client: 't' } });
  const m = await r.next();
  return m.t === 'error' ? (m.d as { code: string }).code : m.t;
}

function tlsSocket(port: number): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ port, host: '127.0.0.1', rejectUnauthorized: false });
    sockets.push({ close: () => socket.destroy() });
    socket.once('secureConnect', () => resolve(socket));
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('closed during the TLS handshake')));
  });
}

describe('proxy mode: the per-IP limits are server-wide (spec §13)', () => {
  it('more than 64 open sockets and 20 unauthenticated connections from "one address" are fine', async () => {
    const t = await server();
    const tls = await Promise.all(Array.from({ length: LIMITS.maxSocketsPerIp + 6 }, () => tlsSocket(t.server.port)));
    expect(tls.every((s) => !s.destroyed)).toBe(true);
    for (const s of tls) s.destroy();
    const open = await Promise.all(Array.from({ length: LIMITS.maxConnectionsPerIp + 5 }, () => raw(t)));
    // …and more than 5 pending challenges at once.
    const replies = await Promise.all(open.map((r, i) => hello(r, i)));
    expect(replies.every((reply) => reply === 'challenge')).toBe(true);
  });

  it('the server-wide caps still hold', async () => {
    const t = await server({ limits: { maxUnauthenticatedConnections: 3 } });
    await Promise.all([raw(t), raw(t), raw(t)]);
    const extra = await raw(t);
    expect(await extra.next()).toEqual({ t: 'error', d: { code: 'RATE_LIMITED' } });
  });

  it('authentication failures are counted for the whole server, with a higher threshold', async () => {
    const t = await server({ limits: { authFailuresPerIpPerMinute: 3 } });
    for (let i = 0; i < 3; i++) await failOnce(t);
    expect((await client(t)).error?.code).toBe('RATE_LIMITED');
  });

  it('a flood of failures cannot lock the members out', async () => {
    const t = await server({ limits: { authFailuresPerIpPerMinute: 3 } });
    const seed = new Uint8Array(32).fill(9);
    (await client(t, { seed })).close();
    for (let i = 0; i < 3; i++) await failOnce(t);
    expect((await client(t)).error?.code).toBe('RATE_LIMITED'); // newcomers wait
    expect((await client(t, { seed })).welcome).toBeDefined();
  });

  it('30 new identities per hour for the whole server', async () => {
    const clock = { t: Date.now() };
    const t = await server({ now: () => clock.t });
    for (let i = 0; i < 30; i++) expect((await client(t)).welcome, `identity ${i}`).toBeDefined();
    expect((await client(t)).error?.code).toBe('RATE_LIMITED');
    clock.t += 3_600_001;
    expect((await client(t)).welcome).toBeDefined();
  });

  it("does not record the proxy's address as a member's last IP", async () => {
    const t = await server();
    const c = await client(t);
    expect(c.welcome).toBeDefined();
    const row = withDb(t.dataDir, (db) => db.get<{ last_ip: string | null }>('SELECT last_ip FROM users WHERE id = ?', c.identity.userId));
    expect(row).toEqual({ last_ip: null });
  });

  it('logs once at startup that proxy mode is on and which limits apply', async () => {
    const lines: string[] = [];
    const keep = (m: string) => void lines.push(m);
    const logger: Logger = { info: keep, warn: keep, error: keep };
    await server({ logger });
    const proxyLines = lines.filter((l) => /proxy mode/i.test(l));
    expect(proxyLines).toHaveLength(1);
    expect(proxyLines[0]).toContain('altaria.proxy.rlwy.net:25889');
    expect(proxyLines[0]).toMatch(/server-wide/);
    expect(proxyLines[0]).toMatch(/100 authentication failures per minute/);
    expect(proxyLines[0]).toMatch(/30 new members per hour/);
  });
});

describe('outside proxy mode the per-IP limits are unchanged', () => {
  it('still records last_ip', async () => {
    const t = await startTestServer({ joinMode: 'open' });
    servers.push(t);
    const c = await client(t);
    const row = withDb(t.dataDir, (db) => db.get<{ last_ip: string | null }>('SELECT last_ip FROM users WHERE id = ?', c.identity.userId));
    expect(row?.last_ip).toMatch(/127\.0\.0\.1/);
  });
});
