import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL, buildAuthMessage, toBase64Url, type HelloPayload } from '@ghostlink/shared';
import { SERVER_VERSION } from '../../src/index.js';
import { getUser } from '../helpers/db.js';
import {
  connectRaw,
  connectTestClient,
  makeIdentity,
  startTestServer,
  type RawClient,
  type TestIdentity,
  type TestServer,
} from '../helpers/testClient.js';

const servers: TestServer[] = [];
async function server(opts: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const t = await startTestServer({ joinMode: 'open', ...opts });
  servers.push(t);
  return t;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.cleanup()));
});

function hello(identity: TestIdentity, overrides: Partial<HelloPayload> = {}): { t: 'hello'; d: HelloPayload } {
  return {
    t: 'hello',
    d: { protocol: PROTOCOL.current, publicKey: identity.publicKey, nickname: 'Ana', locale: 'pt-BR', client: 'test', ...overrides },
  };
}

function proof(identity: TestIdentity, serverKeyId: string, nonce: string) {
  return { t: 'auth.proof', d: { signature: toBase64Url(identity.sign(buildAuthMessage(serverKeyId, nonce))) } };
}

async function expectRefused(raw: RawClient, code: string, timeoutMs = 5_000): Promise<void> {
  const message = await raw.next(timeoutMs);
  expect(message).toMatchObject({ t: 'error', d: { code } });
  expect(await raw.closed).toEqual({ code: 4000, reason: code });
}

describe('successful handshake', () => {
  it('returns a complete welcome and stores the member', async () => {
    const t = await server({ name: 'Servidor' });
    const c = await connectTestClient(t.server, { nickname: '  Ana‮  ', locale: 'en-US' });
    expect(c.error).toBeUndefined();
    const w = c.welcome!;
    expect(w.self).toEqual({ userId: c.identity.userId, nickname: 'Ana', isOwner: false });
    expect(w.server).toEqual({ name: 'Servidor', version: SERVER_VERSION, joinMode: 'open', serverKeyId: t.server.serverKeyId });
    expect(w.protocol).toEqual({ min: PROTOCOL.min, max: PROTOCOL.max });
    expect(w.features).toEqual([]);
    expect(w.fileToken).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256 bits
    expect(w.sessionId).toMatch(/^[A-Za-z0-9_-]{22}$/); // 128 bits
    expect(Math.abs(w.serverTime - Date.now())).toBeLessThan(5_000);
    const user = getUser(t.dataDir, c.identity.userId)!;
    expect(user).toMatchObject({ nickname: 'Ana', nickname_norm: 'ana', locale: 'en-US', last_ip: '127.0.0.1', removed_at: null });
    expect(Buffer.from(user.public_key as Uint8Array).equals(Buffer.from(c.identity.publicKeyRaw))).toBe(true);
    c.close();
  });

  it('gives every session fresh sessionId and fileToken', async () => {
    const t = await server();
    const seed = new Uint8Array(32).fill(7);
    const a = await connectTestClient(t.server, { seed });
    const b = await connectTestClient(t.server, { seed });
    expect(b.welcome!.sessionId).not.toBe(a.welcome!.sessionId);
    expect(b.welcome!.fileToken).not.toBe(a.welcome!.fileToken);
    b.close();
  });

  it('answers ping after authentication with the injected clock', async () => {
    const t = await server({ now: () => 1_234_567 });
    const c = await connectTestClient(t.server);
    expect(await c.request('ping', {})).toEqual({ t: 'res', id: 1, ok: true, d: { t: 1_234_567 } });
    c.close();
  });
});

describe('protocol negotiation', () => {
  it.each([PROTOCOL.max + 1, PROTOCOL.min - 1])('refuses protocol %i with PROTOCOL_UNSUPPORTED and the accepted range', async (protocol) => {
    const t = await server();
    const c = await connectTestClient(t.server, { protocol });
    expect(c.error).toEqual({ code: 'PROTOCOL_UNSUPPORTED', min: PROTOCOL.min, max: PROTOCOL.max });
  });
});

