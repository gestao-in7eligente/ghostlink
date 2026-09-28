import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { silentLogger, startServer, type ModuleContext, type ServerModule } from '../../src/index.js';
import type { Logger } from '../../src/logger.js';
import { connectRaw, connectTestClient, startTestServer, type TestClient, type TestServer } from '../helpers/testClient.js';

const servers: TestServer[] = [];
const clients: TestClient[] = [];
const dirs: string[] = [];
async function server(opts: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const t = await startTestServer({ joinMode: 'open', ...opts });
  servers.push(t);
  return t;
}
async function client(t: TestServer, opts: Parameters<typeof connectTestClient>[1] = {}): Promise<TestClient> {
  const c = await connectTestClient(t.server, opts);
  clients.push(c);
  return c;
}
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ghostlink-mod-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await Promise.all(servers.splice(0).map((s) => s.cleanup()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, rejectUnauthorized: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }).on('error', reject).end();
  });
}

const echoSchema = z.strictObject({ text: z.string().max(100) });
const toSchema = z.strictObject({ to: z.array(z.string()).max(10) });
const userSchema = z.strictObject({ userId: z.string().max(64) });

/** A module that uses every seam and records what happens to it in `log`. */
function probe(name: string, log: string[], overrides: Partial<ServerModule> = {}) {
  let ctx: ModuleContext | undefined;
  let release: () => void = () => {};
  const wss = new WebSocketServer({ noServer: true });
  const module: ServerModule = {
    name,
    features: [`${name}-feature`],
    init: (c) => {
      ctx = c;
      log.push(`init:${name}`);
    },
    start: async ({ port }) => {
      log.push(`start:${name}:${port}`);
    },
    stop: async () => {
      log.push(`stop:${name}`);
      wss.close();
    },
    handlers: {
      [`${name}.echo`]: (c, payload) => ({ text: echoSchema.parse(payload).text, userId: c.userId, sessionId: c.sessionId, now: c.now() }),
      [`${name}.secret`]: (c, payload) => {
        const { to } = toSchema.parse(payload);
        const sent = c.sessions.broadcast({ t: `${name}.secret`, d: { from: c.userId } }, (s) => to.includes(s.userId));
        c.sessions.broadcast({ t: `${name}.after` });
        return { sent };
      },
      [`${name}.kick`]: (c, payload) => ({ closed: c.sessions.closeUser(userSchema.parse(payload).userId, 'KICKED') }),
      [`${name}.wait`]: async (c) => {
        log.push('waiting');
        await new Promise<void>((r) => (release = r));
        log.push(`current:${c.isCurrent()}`);
        return {};
      },
    },
    welcome: (s) => ({ [name]: { hello: s.userId } }),
    onSessionOpened: (s) => {
      log.push(`opened:${name}:${s.userId}`);
      ctx!.sessions.send(s.sessionId, { t: `${name}.opened` });
    },
    onSessionClosed: (s, i) => log.push(`closed:${name}:${s.userId}:${i.reason}:${i.graceExpired}`),
    http: (req, res) => {
      if (req.url?.split('?')[0] !== `/${name}`) return false;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`${name}:${req.method}`);
      return true;
    },
    upgrade: (req, socket, head) => {
      if (req.url !== `/${name}-ws`) return false;
      wss.handleUpgrade(req, socket, head, (ws) => ws.send(JSON.stringify({ t: `${name}.ws` })));
      return true;
    },
    ...overrides,
  };
  return { module, context: () => ctx!, release: () => release() };
}

