import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { WelcomePayload } from '@ghostlink/shared';
import { silentLogger, startServer, type GhostServer } from '../../../server/src/index.js';
import { insertBan } from '../../../server/test/helpers/db.js';
import { startTestServer, type TestServer } from '../../../server/test/helpers/testClient.js';
import type { ConnState } from '../../src/shared/ipcTypes.js';
import { ServerConnection, type ServerConnectionOptions } from '../../src/main/connection.js';
import type { ServerKey } from '../../src/main/identity.js';
import { TEST_HELLO, nextEvent, randomKey, waitFor } from '../helpers/net.js';

// Fast, deterministic backoff: 50 ms, 100 ms, 200 ms…
const FAST = { backoffMinMs: 50, backoffMaxMs: 200 };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function server(opts: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const t = await startTestServer({ joinMode: 'open', ...opts });
  cleanups.push(() => t.cleanup());
  return t;
}

/** Starts the same server again (same data dir, so same key and members) on the same port. */
async function restart(t: TestServer): Promise<GhostServer> {
  await t.server.close();
  const again = await startServer({ dataDir: t.dataDir, port: t.server.port, host: '127.0.0.1', logger: silentLogger });
  cleanups.push(() => again.close());
  return again;
}

function connection(t: TestServer, opts: Partial<ServerConnectionOptions> = {}) {
  const conn = new ServerConnection({
    addresses: [`127.0.0.1:${t.server.port}`],
    serverKeyId: t.server.serverKeyId,
    key: randomKey(),
    hello: TEST_HELLO,
    reconnect: true,
    timing: FAST,
    random: () => 0.5,
    ...opts,
  });
  const states: ConnState[] = [];
  conn.on('state', (s: ConnState) => states.push(s));
  cleanups.push(() => conn.close());
  return { conn, states };
}

const userIdOf = (key: ServerKey) => createHash('sha256').update(key.publicKeyRaw).digest('hex').slice(0, 32);

describe('ServerConnection — reconnect (spec §13)', () => {
  it('comes back after the server restarts, with a fresh session and welcome', async () => {
    const t = await server();
    const { conn, states } = connection(t);
    const first = await conn.connect();
    const welcomeAgain = nextEvent<WelcomePayload>(conn, 'welcome');
    await restart(t);
    const second = await welcomeAgain;
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.self.userId).toBe(first.self.userId);
    expect(conn.state).toBe('connected');
    expect(states).toContain('reconnecting');
    expect(await conn.request('ping')).toEqual({ t: expect.any(Number) });
  });

  it('keeps retrying with backoff while the server is down', async () => {
    const t = await server();
    const { conn, states } = connection(t);
    await conn.connect();
    await t.server.close();
    await waitFor(() => conn.state === 'reconnecting');
    await new Promise((r) => setTimeout(r, 600)); // several failed attempts (50, 100, 200, 200 ms…)
    expect(conn.state).toBe('reconnecting');
    expect(states.filter((s) => s === 'failed')).toEqual([]);
    const back = nextEvent(conn, 'welcome');
    const again = await startServer({ dataDir: t.dataDir, port: t.server.port, host: '127.0.0.1', logger: silentLogger });
    cleanups.push(() => again.close());
    await back;
    expect(conn.state).toBe('connected');
  });

  it('stops for good on SESSION_REPLACED: the newer session keeps working', async () => {
    const t = await server();
    const key = randomKey();
    const a = connection(t, { key });
    await a.conn.connect();
    const fatal = nextEvent<{ code: string }>(a.conn, 'fatal');
    const b = connection(t, { key });
    await b.conn.connect();
    expect(await fatal).toEqual({ code: 'SESSION_REPLACED' });
    await new Promise((r) => setTimeout(r, 400)); // longer than any backoff: a retry would replace b
    expect(a.conn.state).toBe('failed');
    expect(a.states.at(-1)).toBe('failed');
    expect(await b.conn.request('ping')).toEqual({ t: expect.any(Number) });
  });

  it('stops for good when the reconnect is refused with BANNED', async () => {
    const t = await server();
    const key = randomKey();
    const { conn } = connection(t, { key });
    await conn.connect();
    insertBan(t.dataDir, { userId: userIdOf(key) });
    const fatal = nextEvent<{ code: string }>(conn, 'fatal');
    await restart(t);
    expect(await fatal).toEqual({ code: 'BANNED' });
    expect(conn.state).toBe('failed');
  });

  it('notices a silent server (no pings) and reconnects', async () => {
    const t = await server({ limits: { pingIntervalMs: 60_000 } });
    const { conn, states } = connection(t, { timing: { ...FAST, idleTimeoutMs: 300 } });
    const first = await conn.connect();
    const again = await nextEvent<WelcomePayload>(conn, 'welcome');
    expect(again.sessionId).not.toBe(first.sessionId);
    expect(states).toContain('reconnecting');
  });

  it('close() cancels reconnecting for good', async () => {
    const t = await server();
    const { conn } = connection(t);
    await conn.connect();
    await t.server.close();
    await waitFor(() => conn.state === 'reconnecting');
    conn.close();
    let welcomed = false;
    conn.on('welcome', () => {
      welcomed = true;
    });
    const again = await startServer({ dataDir: t.dataDir, port: t.server.port, host: '127.0.0.1', logger: silentLogger });
    cleanups.push(() => again.close());
    await new Promise((r) => setTimeout(r, 500));
    expect(conn.state).toBe('idle');
    expect(welcomed).toBe(false);
  });

  it('without reconnect, a server shutdown ends the connection with its code', async () => {
    const t = await server();
    const { conn } = connection(t, { reconnect: false });
    await conn.connect();
    const fatal = nextEvent<{ code: string }>(conn, 'fatal');
    await t.server.close();
    expect(await fatal).toEqual({ code: 'SERVER_SHUTDOWN' });
    expect(conn.state).toBe('failed');
  });
});
