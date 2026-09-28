import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL, buildAuthMessage, toBase64Url } from '@ghostlink/shared';
import {
  connectRaw,
  connectTestClient,
  makeIdentity,
  startTestServer,
  type RawClient,
  type TestServer,
} from '../helpers/testClient.js';

const servers: TestServer[] = [];
const sockets: RawClient[] = [];
async function server(opts: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const t = await startTestServer({ joinMode: 'open', ...opts });
  servers.push(t);
  return t;
}
async function raw(t: TestServer): Promise<RawClient> {
  const r = await connectRaw(t.server);
  sockets.push(r);
  return r;
}
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await Promise.all(servers.splice(0).map((s) => s.cleanup()));
});

async function failOnce(t: TestServer): Promise<void> {
  const id = makeIdentity();
  const r = await raw(t);
  r.send({ t: 'hello', d: { protocol: PROTOCOL.current, publicKey: id.publicKey, nickname: 'x', locale: 'en', client: 't' } });
  const { nonce } = (await r.next()).d as { nonce: string };
  const wrong = makeIdentity();
  r.send({ t: 'auth.proof', d: { signature: toBase64Url(wrong.sign(buildAuthMessage(t.server.serverKeyId, nonce))) } });
  expect(await r.next()).toMatchObject({ t: 'error', d: { code: 'BAD_SIGNATURE' } });
}

describe('pre-auth connection limits (spec §13)', () => {
  it('allows 20 unauthenticated connections per IP and refuses the 21st with RATE_LIMITED', async () => {
    const t = await server();
    const open = await Promise.all(Array.from({ length: 20 }, () => raw(t)));
    const extra = await raw(t);
    expect(await extra.next()).toEqual({ t: 'error', d: { code: 'RATE_LIMITED' } });
    open[0]!.close();
    await open[0]!.closed;
    // The server frees the slot when it sees the close; poll briefly instead of guessing a delay.
    let reply = '';
    for (let attempt = 0; attempt < 40 && reply !== 'challenge'; attempt++) {
      const again = await raw(t);
      again.send({ t: 'hello', d: { protocol: 1, publicKey: makeIdentity().publicKey, nickname: `n${attempt}`, locale: 'en', client: 't' } });
      const m = await again.next();
      reply = m.t === 'error' ? (m.d as { code: string }).code : m.t;
      if (reply !== 'challenge') {
        expect(reply).toBe('RATE_LIMITED');
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    expect(reply).toBe('challenge');
  });

  it('authenticated sessions do not count toward the unauthenticated per-IP limit', async () => {
    const t = await server({ limits: { maxConnectionsPerIp: 2 } });
    const a = await connectTestClient(t.server);
    const b = await connectTestClient(t.server);
    expect(a.welcome && b.welcome).toBeTruthy();
    const c = await connectTestClient(t.server);
    expect(c.welcome).toBeDefined();
    for (const x of [a, b, c]) x.close();
  });

  it('caps unauthenticated connections globally', async () => {
    const t = await server({ limits: { maxUnauthenticatedConnections: 3, maxConnectionsPerIp: 100 } });
    await Promise.all([raw(t), raw(t), raw(t)]);
    const extra = await raw(t);
    expect(await extra.next()).toEqual({ t: 'error', d: { code: 'RATE_LIMITED' } });
  });

  it('limits pending challenges per IP to 5', async () => {
    const t = await server();
    for (let i = 0; i < 5; i++) {
      const r = await raw(t);
      r.send({ t: 'hello', d: { protocol: 1, publicKey: makeIdentity().publicKey, nickname: `n${i}`, locale: 'en', client: 't' } });
      expect((await r.next()).t).toBe('challenge');
    }
    const sixth = await raw(t);
    sixth.send({ t: 'hello', d: { protocol: 1, publicKey: makeIdentity().publicKey, nickname: 'n6', locale: 'en', client: 't' } });
    expect(await sixth.next()).toEqual({ t: 'error', d: { code: 'RATE_LIMITED' } });
  });
});

describe('authentication failure limit (10/min per IP, failures only)', () => {
  it('successes never count', async () => {
    const t = await server();
    const seed = new Uint8Array(32).fill(1);
    for (let i = 0; i < 15; i++) {
      const c = await connectTestClient(t.server, { seed });
      expect(c.welcome, `login ${i}`).toBeDefined();
      c.close();
    }
  });

  it('PROTOCOL_UNSUPPORTED is not a credential failure', async () => {
    const t = await server();
    for (let i = 0; i < 12; i++) expect((await connectTestClient(t.server, { protocol: 99 })).error?.code).toBe('PROTOCOL_UNSUPPORTED');
    expect((await connectTestClient(t.server)).welcome).toBeDefined();
  });

  it('after 10 failures even valid credentials get RATE_LIMITED until the minute passes', async () => {
    const clock = { t: Date.now() };
    const t = await server({ now: () => clock.t });
    for (let i = 0; i < 10; i++) await failOnce(t);
    expect((await connectTestClient(t.server)).error?.code).toBe('RATE_LIMITED');
    clock.t += 60_001;
    expect((await connectTestClient(t.server)).welcome).toBeDefined();
  });

  it('counts wrong invites, so invite codes cannot be brute-forced', async () => {
    const t = await server({ joinMode: 'invite' });
    for (let i = 0; i < 10; i++) {
      expect((await connectTestClient(t.server, { inviteCode: `AAAAAAAAA${'234567ABCD'[i]}` })).error?.code).toBe('INVITE_INVALID');
    }
    const real = t.server.createInvite().code;
    expect((await connectTestClient(t.server, { inviteCode: real })).error?.code).toBe('RATE_LIMITED');
  });
});

describe('heartbeat (spec §5.1)', () => {
  it('drops a peer that stops answering pings', async () => {
    const t = await server({ limits: { pingIntervalMs: 50, pongTimeoutMs: 300 } });
    const silent = await connectRaw(t.server, { autoPong: false });
    sockets.push(silent);
    const started = Date.now();
    const { code } = await silent.closed;
    expect(code).toBe(1006); // terminated, no close frame
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('keeps a responsive peer connected', async () => {
    const t = await server({ limits: { pingIntervalMs: 100, pongTimeoutMs: 1_000 } });
    const c = await connectTestClient(t.server);
    await new Promise((r) => setTimeout(r, 1_300)); // several ping/pong rounds, longer than pongTimeoutMs

    expect(await c.request('ping')).toMatchObject({ ok: true });
    c.close();
  });
});