describe('malformed handshakes → BAD_REQUEST', () => {
  it.each([
    ['a request before hello', { t: 'ping', id: 1, d: {} }],
    ['hello with unknown key', { t: 'hello', d: { ...hello(makeIdentity()).d, admin: true } }],
    ['hello without payload', { t: 'hello' }],
    ['hello with 31-byte key', hello(makeIdentity(), { publicKey: toBase64Url(new Uint8Array(31)) })],
    ['hello with the small-order all-zero key', hello(makeIdentity(), { publicKey: toBase64Url(new Uint8Array(32)) })],
    ['hello with an invisible nickname', hello(makeIdentity(), { nickname: '​ㅤ' })],
    ['hello with a 33-grapheme nickname', hello(makeIdentity(), { nickname: 'a'.repeat(33) })],
  ])('%s', async (_label, message) => {
    const t = await server();
    const raw = await connectRaw(t.server);
    raw.send(message);
    await expectRefused(raw, 'BAD_REQUEST');
  });

  it('invalid JSON', async () => {
    const t = await server();
    const raw = await connectRaw(t.server);
    raw.ws.send('{not json');
    await expectRefused(raw, 'BAD_REQUEST');
  });

  it('binary frame', async () => {
    const t = await server();
    const raw = await connectRaw(t.server);
    raw.ws.send(Buffer.from(JSON.stringify(hello(makeIdentity()))), { binary: true });
    await expectRefused(raw, 'BAD_REQUEST');
  });

  it('a second hello instead of auth.proof', async () => {
    const t = await server();
    const id = makeIdentity();
    const raw = await connectRaw(t.server);
    raw.send(hello(id));
    expect((await raw.next()).t).toBe('challenge');
    raw.send(hello(id));
    await expectRefused(raw, 'BAD_REQUEST');
  });

  it('auth.proof with a malformed signature', async () => {
    const t = await server();
    const raw = await connectRaw(t.server);
    raw.send(hello(makeIdentity()));
    await raw.next();
    raw.send({ t: 'auth.proof', d: { signature: 'short' } });
    await expectRefused(raw, 'BAD_REQUEST');
  });
});