describe('server modules through the real server', () => {
  it('serves module requests, welcome fields, features, HTTP routes and upgrades', async () => {
    const log: string[] = [];
    const p = probe('probe', log);
    const t = await server({ modules: [p.module] });
    const c = await client(t);
    const userId = c.identity.userId;

    // Welcome: M1 fields intact, plus the module's per-session field and feature.
    expect(c.welcome).toMatchObject({ self: { userId }, features: ['probe-feature'] });
    expect(c.rawWelcome?.probe).toEqual({ hello: userId });
    // onSessionOpened runs after the welcome (connectTestClient requires the welcome first).
    expect(await c.waitEvent('probe.opened')).toEqual({ t: 'probe.opened' });

    expect(await c.request('probe.echo', { text: 'oi' })).toMatchObject({
      ok: true,
      d: { text: 'oi', userId, sessionId: c.welcome!.sessionId },
    });
    expect(await c.request('probe.echo', { text: 'oi', extra: 1 })).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(await c.request('ping')).toMatchObject({ ok: true }); // the core module is still there
    expect(await c.request('nope.nope')).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });

    expect(await get(t.server.port, '/probe?x=1')).toEqual({ status: 200, body: 'probe:GET' });
    expect((await get(t.server.port, '/health')).body).toMatch(/"ok":true/); // built-ins come first
    expect(await get(t.server.port, '/other')).toEqual({ status: 404, body: '' });

    const ws = await connectRaw(t.server, { path: '/probe-ws' });
    expect(await ws.next()).toEqual({ t: 'probe.ws' });
    ws.close();
    await expect(connectRaw(t.server, { path: '/other-ws' })).rejects.toThrow();
  });

  it('runs init before listen, start with the bound port, and stops in reverse order after the sessions end', async () => {
    const log: string[] = [];
    const t = await startTestServer({ joinMode: 'open', modules: [probe('a', log).module, probe('b', log).module] });
    const c = await connectTestClient(t.server);
    const userId = c.identity.userId;
    await t.cleanup();
    const port = t.server.port;
    expect(log).toEqual([
      'init:a',
      'init:b',
      `start:a:${port}`,
      `start:b:${port}`,
      `opened:a:${userId}`,
      `opened:b:${userId}`,
      `closed:a:${userId}:SERVER_SHUTDOWN:false`,
      `closed:b:${userId}:SERVER_SHUTDOWN:false`,
      'stop:b',
      'stop:a',
    ]);
  });

  it('merges welcome fields of several modules', async () => {
    const t = await server({ modules: [probe('a', []).module, probe('b', []).module] });
    const c = await client(t);
    expect(c.rawWelcome).toMatchObject({ a: { hello: c.identity.userId }, b: { hello: c.identity.userId } });
    expect(c.welcome?.features).toEqual(['a-feature', 'b-feature']);
  });
});

describe('startup validation', () => {
  it('refuses a request type registered twice before touching the data dir', async () => {
    const dataDir = join(tmpdir(), `ghostlink-never-${process.pid}-${Date.now()}`);
    const twice = [probe('a', []).module, { name: 'b', handlers: { 'a.echo': () => ({}) } }];
    await expect(startServer({ dataDir, port: 0, host: '127.0.0.1', logger: silentLogger, modules: twice }))
      .rejects.toThrow('request type "a.echo" is registered by both module "a" and module "b"');
    await expect(startServer({ dataDir, port: 0, host: '127.0.0.1', logger: silentLogger, modules: [{ name: 'x', handlers: { ping: () => ({}) } }] }))
      .rejects.toThrow(/"ping".*"core".*"x"/);
    await expect(startServer({ dataDir, port: 0, host: '127.0.0.1', logger: silentLogger, modules: [{ name: 'core' }] }))
      .rejects.toThrow(/duplicate module name "core"/);
    expect(existsSync(dataDir)).toBe(false);
  });

  it('an init failure aborts startup, stops the modules that initialized and releases the data dir', async () => {
    const log: string[] = [];
    const dataDir = tempDir();
    const failing = probe('b', log, {
      init: () => {
        throw new Error('b broke');
      },
    });
    const modules = [probe('a', log).module, failing.module, probe('c', log).module];
    await expect(startServer({ dataDir, port: 0, host: '127.0.0.1', logger: silentLogger, modules })).rejects.toThrow('b broke');
    expect(log).toEqual(['init:a', 'stop:a']);
    const retry = await startServer({ dataDir, port: 0, host: '127.0.0.1', logger: silentLogger });
    await retry.close();
  });

  it('a start failure closes the server and stops every initialized module in reverse order', async () => {
    const log: string[] = [];
    const dataDir = tempDir();
    const failing = probe('b', log, {
      start: async () => {
        throw new Error('no livekit');
      },
    });
    const modules = [probe('a', log).module, failing.module];
    await expect(startServer({ dataDir, port: 0, host: '127.0.0.1', logger: silentLogger, modules })).rejects.toThrow('no livekit');
    expect(log.filter((l) => !l.startsWith('start:'))).toEqual(['init:a', 'init:b', 'stop:b', 'stop:a']);
    const retry = await startServer({ dataDir, port: 0, host: '127.0.0.1', logger: silentLogger });
    await retry.close();
  });

  it.each([
    ['an M1 key', [{ name: 'bad', welcome: () => ({ server: 'mine' }) }], /may not set the M1 welcome key "server"/],
    ['a key of another module', [{ name: 'a', welcome: () => ({ k: 1 }) }, { name: 'b', welcome: () => ({ k: 2 }) }], /welcome key "k" is set by both/],
  ])('a welcome with %s closes the session with INTERNAL and logs why', async (_label, modules, why) => {
    const logger = { info: vi.fn<Logger['info']>(), warn: vi.fn<Logger['warn']>(), error: vi.fn<Logger['error']>() };
    const t = await server({ modules, logger });
    const c = await client(t);
    expect(c.welcome).toBeUndefined();
    expect(c.error).toEqual({ code: 'INTERNAL' });
    expect(logger.error).toHaveBeenCalledWith('welcome failed', { error: expect.stringMatching(why) });
  });
});

