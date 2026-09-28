import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL, ProtocolError, toBase64Url } from '@ghostlink/shared';
import { countUsers } from '../../../server/test/helpers/db.js';
import { startTestServer, type TestServer } from '../../../server/test/helpers/testClient.js';
import type { AppError } from '../../src/shared/appErrors.js';
import type { ConnState } from '../../src/shared/ipcTypes.js';
import { ServerConnection, backoffDelay, errorCodeFromEvent, type ServerConnectionOptions } from '../../src/main/connection.js';
import { TEST_HELLO, countingServer, deadPort, randomKey, silentServer, stallingServer, waitFor } from '../helpers/net.js';

const servers: TestServer[] = [];
const connections: ServerConnection[] = [];
afterEach(async () => {
  for (const c of connections.splice(0)) c.close();
  await Promise.all(servers.splice(0).map((s) => s.cleanup()));
});

async function server(opts: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const t = await startTestServer({ joinMode: 'open', ...opts });
  servers.push(t);
  return t;
}

function connection(opts: Partial<ServerConnectionOptions> & Pick<ServerConnectionOptions, 'addresses' | 'serverKeyId'>) {
  const conn = new ServerConnection({ key: randomKey(), hello: TEST_HELLO, reconnect: false, ...opts });
  const states: ConnState[] = [];
  conn.on('state', (s: ConnState) => states.push(s));
  connections.push(conn);
  return { conn, states };
}

const local = (t: TestServer) => `127.0.0.1:${t.server.port}`;

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as AppError | ProtocolError).code;
  }
  throw new Error('expected a rejection');
}