describe('proof of possession (spec §3.3)', () => {
  it('sends a 32-byte single-use nonce and the real serverKeyId', async () => {
    const t = await server();
    const raw = await connectRaw(t.server);
    raw.send(hello(makeIdentity()));
    const challenge = await raw.next();
    expect(challenge).toMatchObject({ t: 'challenge', d: { serverKeyId: t.server.serverKeyId } });
    expect((challenge.d as { nonce: string }).nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    raw.close();
  });

  it('rejects a signature made with a different key → BAD_SIGNATURE', async () => {
    const t = await server();
    const claimed = makeIdentity();
    const actual = makeIdentity();
    const raw = await connectRaw(t.server);
    raw.send(hello(claimed));
    const { nonce } = (await raw.next()).d as { nonce: string };
    raw.send(proof(actual, t.server.serverKeyId, nonce));
    await expectRefused(raw, 'BAD_SIGNATURE');
  });

  it('binds the signature to the serverKeyId: a proof made for another server is rejected', async () => {
    const t = await server();
    const other = await server();
    const id = makeIdentity();
    const raw = await connectRaw(t.server);
    raw.send(hello(id));
    const { nonce } = (await raw.next()).d as { nonce: string };
    raw.send(proof(id, other.server.serverKeyId, nonce)); // what a malicious relay would forward
    await expectRefused(raw, 'BAD_SIGNATURE');
  });

  it('a captured proof cannot be replayed on a new connection (fresh nonce)', async () => {
    const t = await server();
    const id = makeIdentity();
    const first = await connectRaw(t.server);
    first.send(hello(id));
    const { nonce } = (await first.next()).d as { nonce: string };
    const captured = proof(id, t.server.serverKeyId, nonce);
    first.close();

    const second = await connectRaw(t.server);
    second.send(hello(id));
    const fresh = (await second.next()).d as { nonce: string };
    expect(fresh.nonce).not.toBe(nonce);
    second.send(captured);
    await expectRefused(second, 'BAD_SIGNATURE');
  });

  it('rejects an expired challenge (injectable clock) → CHALLENGE_EXPIRED', async () => {
    const clock = { t: Date.now() };
    const t = await server({ now: () => clock.t });
    const id = makeIdentity();
    const raw = await connectRaw(t.server);
    raw.send(hello(id));
    const { nonce } = (await raw.next()).d as { nonce: string };
    clock.t += 30_001;
    raw.send(proof(id, t.server.serverKeyId, nonce));
    await expectRefused(raw, 'CHALLENGE_EXPIRED');
  });

  it('accepts a proof right at the TTL boundary', async () => {
    const clock = { t: Date.now() };
    const t = await server({ now: () => clock.t });
    const id = makeIdentity();
    const raw = await connectRaw(t.server);
    raw.send(hello(id));
    const { nonce } = (await raw.next()).d as { nonce: string };
    clock.t += 30_000;
    raw.send(proof(id, t.server.serverKeyId, nonce));
    expect((await raw.next()).t).toBe('welcome');
    raw.close();
  });
});

describe('pre-auth deadlines', () => {
  it('closes a connection that never says hello', async () => {
    const t = await server({ limits: { helloTimeoutMs: 150 } });
    const raw = await connectRaw(t.server);
    await expectRefused(raw, 'BAD_REQUEST');
  });

  it('closes a connection that never sends auth.proof → CHALLENGE_EXPIRED', async () => {
    const t = await server({ limits: { proofTimeoutMs: 150 } });
    const raw = await connectRaw(t.server);
    raw.send(hello(makeIdentity()));
    expect((await raw.next()).t).toBe('challenge');
    await expectRefused(raw, 'CHALLENGE_EXPIRED');
  });

  it('uses the real 5 s hello deadline by default', async () => {
    const t = await server();
    const raw = await connectRaw(t.server);
    const started = Date.now();
    await expectRefused(raw, 'BAD_REQUEST', 8_000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_900);
    expect(Date.now() - started).toBeLessThan(8_000);
  }, 15_000);
});

describe('framing limits', () => {
  it('drops frames over maxPayload (256 KiB) with close code 1009', async () => {
    const t = await server();
    const raw = await connectRaw(t.server);
    raw.ws.send(JSON.stringify({ t: 'hello', d: { pad: 'x'.repeat(256 * 1024) } }));
    expect((await raw.closed).code).toBe(1009);
  });
});

describe('after authentication', () => {
  it('answers unknown request types with BAD_REQUEST and keeps the session', async () => {
    const t = await server();
    const c = await connectTestClient(t.server);
    expect(await c.request('msg.send', { channelId: 'x' })).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(await c.request('ping')).toMatchObject({ ok: true });
    c.close();
  });

  it('ignores envelopes without id', async () => {
    const t = await server();
    const c = await connectTestClient(t.server);
    c.raw.send({ t: 'ping', d: {} });
    expect(await c.request('ping')).toMatchObject({ id: 1, ok: true });
    c.close();
  });

  it('closes the session on an invalid frame', async () => {
    const t = await server();
    const c = await connectTestClient(t.server);
    c.raw.ws.send('garbage');
    expect(await c.waitEvent('error')).toEqual({ t: 'error', d: { code: 'BAD_REQUEST' } });
    expect((await c.raw.closed).reason).toBe('BAD_REQUEST');
  });

  it('limits requests to 30 per second per session', async () => {
    const t = await server({ now: () => 5_000 }); // frozen clock: all requests fall in one window
    const c = await connectTestClient(t.server);
    const results = await Promise.all(Array.from({ length: 31 }, () => c.request('ping')));
    expect(results.filter((r) => r.ok)).toHaveLength(30);
    expect(results.filter((r) => !r.ok)).toEqual([expect.objectContaining({ error: expect.objectContaining({ code: 'RATE_LIMITED' }) })]);
    c.close();
  });
});