describe('sessions API', () => {
  it('broadcast delivers only to the recipients the filter accepts', async () => {
    const t = await server({ modules: [probe('p', []).module] });
    const [a, b, c] = [await client(t), await client(t), await client(t)];
    const seenByC: string[] = [];
    c.raw.ws.on('message', (data) => seenByC.push((JSON.parse(data.toString()) as { t: string }).t));

    expect(await a.request('p.secret', { to: [b.identity.userId] })).toMatchObject({ ok: true, d: { sent: 1 } });
    expect(await b.waitEvent('p.secret')).toEqual({ t: 'p.secret', d: { from: a.identity.userId } });
    await c.waitEvent('p.after'); // sent right after the filtered event, on the same ordered socket
    expect(seenByC).toContain('p.after');
    expect(seenByC).not.toContain('p.secret');
    await a.waitEvent('p.after');
  });

  it('onSessionClosed fires at once, then with graceExpired after the presence grace', async () => {
    const log: string[] = [];
    const p = probe('p', log);
    const t = await server({ modules: [p.module], limits: { presenceGraceMs: 400 } });
    const c = await client(t);
    const userId = c.identity.userId;
    c.close();
    await vi.waitFor(() => expect(log).toContain(`closed:p:${userId}:disconnected:false`), { interval: 5 });
    expect(p.context().sessions.isOnlineOrInGrace(userId)).toBe(true);
    expect(p.context().sessions.list()).toEqual([]);
    await vi.waitFor(() => expect(log).toContain(`closed:p:${userId}:disconnected:true`), { timeout: 3_000, interval: 10 });
    expect(p.context().sessions.isOnlineOrInGrace(userId)).toBe(false);
  });

  it('a reconnect within the grace keeps the user online without graceExpired', async () => {
    const log: string[] = [];
    const p = probe('p', log);
    const t = await server({ modules: [p.module], limits: { presenceGraceMs: 10_000 } });
    const seed = new Uint8Array(32).fill(7);
    const first = await client(t, { seed });
    const userId = first.identity.userId;
    first.close();
    await vi.waitFor(() => expect(log).toContain(`closed:p:${userId}:disconnected:false`), { interval: 5 });
    await client(t, { seed });
    expect(log.filter((l) => l.startsWith('opened:'))).toHaveLength(2);
    expect(p.context().sessions.isOnlineOrInGrace(userId)).toBe(true);
    expect(log.some((l) => l.endsWith(':true'))).toBe(false);
  });

  it('closeUser ends the session with the code and skips the grace', async () => {
    const log: string[] = [];
    const p = probe('p', log);
    const t = await server({ modules: [p.module], limits: { presenceGraceMs: 10_000 } });
    const [mod, target] = [await client(t), await client(t)];
    const targetId = target.identity.userId;
    expect(await mod.request('p.kick', { userId: targetId })).toMatchObject({ ok: true, d: { closed: true } });
    // Both hooks already ran synchronously inside closeUser().
    expect(log.filter((l) => l.startsWith('closed:'))).toEqual([`closed:p:${targetId}:KICKED:false`, `closed:p:${targetId}:KICKED:true`]);
    expect(p.context().sessions.isOnlineOrInGrace(targetId)).toBe(false);
    expect(await target.waitEvent('error')).toEqual({ t: 'error', d: { code: 'KICKED' } });
    expect(await target.raw.closed).toEqual({ code: 4000, reason: 'KICKED' });
    expect(await mod.request('p.kick', { userId: targetId })).toMatchObject({ ok: true, d: { closed: false } });
  });

  it('a replaced session ends with SESSION_REPLACED and no grace; handlers see isCurrent() turn false', async () => {
    const log: string[] = [];
    const p = probe('p', log);
    const t = await server({ modules: [p.module], limits: { presenceGraceMs: 50 } });
    const seed = new Uint8Array(32).fill(9);
    const first = await client(t, { seed });
    const userId = first.identity.userId;
    const pending = first.request('p.wait').catch(() => null); // never answered: the session is gone
    await vi.waitFor(() => expect(log).toContain('waiting'), { interval: 5 });
    await client(t, { seed });
    await vi.waitFor(() => expect(log).toContain(`closed:p:${userId}:SESSION_REPLACED:false`), { interval: 5 });
    p.release();
    await vi.waitFor(() => expect(log).toContain('current:false'), { interval: 5 });
    await new Promise((r) => setTimeout(r, 200)); // well past the 50 ms grace
    expect(log.some((l) => l.endsWith(':true'))).toBe(false);
    expect(p.context().sessions.isOnlineOrInGrace(userId)).toBe(true);
    void pending;
  });
});
