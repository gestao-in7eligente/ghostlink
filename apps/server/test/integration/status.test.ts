// Servers follow the app's version, §2: status.json for the VPS updater and the owner's
// signed GET /owner/status for the app that updates a Railway server.
import { randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { request } from 'node:https';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildOwnerStatusMessage, ownerStatusPath, type ResErr, type ResOk } from '@ghostlink/shared';
import type { Logger } from '../../src/logger.js';
import { createStatusModule, STATUS_FILE, type StatusFile } from '../../src/status/index.js';
import { SERVER_VERSION } from '../../src/version.js';
import { createVoiceModule, type VoiceModule } from '../../src/voice/index.js';
import { connectTestClient, startTestServer, type TestClient, type TestServer } from '../helpers/testClient.js';
import { FakeBackend, StubText } from '../helpers/voice.js';

const servers: TestServer[] = [];
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await Promise.all(servers.splice(0).map((s) => s.cleanup()));
});

interface Setup {
  t: TestServer;
  text: StubText;
  voice: VoiceModule | null;
  backend: FakeBackend | null;
  logs: string[];
  client(o?: { setupCode?: string; nickname?: string }): Promise<TestClient>;
  /** The owner, who joined with the setup code. */
  owner(): Promise<TestClient>;
}

async function setup(o: { voice?: boolean; refreshMs?: number } = {}): Promise<Setup> {
  const text = new StubText();
  text.channels.set('VC1', { type: 'voice', userLimit: 0 });
  const backend = o.voice === false ? null : new FakeBackend();
  const voice = backend ? createVoiceModule({ backend: () => backend, sweepIntervalMs: 3_600_000, reconcileIntervalMs: 3_600_000 }) : null;
  const logs: string[] = [];
  const logger: Logger = {
    info: (m, meta) => logs.push(`${m} ${JSON.stringify(meta ?? {})}`),
    warn: (m, meta) => logs.push(`${m} ${JSON.stringify(meta ?? {})}`),
    error: (m, meta) => logs.push(`${m} ${JSON.stringify(meta ?? {})}`),
  };
  const status = createStatusModule({ refreshMs: o.refreshMs ?? 3_600_000 });
  const t = await startTestServer({ joinMode: 'open', modules: voice ? [text, voice, status] : [text, status], logger });
  servers.push(t);
  if (voice) await voice.whenReady();
  const client = async (c: { setupCode?: string; nickname?: string } = {}) => {
    const tc = await connectTestClient(t.server, c);
    clients.push(tc);
    return tc;
  };
  return { t, text, voice, backend, logs, client, owner: () => client({ setupCode: t.server.setupCode()!, nickname: 'Dona' }) };
}

function readStatus(t: TestServer): StatusFile {
  return JSON.parse(readFileSync(join(t.dataDir, STATUS_FILE), 'utf8')) as StatusFile;
}

function ok(res: ResOk | ResErr): unknown {
  if (!res.ok) throw new Error(`expected success, got ${res.error.code}`);
  return res.d;
}

async function until(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function https(port: number, path: string, method = 'GET'): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, method, rejectUnauthorized: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    })
      .on('error', reject)
      .end();
  });
}

const nowS = () => Math.floor(Date.now() / 1000);

/** A request signed by `who` over the text of `serverKeyId` (this server's unless given) at `ts`. */
function signedPath(who: TestClient, serverKeyId: string, ts = nowS()): string {
  return ownerStatusPath(ts, who.identity.sign(buildOwnerStatusMessage(serverKeyId, ts)));
}

describe('status.json (servers follow the app, §2)', () => {
  it('is written at start: the version, nobody in voice, and when', async () => {
    const before = Date.now();
    const s = await setup();
    const status = readStatus(s.t);
    expect(Object.keys(status).sort()).toEqual(['updatedAt', 'version', 'voiceActive']);
    expect(status).toMatchObject({ version: SERVER_VERSION, voiceActive: false });
    expect(Date.parse(status.updatedAt)).toBeGreaterThanOrEqual(before - 1_000);
    if (process.platform !== 'win32') expect(statSync(join(s.t.dataDir, STATUS_FILE)).mode & 0o777).toBe(0o640);
  });

  it('turns voiceActive on when someone joins voice and off when they leave, right away', async () => {
    const s = await setup();
    const a = await s.client({ nickname: 'ana' });
    ok(await a.request('voice.join', { channelId: 'VC1' }));
    expect(readStatus(s.t).voiceActive).toBe(true); // holding a join: a restart would drop the call
    s.backend!.join('ch_VC1', `u_${a.identity.userId}`);
    expect(readStatus(s.t).voiceActive).toBe(true);
    ok(await a.request('voice.leave', {}));
    expect(readStatus(s.t).voiceActive).toBe(false);
    expect(s.voice!.active).toBe(false);
  });

  it('turns voiceActive off when the last one in voice goes offline', async () => {
    const s = await setup();
    const a = await s.client({ nickname: 'ana' });
    ok(await a.request('voice.join', { channelId: 'VC1' }));
    s.backend!.join('ch_VC1', `u_${a.identity.userId}`);
    expect(readStatus(s.t).voiceActive).toBe(true);
    s.text.kick(a.identity.userId);
    await until(() => readStatus(s.t).voiceActive === false);
  });

  it('is written again every refresh period even when nothing changed', async () => {
    const s = await setup({ refreshMs: 40 });
    const first = readStatus(s.t).updatedAt;
    await until(() => readStatus(s.t).updatedAt !== first);
    expect(readStatus(s.t).voiceActive).toBe(false);
  });

  it('says false without a voice module', async () => {
    const s = await setup({ voice: false });
    expect(readStatus(s.t)).toMatchObject({ version: SERVER_VERSION, voiceActive: false });
  });
});