describe('ServerConnection — pinned handshake (spec §3.3)', () => {
  it('connects with the right pin, proves the key and answers requests', async () => {
    const t = await server({ name: 'Casa' });
    const key = randomKey();
    const { conn, states } = connection({ addresses: [local(t)], serverKeyId: t.server.serverKeyId, key });
    const welcome = await conn.connect();
    expect(states).toEqual(['connecting', 'authenticating', 'connected']);
    expect(welcome.self.userId).toBe(createHash('sha256').update(key.publicKeyRaw).digest('hex').slice(0, 32));
    expect(welcome.self.nickname).toBe('Ana');
    expect(welcome.server).toMatchObject({ name: 'Casa', serverKeyId: t.server.serverKeyId });
    expect(conn.connectedAddress).toBe(local(t));
    expect(await conn.request<{ t: number }>('ping')).toEqual({ t: expect.any(Number) });
    conn.close();
    expect(conn.state).toBe('idle');
    expect(conn.connectedAddress).toBeNull();
  });

  it('refuses a server with another key before a single HTTP byte is sent', async () => {
    const t = await server();
    const decoy = await countingServer(t.dataDir); // presents t's certificate
    try {
      const wrongPin = toBase64Url(new Uint8Array(32).fill(7));
      const { conn } = connection({ addresses: [`127.0.0.1:${decoy.port}`], serverKeyId: wrongPin });
      expect(await codeOf(conn.connect())).toBe('PIN_MISMATCH');
      expect(conn.state).toBe('failed');
      await new Promise((r) => setTimeout(r, 100));
      expect(decoy.counts.connections).toBe(1); // it reached the server and read its certificate…
      expect(decoy.counts.requests + decoy.counts.upgrades).toBe(0); // …and nothing after it
    } finally {
      await decoy.close();
    }
  });

  it('never reaches the real server’s handshake with a wrong pin (no user is created)', async () => {
    const t = await server();
    const { conn } = connection({ addresses: [local(t)], serverKeyId: toBase64Url(new Uint8Array(32).fill(7)) });
    expect(await codeOf(conn.connect())).toBe('PIN_MISMATCH');
    expect(countUsers(t.dataDir)).toBe(0);
  });

  it('turns join-mode refusals into fatal ProtocolErrors without retrying', async () => {
    const t = await server({ joinMode: 'invite' });
    const key = randomKey();
    const { conn, states } = connection({ addresses: [local(t)], serverKeyId: t.server.serverKeyId, key, reconnect: true });
    const error = await conn.connect().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe('INVITE_REQUIRED');
    await new Promise((r) => setTimeout(r, 300));
    expect(states).toEqual(['connecting', 'authenticating', 'failed']);
    // The same identity enters with an invite, and later without one (members skip the check).
    const invited = connection({ addresses: [local(t)], serverKeyId: t.server.serverKeyId, key, hello: { ...TEST_HELLO, inviteCode: t.server.createInvite().code } });
    await invited.conn.connect();
    invited.conn.close();
    const member = connection({ addresses: [local(t)], serverKeyId: t.server.serverKeyId, key });
    expect((await member.conn.connect()).self.nickname).toBe('Ana');
  });

  it('passes the owner setup code through the hello', async () => {
    const t = await server();
    const { conn } = connection({ addresses: [local(t)], serverKeyId: t.server.serverKeyId, hello: { ...TEST_HELLO, setupCode: t.server.setupCode()! } });
    expect((await conn.connect()).self.isOwner).toBe(true);
  });

  it('maps server error responses to ProtocolError and refuses requests while not connected', async () => {
    const t = await server();
    const { conn } = connection({ addresses: [local(t)], serverKeyId: t.server.serverKeyId });
    expect(await codeOf(conn.request('ping'))).toBe('CONNECTION_LOST');
    await conn.connect();
    const error = await conn.request('msg.send', { channelId: 'x' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe('BAD_REQUEST');
  });

  it('gives up on a server that never answers the hello (TIMEOUT)', async () => {
    const t = await server();
    const stall = await stallingServer(t.dataDir);
    try {
      const { conn } = connection({ addresses: [`127.0.0.1:${stall.port}`], serverKeyId: t.server.serverKeyId, timing: { handshakeTimeoutMs: 300 } });
      expect(await codeOf(conn.connect())).toBe('TIMEOUT');
      expect(conn.state).toBe('failed');
    } finally {
      await stall.close();
    }
  });

  it('close() during the handshake stops it at once and stays idle', async () => {
    const t = await server();
    const stall = await stallingServer(t.dataDir);
    try {
      const { conn, states } = connection({ addresses: [`127.0.0.1:${stall.port}`], serverKeyId: t.server.serverKeyId });
      const pending = conn.connect();
      await waitFor(() => conn.state === 'authenticating');
      const started = Date.now();
      conn.close();
      expect(await codeOf(pending)).toBe('CONNECTION_LOST');
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(states).toEqual(['connecting', 'authenticating', 'idle']);
    } finally {
      await stall.close();
    }
  });

  it('rejects invalid options up front', () => {
    const key = randomKey();
    expect(() => new ServerConnection({ addresses: [], serverKeyId: toBase64Url(new Uint8Array(32)), key, hello: TEST_HELLO })).toThrow(ProtocolError);
    expect(() => new ServerConnection({ addresses: ['bad host'], serverKeyId: toBase64Url(new Uint8Array(32)), key, hello: TEST_HELLO })).toThrow(ProtocolError);
    expect(() => new ServerConnection({ addresses: ['10.0.0.1'], serverKeyId: 'short', key, hello: TEST_HELLO })).toThrow(ProtocolError);
  });
});

describe('ServerConnection — several routes to one server (spec §3.3)', () => {
  it('skips a dead address and uses the next one', async () => {
    const t = await server();
    const dead = `127.0.0.1:${await deadPort()}`;
    const { conn } = connection({ addresses: [dead, local(t)], serverKeyId: t.server.serverKeyId });
    await conn.connect();
    expect(conn.connectedAddress).toBe(local(t));
  });

  it('does not wait for a black-hole address: the next one starts after the stagger', async () => {
    const t = await server();
    const hole = await silentServer();
    try {
      const { conn } = connection({ addresses: [`127.0.0.1:${hole.port}`, local(t)], serverKeyId: t.server.serverKeyId });
      const started = Date.now();
      await conn.connect();
      expect(conn.connectedAddress).toBe(local(t));
      expect(Date.now() - started).toBeLessThan(2_000); // far below the 5 s per-address timeout
    } finally {
      await hole.close();
    }
  });

  it('prefers any address that passes the pin over one that does not', async () => {
    const t = await server();
    const impostor = await server(); // valid TLS, different key
    const { conn } = connection({ addresses: [local(impostor), local(t)], serverKeyId: t.server.serverKeyId });
    await conn.connect();
    expect(conn.connectedAddress).toBe(local(t));
  });

  it('reports UNREACHABLE when no address answers, and PIN_MISMATCH when only impostors do', async () => {
    const t = await server();
    const deadA = `127.0.0.1:${await deadPort()}`;
    const deadB = `127.0.0.1:${await deadPort()}`;
    expect(await codeOf(connection({ addresses: [deadA, deadB], serverKeyId: t.server.serverKeyId }).conn.connect())).toBe('UNREACHABLE');
    const pin = toBase64Url(new Uint8Array(32).fill(3));
    expect(await codeOf(connection({ addresses: [deadA, local(t)], serverKeyId: pin }).conn.connect())).toBe('PIN_MISMATCH');
  });

  it('times out a black hole after attemptTimeoutMs', async () => {
    const hole = await silentServer();
    try {
      const { conn } = connection({
        addresses: [`127.0.0.1:${hole.port}`],
        serverKeyId: toBase64Url(new Uint8Array(32)),
        timing: { attemptTimeoutMs: 300 },
      });
      const started = Date.now();
      expect(await codeOf(conn.connect())).toBe('UNREACHABLE');
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await hole.close();
    }
  });
});

describe('pure helpers', () => {
  it('backoffDelay grows from 1 s to 30 s with ±20 % jitter (spec §13)', () => {
    const at = (attempt: number, r: number) => backoffDelay(attempt, () => r);
    expect([0, 1, 2, 3, 4, 5, 10, 100].map((a) => at(a, 0.5))).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
    expect(at(1, 0)).toBe(1_600);
    expect(at(1, 1)).toBe(2_400);
    for (let attempt = 0; attempt < 12; attempt++) {
      for (const r of [0, 0.3, 0.999]) {
        const d = at(attempt, r);
        expect(d).toBeGreaterThanOrEqual(1_000);
        expect(d).toBeLessThanOrEqual(30_000);
      }
    }
  });

  it('errorCodeFromEvent tells an outdated server from an outdated app (spec §5.1)', () => {
    expect(errorCodeFromEvent({ code: 'PROTOCOL_UNSUPPORTED', min: 0, max: PROTOCOL.current - 1 })).toBe('SERVER_OUTDATED');
    expect(errorCodeFromEvent({ code: 'PROTOCOL_UNSUPPORTED', min: PROTOCOL.current + 1, max: PROTOCOL.current + 2 })).toBe('PROTOCOL_UNSUPPORTED');
    expect(errorCodeFromEvent({ code: 'PROTOCOL_UNSUPPORTED' })).toBe('PROTOCOL_UNSUPPORTED');
    expect(errorCodeFromEvent({ code: 'BANNED' })).toBe('BANNED');
  });
});