describe('GET /owner/status (servers follow the app, §2)', () => {
  it('answers the owner: the version and whether anyone is in voice, never cached', async () => {
    const s = await setup();
    const owner = await s.owner();
    const res = await https(s.t.server.port, signedPath(owner, s.t.server.serverKeyId));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ version: SERVER_VERSION, voiceActive: false });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');

    const a = await s.client({ nickname: 'ana' });
    ok(await a.request('voice.join', { channelId: 'VC1' }));
    s.backend!.join('ch_VC1', `u_${a.identity.userId}`);
    expect(JSON.parse((await https(s.t.server.port, signedPath(owner, s.t.server.serverKeyId))).body)).toEqual({ version: SERVER_VERSION, voiceActive: true });
  });

  it('refuses another member, another server text, a stale or future ts, and a server without owner', async () => {
    const s = await setup();
    const port = s.t.server.port;
    const keyId = s.t.server.serverKeyId;
    const member = await s.client({ nickname: 'ana' });
    // No owner yet: nobody may ask.
    expect((await https(port, signedPath(member, keyId))).status).toBe(403);
    const owner = await s.owner();
    expect((await https(port, signedPath(owner, keyId))).status).toBe(200);
    expect((await https(port, signedPath(member, keyId))).status).toBe(403);
    // The owner's signature for another server (another TLS key) does not open this one.
    expect((await https(port, signedPath(owner, randomBytes(32).toString('base64url')))).status).toBe(403);
    expect((await https(port, signedPath(owner, keyId, nowS() - 120))).status).toBe(403);
    expect((await https(port, signedPath(owner, keyId, nowS() + 120))).status).toBe(403);
    expect((await https(port, signedPath(owner, keyId, nowS() - 30))).status).toBe(200);
    expect((await https(port, signedPath(owner, keyId, nowS() + 30))).status).toBe(200);
  });

  it('refuses a malformed or tampered query the same way', async () => {
    const s = await setup();
    const owner = await s.owner();
    const port = s.t.server.port;
    const good = signedPath(owner, s.t.server.serverKeyId);
    const query = good.slice(good.indexOf('?') + 1);
    const sig = query.slice(query.indexOf('sig=') + 4);
    const ts = nowS();
    for (const path of [
      '/owner/status',
      `/owner/status?sig=${sig}`,
      `/owner/status?${query}&x=1`,
      `/owner/status?${query}&ts=${ts}`,
      `/owner/status?ts=${ts + 1}&sig=${sig}`, // the signature is for another ts
      `/owner/status?ts=0${ts}&sig=${sig}`,
      `/owner/status?${query}=`,
      // Tampered: one character always changed (a fixed "AA" suffix matched the real one about 1 run in 4096).
      `/owner/status?ts=${ts}&sig=${sig.slice(0, -3)}${sig.at(-3) === 'A' ? 'B' : 'A'}${sig.slice(-2)}`,
    ]) {
      const res = await https(port, path);
      expect(res.status, path).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ code: 'FORBIDDEN' });
    }
    expect((await https(port, good)).status).toBe(200);
    expect((await https(port, good, 'POST')).status).toBe(405);
  });

  it('allows 30 requests per minute per address, valid or not', async () => {
    const s = await setup();
    const owner = await s.owner();
    const port = s.t.server.port;
    for (let i = 0; i < 29; i++) expect((await https(port, '/owner/status?ts=1&sig=x')).status).toBe(403);
    expect((await https(port, signedPath(owner, s.t.server.serverKeyId))).status).toBe(200);
    const limited = await https(port, signedPath(owner, s.t.server.serverKeyId));
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    expect(JSON.parse(limited.body)).toEqual({ code: 'RATE_LIMITED' });
  });

  it('never logs the URL or the signature', async () => {
    const s = await setup();
    const owner = await s.owner();
    const path = signedPath(owner, s.t.server.serverKeyId);
    await https(s.t.server.port, path);
    await https(s.t.server.port, `${path}x`);
    const sig = path.slice(path.indexOf('sig=') + 4);
    expect(s.logs.join('\n')).not.toContain('/owner/status');
    expect(s.logs.join('\n')).not.toContain(sig);
  });
});
