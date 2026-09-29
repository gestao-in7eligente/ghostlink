import { createHmac } from 'node:crypto';
import { request } from 'node:https';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { TrackSource } from 'livekit-server-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PERMISSIONS, type ResErr, type ResOk, type VoiceChannelState } from '@ghostlink/shared';
import type { Logger } from '../../src/logger.js';
import { createVoiceModule, type VoiceModule } from '../../src/voice/index.js';
import { withDb } from '../helpers/db.js';
import { connectTestClient, startTestServer, type TestClient, type TestServer } from '../helpers/testClient.js';
import { EventsText, FAKE_KEYS, FakeBackend, StubText } from '../helpers/voice.js';

const P = PERMISSIONS;
const servers: TestServer[] = [];
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await Promise.all(servers.splice(0).map((s) => s.cleanup()));
});

interface Setup {
  t: TestServer;
  text: StubText;
  backend: FakeBackend | null;
  voice: VoiceModule;
  logs: string[];
  client(nickname?: string): Promise<TestClient>;
}

async function setup(o: { backend?: FakeBackend | null; graceMs?: number; publicAddresses?: string[] } = {}): Promise<Setup> {
  const text = new StubText();
  text.channels.set('VC1', { type: 'voice', userLimit: 0 });
  text.channels.set('VC2', { type: 'voice', userLimit: 0 });
  text.channels.set('TX1', { type: 'text', userLimit: 0 });
  text.channels.set('SECRET', { type: 'voice', userLimit: 0 });
  text.privateChannels.add('SECRET');
  const backend = o.backend === undefined ? new FakeBackend() : o.backend;
  const voice = createVoiceModule({ backend: () => backend, sweepIntervalMs: 3_600_000, reconcileIntervalMs: 3_600_000 });
  const logs: string[] = [];
  const logger: Logger = {
    info: (m, meta) => logs.push(`${m} ${JSON.stringify(meta ?? {})}`),
    warn: (m, meta) => logs.push(`${m} ${JSON.stringify(meta ?? {})}`),
    error: (m, meta) => logs.push(`${m} ${JSON.stringify(meta ?? {})}`),
  };
  const t = await startTestServer({
    joinMode: 'open',
    modules: [text, voice],
    logger,
    limits: o.graceMs ? { presenceGraceMs: o.graceMs } : undefined,
    publicAddresses: o.publicAddresses,
  });
  servers.push(t);
  await voice.whenReady();
  return {
    t,
    text,
    backend,
    voice,
    logs,
    client: async (nickname) => {
      const c = await connectTestClient(t.server, nickname ? { nickname } : {});
      clients.push(c);
      return c;
    },
  };
}

function ok<T = Record<string, unknown>>(res: ResOk | ResErr): T {
  if (!res.ok) throw new Error(`expected success, got ${res.error.code}`);
  return res.d as T;
}
function code(res: ResOk | ResErr): string {
  return res.ok ? 'OK' : res.error.code;
}

interface JoinRes {
  livekitUrl: string;
  token: string;
  iceServers: unknown[];
}

function claimsOf(jwt: string): { sub: string; video: { room: string; canPublish: boolean; canPublishSources?: string[] } } {
  return JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8'));
}

/** Resolves the next voice.state for `channelId` (that matches `until`, when given), skipping others. */
async function nextState(c: TestClient, channelId: string, timeoutMs = 3_000, until?: (s: VoiceChannelState) => boolean): Promise<VoiceChannelState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const e = await c.waitEvent('voice.state', Math.max(1, deadline - Date.now()));
    const d = e.d as VoiceChannelState;
    if (d.channelId === channelId && (!until || until(d))) return d;
  }
}
const empty = (s: VoiceChannelState) => s.participants.length === 0;

async function noEvent(c: TestClient, t: string, ms = 300): Promise<void> {
  await expect(c.waitEvent(t, ms)).rejects.toThrow(/no .* event/);
}

function https(
  port: number,
  path: string,
  method = 'GET',
  o: { headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, method, headers: o.headers, rejectUnauthorized: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    }).on('error', reject).end(o.body);
  });
}

function wsUpgrade(port: number, path: string, headers?: Record<string, string>): Promise<{ status: number; first?: string; ws?: WebSocket }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}${path}`, { rejectUnauthorized: false, headers });
    ws.once('unexpected-response', (_req, res) => {
      resolve({ status: res.statusCode ?? 0 });
      ws.terminate();
    });
    ws.once('message', (data) => resolve({ status: 101, first: String(data), ws }));
    ws.once('error', (e) => {
      if (!/Unexpected server response/.test(String(e))) reject(e);
    });
  });
}

/** A WebSocket handshake request as raw bytes (what a client can put on one TLS connection). */
function upgradeRequest(path: string): string {
  return `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`;
}

/** A raw TLS connection to the public port that records everything the server sends back. */
async function rawTls(port: number): Promise<{ socket: TLSSocket; received(): string; closed(): boolean }> {
  const socket = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false });
  let received = '';
  let closed = false;
  socket.on('data', (d: Buffer) => (received += d.toString('latin1')));
  socket.on('close', () => (closed = true));
  socket.on('error', () => {});
  await new Promise<void>((resolve, reject) => {
    socket.once('secureConnect', () => resolve());
    socket.once('error', reject);
  });
  return { socket, received: () => received, closed: () => closed };
}

function refreshToken(sub: string, room: string, secret = FAKE_KEYS.apiSecret): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iss: FAKE_KEYS.apiKey, sub, nbf: now, exp: now + 600, video: { roomJoin: true, room } })).toString('base64url');
  return `${header}.${body}.${createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')}`;
}

describe('voice module: welcome and features', () => {
  it('announces voice only while LiveKit runs, and adds the voice snapshot to the welcome', async () => {
    const s = await setup();
    const a = await s.client();
    expect(a.welcome!.features).toContain('voice');
    expect(a.rawWelcome!.voice).toEqual([]);

    const down = await setup({ backend: null });
    const b = await down.client();
    expect(b.welcome!.features).not.toContain('voice');
    expect(b.rawWelcome!.voice).toEqual([]);
    // Graceful degradation: the server runs, voice.join answers INTERNAL with a clear log line.
    expect(code(await b.request('voice.join', { channelId: 'VC1' }))).toBe('INTERNAL');
    expect(down.logs.some((l) => l.includes('voice is unavailable'))).toBe(true);
  });

  it('whenReady waits through a failed first start that the supervisor retries, and is false only when it gives up', async () => {
    // A first start can fail on a transient cause (a port taken meanwhile); the supervisor restarts LiveKit.
    class RetriedBackend extends FakeBackend {
      override async start(listeners: Parameters<FakeBackend['start']>[0]): Promise<void> {
        setTimeout(() => void super.start(listeners), 50);
        throw new Error('livekit-server exited (code 1)');
      }
    }
    const retried = await setup({ backend: new RetriedBackend() });
    expect(await retried.voice.whenReady()).toBe(true);
    expect((await retried.client()).welcome!.features).toContain('voice');

    class GivingUpBackend extends FakeBackend {
      override async start(listeners: Parameters<FakeBackend['start']>[0]): Promise<void> {
        this.available = false;
        setTimeout(() => listeners.onUnavailable(), 50);
        throw new Error('livekit-server exited (code 1)');
      }
    }
    const down = await setup({ backend: new GivingUpBackend() });
    expect(await down.voice.whenReady()).toBe(false);
    expect(down.logs.some((l) => l.includes('voice is unavailable'))).toBe(true);
  });

  it('the welcome lists participants only in voice channels the user can see', async () => {
    const s = await setup();
    const alice = await s.client('alice');
    const bob = await s.client('bob');
    s.text.setBits(alice.identity.userId, 'SECRET', P.VIEW_CHANNEL | P.CONNECT_VOICE | P.SPEAK);
    ok(await alice.request('voice.join', { channelId: 'SECRET' }));
    ok(await bob.request('voice.join', { channelId: 'VC1' }));
    s.backend!.join('ch_SECRET', `u_${alice.identity.userId}`);
    s.backend!.join('ch_VC1', `u_${bob.identity.userId}`);

    const carol = await s.client('carol');
    const voice = carol.rawWelcome!.voice as VoiceChannelState[];
    expect(voice.map((v) => v.channelId)).toEqual(['VC1']);
    s.text.setBits(carol.identity.userId, 'SECRET', P.VIEW_CHANNEL);
    carol.close();
    const again = await connectTestClient(s.t.server, { seed: carol.identity.seed, nickname: 'carol' });
    clients.push(again);
    expect((again.rawWelcome!.voice as VoiceChannelState[]).map((v) => v.channelId).sort()).toEqual(['SECRET', 'VC1']);
  });
});

describe('voice.join (spec §8.2)', () => {
  it('returns a 60 s token for ch_<id> as u_<id> with the mapped sources, and no ICE servers', async () => {
    const s = await setup();
    const a = await s.client('ana');
    const res = ok<JoinRes>(await a.request('voice.join', { channelId: 'VC1' }));
    expect(res.livekitUrl).toBe(`wss://127.0.0.1:${s.t.server.port}`);
    expect(res.iceServers).toEqual([]);
    const claims = claimsOf(res.token);
    expect(claims.sub).toBe(`u_${a.identity.userId}`);
    expect(claims.video).toMatchObject({ room: 'ch_VC1', canPublish: true, canPublishSources: ['microphone', 'camera', 'screen_share', 'screen_share_audio'] });
    expect(s.voice.registry.assignedChannel(a.identity.userId)).toBe('VC1');
  });

  it('points livekitUrl at the host:port this client connected to, not at another public address (spec §8.2)', async () => {
    // The renderer pins only the hostname its connection used (spec §4): any other host would fail TLS.
    const s = await setup({ publicAddresses: ['voice.example.com:7700'] });
    const a = await s.client('ana');
    expect(ok<JoinRes>(await a.request('voice.join', { channelId: 'VC1' })).livekitUrl).toBe(`wss://127.0.0.1:${s.t.server.port}`);
  });

  it('a user without SPEAK or VIDEO may connect but never gets canPublish with an empty list', async () => {
    const s = await setup();
    const a = await s.client();
    s.text.setBits(a.identity.userId, 'VC1', P.VIEW_CHANNEL | P.CONNECT_VOICE);
    const claims = claimsOf(ok<JoinRes>(await a.request('voice.join', { channelId: 'VC1' })).token);
    expect(claims.video.canPublish).toBe(false);
  });

  it('answers a private channel exactly like a missing one, and checks type, CONNECT_VOICE and the payload', async () => {
    const s = await setup();
    const a = await s.client();
    expect(code(await a.request('voice.join', { channelId: 'SECRET' }))).toBe('NOT_FOUND');
    expect(code(await a.request('voice.join', { channelId: 'NOPE' }))).toBe('NOT_FOUND');
    expect(code(await a.request('voice.join', { channelId: 'TX1' }))).toBe('BAD_REQUEST');
    s.text.setBits(a.identity.userId, 'VC2', P.VIEW_CHANNEL | P.SPEAK);
    expect(code(await a.request('voice.join', { channelId: 'VC2' }))).toBe('FORBIDDEN');
    expect(code(await a.request('voice.join', { channelId: 'VC1', extra: true }))).toBe('BAD_REQUEST');
    expect(code(await a.request('voice.join', { channelId: '../x' }))).toBe('BAD_REQUEST');
    expect(s.voice.registry.assignedChannel(a.identity.userId)).toBeNull();
  });

  it('respects user_limit (CHANNEL_FULL) but lets a member rejoin their own channel', async () => {
    const s = await setup();
    s.text.channels.set('VC1', { type: 'voice', userLimit: 1 });
    const a = await s.client();
    const b = await s.client();
    ok(await a.request('voice.join', { channelId: 'VC1' }));
    expect(code(await b.request('voice.join', { channelId: 'VC1' }))).toBe('CHANNEL_FULL');
    ok(await a.request('voice.join', { channelId: 'VC1' }));
    ok(await a.request('voice.leave', {}));
    ok(await b.request('voice.join', { channelId: 'VC1' }));
  });

  it('rate-limits voice.join to 5 per 10 s per user (spec §13)', async () => {
    const s = await setup();
    const a = await s.client();
    for (let i = 0; i < 5; i++) ok(await a.request('voice.join', { channelId: 'VC1' }));
    expect(code(await a.request('voice.join', { channelId: 'VC1' }))).toBe('RATE_LIMITED');
    const b = await s.client();
    ok(await b.request('voice.join', { channelId: 'VC1' }));
  });

  it('moving to another channel removes the user from the old room', async () => {
    const s = await setup();
    const a = await s.client();
    ok(await a.request('voice.join', { channelId: 'VC1' }));
    s.backend!.join('ch_VC1', `u_${a.identity.userId}`);
    ok(await a.request('voice.join', { channelId: 'VC2' }));
    expect(s.backend!.removals()).toContain(`ch_VC1/u_${a.identity.userId}`);
    expect(s.voice.registry.presentIn('VC1')).toEqual([]);
  });
});

describe('voice.state from webhooks, with per-recipient audience (spec §5.3, §8.3)', () => {
  it('goes to everyone who can see the channel and to nobody else', async () => {
    const s = await setup();
    const alice = await s.client('alice');
    const bob = await s.client('bob');
    const eve = await s.client('eve');
    s.text.setBits(alice.identity.userId, 'SECRET', P.VIEW_CHANNEL | P.CONNECT_VOICE | P.SPEAK);
    s.text.setBits(bob.identity.userId, 'SECRET', P.VIEW_CHANNEL);
    ok(await alice.request('voice.join', { channelId: 'SECRET' }));
    s.backend!.join('ch_SECRET', `u_${alice.identity.userId}`);
    const expected = { channelId: 'SECRET', participants: [{ userId: alice.identity.userId, muted: false, deafened: false, camera: false, screen: false, serverMuted: false }] };
    expect(await nextState(alice, 'SECRET')).toEqual(expected);
    expect(await nextState(bob, 'SECRET')).toEqual(expected);
    await noEvent(eve, 'voice.state');

    ok(await alice.request('voice.selfState', { muted: true, deafened: true }));
    expect((await nextState(bob, 'SECRET')).participants[0]).toMatchObject({ muted: true, deafened: true });
    await noEvent(eve, 'voice.state');
    expect(code(await alice.request('voice.selfState', { muted: true }))).toBe('BAD_REQUEST');
  });

  it('tracks camera and screen, and ignores a stale participant_left of an older connection', async () => {
    const s = await setup();
    const a = await s.client();
    const identity = `u_${a.identity.userId}`;
    ok(await a.request('voice.join', { channelId: 'VC1' }));
    const oldSid = s.backend!.join('ch_VC1', identity);
    await nextState(a, 'VC1');
    s.backend!.emit({ event: 'track_published', room: 'ch_VC1', identity, participantSid: oldSid, track: { sid: 'TR_cam', source: 'camera' } });
    expect((await nextState(a, 'VC1')).participants[0]).toMatchObject({ camera: true, screen: false });
    const newSid = s.backend!.join('ch_VC1', identity);
    await nextState(a, 'VC1');
    s.backend!.emit({ event: 'participant_left', room: 'ch_VC1', identity, participantSid: oldSid, track: null });
    await noEvent(a, 'voice.state');
    expect(s.voice.registry.presentIn('VC1')).toEqual([a.identity.userId]);
    s.backend!.emit({ event: 'participant_left', room: 'ch_VC1', identity, participantSid: newSid, track: null });
    expect((await nextState(a, 'VC1')).participants).toEqual([]);
  });

  it('removes anyone LiveKit reports in a room the server did not assign to them', async () => {
    const s = await setup();
    const a = await s.client();
    const identity = `u_${a.identity.userId}`;
    s.backend!.join('ch_VC1', identity);
    await noEvent(a, 'voice.state');
    expect(s.backend!.removals()).toContain(`ch_VC1/${identity}`);
    s.backend!.emit({ event: 'participant_joined', room: 'ch_VC1', identity: 'agent-x', participantSid: 'PA_x', track: null });
    expect(s.backend!.removals()).toContain('ch_VC1/agent-x');
  });
});

describe('voice.moderate (spec §5.2, §8.3)', () => {
  async function inVoice(s: Setup, channelId = 'VC1') {
    const mod = await s.client('mod');
    const target = await s.client('target');
    ok(await target.request('voice.join', { channelId }));
    s.backend!.join(`ch_${channelId}`, `u_${target.identity.userId}`);
    await nextState(target, channelId);
    return { mod, target };
  }

  it('mute needs MUTE_MEMBERS and hierarchy, and takes the microphone away through LiveKit permissions', async () => {
    const s = await setup();
    const { mod, target } = await inVoice(s);
    const targetId = target.identity.userId;
    expect(code(await mod.request('voice.moderate', { userId: targetId, action: 'mute' }))).toBe('FORBIDDEN');
    s.text.setBits(mod.identity.userId, 'VC1', s.text.defaultBits | P.MUTE_MEMBERS);
    expect(code(await mod.request('voice.moderate', { userId: targetId, action: 'mute' }))).toBe('HIERARCHY');
    s.text.positions.set(mod.identity.userId, 5);
    s.text.positions.set(targetId, 5);
    expect(code(await mod.request('voice.moderate', { userId: targetId, action: 'mute' }))).toBe('HIERARCHY');
    s.text.positions.set(targetId, 1);
    expect(code(await mod.request('voice.moderate', { userId: targetId, action: 'disconnect' }))).toBe('FORBIDDEN');
    ok(await mod.request('voice.moderate', { userId: targetId, action: 'mute' }));

    const muted = s.backend!.updates(`u_${targetId}`).at(-1)!;
    expect(muted.canPublishSources).not.toContain(2 /* TrackSource.MICROPHONE */);
    expect(muted).toMatchObject({ canSubscribe: true, canPublishData: false, canUpdateMetadata: false, hidden: false });
    expect(muted.canPublish).toBe(muted.canPublishSources.length > 0);
    expect((await nextState(target, 'VC1')).participants[0]!.serverMuted).toBe(true);

    // A new token keeps the mute: a rejoin cannot get the microphone back.
    const rejoin = claimsOf(ok<JoinRes>(await target.request('voice.join', { channelId: 'VC1' })).token);
    expect(rejoin.video.canPublishSources).not.toContain('microphone');

    ok(await mod.request('voice.moderate', { userId: targetId, action: 'unmute' }));
    expect(s.backend!.updates(`u_${targetId}`).at(-1)!.canPublishSources).toContain(2);
    expect((await nextState(target, 'VC1')).participants[0]!.serverMuted).toBe(false);
  });

  it('nobody acts on the owner or on themselves', async () => {
    const s = await setup();
    const { mod, target } = await inVoice(s);
    s.text.setBits(mod.identity.userId, 'VC1', s.text.defaultBits | P.MUTE_MEMBERS | P.MOVE_MEMBERS);
    s.text.positions.set(mod.identity.userId, 9);
    s.text.owner = target.identity.userId;
    expect(code(await mod.request('voice.moderate', { userId: target.identity.userId, action: 'mute' }))).toBe('HIERARCHY');
    ok(await mod.request('voice.join', { channelId: 'VC1' }));
    s.backend!.join('ch_VC1', `u_${mod.identity.userId}`);
    expect(code(await mod.request('voice.moderate', { userId: mod.identity.userId, action: 'mute' }))).toBe('HIERARCHY');
  });

  it('someone in a channel the moderator cannot see is NOT_FOUND, like someone not in voice', async () => {
    const s = await setup();
    const target = await s.client('target');
    const mod = await s.client('mod');
    s.text.setBits(target.identity.userId, 'SECRET', P.VIEW_CHANNEL | P.CONNECT_VOICE);
    s.text.defaultBits |= P.MUTE_MEMBERS | P.MOVE_MEMBERS;
    s.text.positions.set(mod.identity.userId, 9);
    ok(await target.request('voice.join', { channelId: 'SECRET' }));
    s.backend!.join('ch_SECRET', `u_${target.identity.userId}`);
    expect(code(await mod.request('voice.moderate', { userId: target.identity.userId, action: 'mute' }))).toBe('NOT_FOUND');
    const nobody = await s.client('nobody');
    expect(code(await mod.request('voice.moderate', { userId: nobody.identity.userId, action: 'disconnect' }))).toBe('NOT_FOUND');
    expect(code(await mod.request('voice.moderate', { userId: target.identity.userId, action: 'move' }))).toBe('BAD_REQUEST');
  });

  it('disconnect removes the user, tells their client, and the proxy refuses their token afterwards', async () => {
    const s = await setup();
    const { mod, target } = await inVoice(s);
    const targetId = target.identity.userId;
    const { token } = ok<JoinRes>(await target.request('voice.join', { channelId: 'VC1' }));
    s.text.setBits(mod.identity.userId, 'VC1', s.text.defaultBits | P.MOVE_MEMBERS);
    s.text.positions.set(mod.identity.userId, 3);
    ok(await mod.request('voice.moderate', { userId: targetId, action: 'disconnect' }));
    expect((await target.waitEvent('voice.forceDisconnect')).d).toEqual({});
    expect(s.backend!.removals()).toContain(`ch_VC1/u_${targetId}`);
    expect((await nextState(mod, 'VC1', 3_000, empty)).participants).toEqual([]);
    expect((await https(s.t.server.port, `/rtc/v1/validate?access_token=${token}`)).status).toBe(403);
  });

  it('move: checks the destination for the moderator and the target, then forces the client over', async () => {
    const s = await setup();
    const { mod, target } = await inVoice(s);
    const targetId = target.identity.userId;
    s.text.setBits(mod.identity.userId, 'VC1', s.text.defaultBits | P.MOVE_MEMBERS);
    s.text.positions.set(mod.identity.userId, 3);
    // Moving into a channel the moderator cannot see leaks nothing: NOT_FOUND (spec §5.3).
    expect(code(await mod.request('voice.moderate', { userId: targetId, action: 'move', toChannelId: 'SECRET' }))).toBe('NOT_FOUND');
    s.text.setBits(mod.identity.userId, 'SECRET', P.VIEW_CHANNEL);
    expect(code(await mod.request('voice.moderate', { userId: targetId, action: 'move', toChannelId: 'SECRET' }))).toBe('FORBIDDEN');
    expect(code(await mod.request('voice.moderate', { userId: targetId, action: 'move', toChannelId: 'TX1' }))).toBe('BAD_REQUEST');
    s.text.channels.set('VC2', { type: 'voice', userLimit: 1 });
    const other = await s.client('other');
    ok(await other.request('voice.join', { channelId: 'VC2' }));
    expect(code(await mod.request('voice.moderate', { userId: targetId, action: 'move', toChannelId: 'VC2' }))).toBe('CHANNEL_FULL');
    ok(await other.request('voice.leave', {}));

    ok(await mod.request('voice.moderate', { userId: targetId, action: 'move', toChannelId: 'VC2' }));
    expect((await target.waitEvent('voice.forceMove')).d).toEqual({ toChannelId: 'VC2' });
    expect(s.backend!.removals()).toContain(`ch_VC1/u_${targetId}`);
    expect(s.voice.registry.assignedChannel(targetId)).toBeNull();
    ok(await target.request('voice.join', { channelId: 'VC2' }));
  });
});

describe('the /rtc* proxy (spec §4)', () => {
  async function joined(s: Setup) {
    const a = await s.client('ana');
    const res = ok<JoinRes>(await a.request('voice.join', { channelId: 'VC1' }));
    return { a, token: res.token };
  }

  it('forwards validate requests byte for byte when the token, session, room and permissions agree', async () => {
    const s = await setup();
    const { token } = await joined(s);
    const path = `/rtc/v1/validate?access_token=${token}&join_request=AbC_-123&x=%2F`;
    const res = await https(s.t.server.port, path);
    expect(res.status).toBe(200);
    expect(res.body).toBe(`livekit saw ${path}`);
    expect(res.headers['x-fake-livekit']).toBe('yes');
    expect(s.backend!.seen.at(-1)).toMatchObject({ method: 'GET', url: path, upgrade: false });
    for (const p of ['/rtc/validate', '/rtc', '/rtc/v1']) expect((await https(s.t.server.port, `${p}?access_token=${token}`)).status).toBe(200);
  });

  it('forwards the WebSocket upgrade with path and query intact, including a multi-KB join_request', async () => {
    const s = await setup();
    const { token } = await joined(s);
    const joinRequest = 'J'.repeat(9_000);
    const path = `/rtc/v1?access_token=${token}&join_request=${joinRequest}`;
    const res = await wsUpgrade(s.t.server.port, path);
    expect(res.status).toBe(101);
    expect(res.first).toBe(`hello from livekit ${path}`);
    const echoed = new Promise<string>((r) => res.ws!.once('message', (d) => r(String(d))));
    res.ws!.send('ping');
    expect(await echoed).toBe('echo ping');
    res.ws!.close();
  });

  it('refuses with 403, never 404: no token, forged, wrong room, unknown sub-path, other methods', async () => {
    const s = await setup();
    const { a, token } = await joined(s);
    const port = s.t.server.port;
    const forged = refreshToken(`u_${a.identity.userId}`, 'ch_VC1', 'x'.repeat(43));
    const wrongRoom = refreshToken(`u_${a.identity.userId}`, 'ch_VC2');
    for (const path of ['/rtc/v1', `/rtc/v1?access_token=${forged}`, `/rtc/v1?access_token=${wrongRoom}`, `/rtc/v1/other?access_token=${token}`, `/rtc/v1?access_token=${token}&access_token=${token}`]) {
      expect((await https(port, path)).status, path).toBe(403);
      expect((await wsUpgrade(port, path)).status, path).toBe(403);
    }
    expect((await https(port, `/rtc/v1/validate?access_token=${token}`, 'POST')).status).toBe(403);
    expect(s.backend!.seen).toEqual([]);
  });

  it('accepts LiveKit refresh tokens for the assigned room', async () => {
    const s = await setup();
    const { a } = await joined(s);
    expect((await https(s.t.server.port, `/rtc/v1/validate?access_token=${refreshToken(`u_${a.identity.userId}`, 'ch_VC1')}`)).status).toBe(200);
  });

  it('refuses any Authorization header: LiveKit would take its token over the authorized query token', async () => {
    const s = await setup();
    const { a, token } = await joined(s);
    const port = s.t.server.port;
    // Signed with our secret for a room this user was never assigned: LiveKit alone would accept it.
    const smuggled = refreshToken(`u_${a.identity.userId}`, 'ch_SECRET');
    for (const [name, value] of [['Authorization', `Bearer ${smuggled}`], ['authorization', `Bearer ${token}`], ['AUTHORIZATION', 'Basic eDp5']] as const) {
      expect((await https(port, `/rtc/v1/validate?access_token=${token}`, 'GET', { headers: { [name]: value } })).status, name).toBe(403);
      expect((await wsUpgrade(port, `/rtc/v1?access_token=${token}`, { [name]: value })).status, name).toBe(403);
    }
    expect(s.backend!.seen).toEqual([]);
  });

  it('forwards no credential header: cookies and proxy credentials are stripped, the rest passes', async () => {
    const s = await setup();
    const { token } = await joined(s);
    const port = s.t.server.port;
    const headers = { Cookie: 'sid=abc', 'Proxy-Authorization': 'Basic eDp5', 'X-Keep': 'yes' };
    expect((await https(port, `/rtc/validate?access_token=${token}`, 'GET', { headers })).status).toBe(200);
    const ws = await wsUpgrade(port, `/rtc?access_token=${token}`, headers);
    expect(ws.status).toBe(101);
    ws.ws!.close();
    expect(s.backend!.seen.map((r) => r.upgrade)).toEqual([false, true]);
    for (const r of s.backend!.seen) {
      expect(r.headers['x-keep']).toBe('yes');
      for (const name of ['authorization', 'proxy-authorization', 'cookie']) expect(r.headers, name).not.toHaveProperty(name);
    }
  });

  it('refuses a request body: livekit-client sends none, and LiveKit reads form fields from one', async () => {
    const s = await setup();
    const { token } = await joined(s);
    const port = s.t.server.port;
    const path = `/rtc/validate?access_token=${token}`;
    const form = { 'Content-Type': 'application/x-www-form-urlencoded' };
    expect((await https(port, path, 'GET', { headers: { ...form, 'Content-Length': '14' }, body: 'access_token=x' })).status).toBe(403);
    expect((await https(port, path, 'GET', { headers: { ...form, 'Transfer-Encoding': 'chunked' }, body: 'access_token=x' })).status).toBe(403);
    expect((await https(port, path, 'GET', { headers: { 'Content-Length': '0' } })).status).toBe(200);
    expect(s.backend!.seen).toHaveLength(1);
  });

  it('a refused upgrade leaves no raw pipe: nothing sent after it, or with it, reaches LiveKit', async () => {
    const s = await setup();
    const { token } = await joined(s);
    const port = s.t.server.port;
    s.backend!.refuseUpgrades = true;

    // LiveKit refuses this join (e.g. a malformed join_request) and would keep the connection open.
    const c = await rawTls(port);
    c.socket.write(upgradeRequest(`/rtc/v1?access_token=${token}`));
    await expect.poll(() => c.received()).toMatch(/^HTTP\/1\.1 400 /);
    c.socket.write(upgradeRequest(`/rtc?access_token=${token}`));
    await new Promise((r) => setTimeout(r, 300));
    expect(Buffer.concat(s.backend!.afterRefusal).toString('latin1')).toBe('');
    await expect.poll(() => c.closed()).toBe(true);
    expect(c.received()).not.toMatch(/ 101 /);

    // Bytes pipelined behind the handshake, before any answer, are refused outright.
    const d = await rawTls(port);
    d.socket.write(upgradeRequest(`/rtc/v1?access_token=${token}`) + upgradeRequest(`/rtc?access_token=${token}`));
    await expect.poll(() => d.closed()).toBe(true);
    expect(d.received()).toMatch(/^HTTP\/1\.1 403 /);
    expect(s.backend!.seen).toHaveLength(1);
    expect(s.backend!.afterRefusal).toEqual([]);
  });

  it('refuses once the user lost VIEW or CONNECT, was removed or banned, or left voice', async () => {
    const s = await setup();
    const { a, token } = await joined(s);
    const port = s.t.server.port;
    const validate = `/rtc/v1/validate?access_token=${token}`;
    s.text.setBits(a.identity.userId, 'VC1', P.VIEW_CHANNEL);
    expect((await https(port, validate)).status).toBe(403);
    s.text.bits.clear();
    expect((await https(port, validate)).status).toBe(200);
    withDb(s.t.dataDir, (db) => db.run('INSERT INTO bans (user_id, reason, banned_by, created_at) VALUES (?, ?, ?, ?)', a.identity.userId, 't', 't', Date.now()));
    expect((await https(port, validate)).status).toBe(403);
    withDb(s.t.dataDir, (db) => db.run('DELETE FROM bans'));
    withDb(s.t.dataDir, (db) => db.run('UPDATE users SET removed_at = ? WHERE id = ?', Date.now(), a.identity.userId));
    expect((await https(port, validate)).status).toBe(403);
    withDb(s.t.dataDir, (db) => db.run('UPDATE users SET removed_at = NULL WHERE id = ?', a.identity.userId));
    expect((await https(port, validate)).status).toBe(200);
    ok(await a.request('voice.leave', {}));
    expect((await https(port, validate)).status).toBe(403);
  });

  it('keeps the call through the presence grace, then removes the user and refuses the token (spec §4, §8.4)', async () => {
    const s = await setup({ graceMs: 300 });
    const { a, token } = await joined(s);
    const watcher = await s.client('watcher');
    s.backend!.join('ch_VC1', `u_${a.identity.userId}`);
    await nextState(watcher, 'VC1');
    a.close();
    await new Promise((r) => setTimeout(r, 50));
    expect((await https(s.t.server.port, `/rtc/v1/validate?access_token=${token}`)).status).toBe(200);
    expect((await nextState(watcher, 'VC1', 3_000)).participants).toEqual([]);
    expect(s.backend!.removals()).toContain(`ch_VC1/u_${a.identity.userId}`);
    expect((await https(s.t.server.port, `/rtc/v1/validate?access_token=${token}`)).status).toBe(403);
  });

  it('a kicked user is out of voice at once, with no grace, and the proxy refuses them', async () => {
    const s = await setup();
    const { a, token } = await joined(s);
    const watcher = await s.client('watcher');
    s.backend!.join('ch_VC1', `u_${a.identity.userId}`);
    await nextState(watcher, 'VC1');
    s.text.kick(a.identity.userId); // Text: sessions.closeUser(KICKED) + membership-removed hook
    expect((await nextState(watcher, 'VC1')).participants).toEqual([]);
    expect(s.backend!.removals()).toContain(`ch_VC1/u_${a.identity.userId}`);
    expect((await https(s.t.server.port, `/rtc/v1/validate?access_token=${token}`)).status).toBe(403);
  });

  it('the membership-removed hook alone also drops the user and tells their client', async () => {
    const s = await setup();
    const { a, token } = await joined(s);
    s.backend!.join('ch_VC1', `u_${a.identity.userId}`);
    s.text.emitRemoved(a.identity.userId, 'left');
    await a.waitEvent('voice.forceDisconnect');
    expect(s.backend!.removals()).toContain(`ch_VC1/u_${a.identity.userId}`);
    expect((await https(s.t.server.port, `/rtc/v1/validate?access_token=${token}`)).status).toBe(403);
  });

  it('never logs /rtc URLs or tokens', async () => {
    const s = await setup();
    const { token } = await joined(s);
    await https(s.t.server.port, `/rtc/v1/validate?access_token=${token}`);
    await https(s.t.server.port, `/rtc/v1/validate?access_token=forged`);
    await wsUpgrade(s.t.server.port, `/rtc/v1?access_token=${token}`).then((r) => r.ws?.close());
    expect(s.logs.join('\n')).not.toMatch(/access_token|\/rtc/);
    expect(s.logs.join('\n')).not.toContain(token.split('.')[2]!);
  });
});

describe("the Text module's events (its real seam: events.on)", () => {
  async function eventsSetup() {
    const text = new EventsText();
    text.stub.channels.set('VC1', { type: 'voice', userLimit: 0 });
    text.stub.channels.set('SECRET', { type: 'voice', userLimit: 0 });
    text.stub.privateChannels.add('SECRET');
    const backend = new FakeBackend();
    const voice = createVoiceModule({ backend: () => backend, sweepIntervalMs: 3_600_000, reconcileIntervalMs: 3_600_000 });
    const t = await startTestServer({ joinMode: 'open', modules: [text, voice] });
    servers.push(t);
    await voice.whenReady();
    const client = async (nickname: string) => {
      const c = await connectTestClient(t.server, { nickname });
      clients.push(c);
      return c;
    };
    return { t, text, backend, voice, client };
  }

  it('subscribes on start and unsubscribes on stop', async () => {
    const s = await eventsSetup();
    expect(s.text.listenerCount()).toBe(4);
    await s.t.server.close();
    expect(s.text.listenerCount()).toBe(0);
  });

  it('membership.removed drops the user from voice at once and tells their client', async () => {
    const s = await eventsSetup();
    const a = await s.client('ana');
    ok(await a.request('voice.join', { channelId: 'VC1' }));
    s.backend.join('ch_VC1', `u_${a.identity.userId}`);
    s.text.emit('membership.removed', { userId: a.identity.userId, reason: 'kicked' });
    await a.waitEvent('voice.forceDisconnect');
    expect(s.backend.removals()).toContain(`ch_VC1/u_${a.identity.userId}`);
    expect(s.voice.registry.assignedChannel(a.identity.userId)).toBeNull();
  });

  it('access.changed re-applies LiveKit permissions now, not at the next sweep', async () => {
    const s = await eventsSetup();
    const a = await s.client('ana');
    const identity = `u_${a.identity.userId}`;
    ok(await a.request('voice.join', { channelId: 'VC1' }));
    s.backend.join('ch_VC1', identity);
    await expect.poll(() => s.backend.updates(identity).length).toBe(1); // on arrival
    s.text.stub.setBits(a.identity.userId, 'VC1', P.VIEW_CHANNEL | P.CONNECT_VOICE);
    s.text.emit('access.changed', { userIds: [a.identity.userId] });
    await expect.poll(() => s.backend.updates(identity).length).toBe(2);
    expect(s.backend.updates(identity)[1]).toMatchObject({ canPublish: false, canPublishSources: [] });
  });

  it('channel.deleted empties that voice room', async () => {
    const s = await eventsSetup();
    const a = await s.client('ana');
    ok(await a.request('voice.join', { channelId: 'VC1' }));
    s.backend.join('ch_VC1', `u_${a.identity.userId}`);
    s.text.stub.channels.delete('VC1');
    s.text.emit('channel.deleted', { channelId: 'VC1', type: 'voice' });
    await a.waitEvent('voice.forceDisconnect');
    expect(s.backend.removals()).toContain(`ch_VC1/u_${a.identity.userId}`);
  });

  it('visibility.changed: a user who gains a voice channel gets its voice.state; one who loses it is dropped', async () => {
    const s = await eventsSetup();
    const a = await s.client('ana');
    const b = await s.client('bia');
    s.text.stub.setBits(a.identity.userId, 'SECRET', P.VIEW_CHANNEL | P.CONNECT_VOICE | P.SPEAK);
    ok(await a.request('voice.join', { channelId: 'SECRET' }));
    s.backend.join('ch_SECRET', `u_${a.identity.userId}`);
    await noEvent(b, 'voice.state');

    s.text.stub.setBits(b.identity.userId, 'SECRET', P.VIEW_CHANNEL);
    s.text.emit('visibility.changed', { userId: b.identity.userId, gained: ['SECRET', 'TX-none'], lost: [] });
    const state = await nextState(b, 'SECRET');
    expect(state.participants.map((p) => p.userId)).toEqual([a.identity.userId]);

    s.text.stub.setBits(a.identity.userId, 'SECRET', 0);
    s.text.emit('visibility.changed', { userId: a.identity.userId, gained: [], lost: ['SECRET'] });
    await a.waitEvent('voice.forceDisconnect');
    expect(s.voice.registry.assignedChannel(a.identity.userId)).toBeNull();
  });

  it('a change during a running sweep is not lost: the sweep runs again', async () => {
    const s = await eventsSetup();
    const a = await s.client('ana');
    const b = await s.client('bia');
    for (const c of [a, b]) {
      ok(await c.request('voice.join', { channelId: 'VC1' }));
      s.backend.join('ch_VC1', `u_${c.identity.userId}`);
    }
    // Hold the sweep on its first LiveKit call, change Ana's bits meanwhile, then release.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const original = s.backend.updatePermission.bind(s.backend);
    let first = true;
    s.backend.updatePermission = async (room, identity, permission) => {
      if (first) {
        first = false;
        await held;
      }
      return original(room, identity, permission);
    };
    s.text.stub.setBits(a.identity.userId, 'VC1', P.VIEW_CHANNEL | P.CONNECT_VOICE);
    s.text.stub.setBits(b.identity.userId, 'VC1', P.VIEW_CHANNEL | P.CONNECT_VOICE);
    s.text.emit('access.changed', { userIds: null });
    await new Promise((r) => setTimeout(r, 20));
    s.text.stub.setBits(a.identity.userId, 'VC1', P.VIEW_CHANNEL | P.CONNECT_VOICE | P.SPEAK);
    s.text.emit('access.changed', { userIds: [a.identity.userId] });
    release();
    await expect.poll(() => s.backend.updates(`u_${a.identity.userId}`).at(-1)?.canPublishSources).toEqual([TrackSource.MICROPHONE]);
  });

  it('ignores malformed payloads', async () => {
    const s = await eventsSetup();
    const a = await s.client('ana');
    ok(await a.request('voice.join', { channelId: 'VC1' }));
    for (const payload of [null, 'x', { userId: 42 }, { userId: a.identity.userId.slice(0, 5) }]) s.text.emit('membership.removed', payload);
    s.text.emit('visibility.changed', { userId: a.identity.userId, gained: 'VC1' });
    await noEvent(a, 'voice.forceDisconnect');
    expect(s.voice.registry.assignedChannel(a.identity.userId)).toBe('VC1');
  });
});

describe('permission changes and reconciliation (spec §7, §8.3)', () => {
  it('re-applies the complete permission block when bits change, and removes users who lost access', async () => {
    const s = await setup();
    const a = await s.client();
    const identity = `u_${a.identity.userId}`;
    ok(await a.request('voice.join', { channelId: 'VC1' }));
    s.backend!.join('ch_VC1', identity);
    await nextState(a, 'VC1');
    await expect.poll(() => s.backend!.updates(identity).length).toBe(1); // on arrival
    s.text.setBits(a.identity.userId, 'VC1', P.VIEW_CHANNEL | P.CONNECT_VOICE | P.VIDEO);
    s.text.emitChanged();
    await expect.poll(() => s.backend!.updates(identity).length).toBe(2);
    const p = s.backend!.updates(identity)[1]!;
    expect(p.canPublishSources).not.toContain(2);
    expect(p).toMatchObject({ canSubscribe: true, canPublish: true, canPublishData: false, canUpdateMetadata: false, hidden: false });
    s.text.emitChanged();
    await new Promise((r) => setTimeout(r, 50));
    expect(s.backend!.updates(identity)).toHaveLength(2); // unchanged bits: no call

    s.text.setBits(a.identity.userId, 'VC1', 0);
    await s.voice.refreshPermissions();
    expect(s.backend!.removals()).toContain(`ch_VC1/${identity}`);
    await a.waitEvent('voice.forceDisconnect');
    expect(s.voice.registry.assignedChannel(a.identity.userId)).toBeNull();
  });

  describe('between voice.join and LiveKit seeing the user (their token predates the change)', () => {
    async function assigned(s: Setup) {
      const mod = await s.client('mod');
      const target = await s.client('target');
      s.text.setBits(mod.identity.userId, 'VC1', s.text.defaultBits | P.MUTE_MEMBERS);
      s.text.positions.set(mod.identity.userId, 5);
      const { token } = ok<JoinRes>(await target.request('voice.join', { channelId: 'VC1' }));
      expect(claimsOf(token).video.canPublishSources).toContain('microphone');
      return { mod, target, identity: `u_${target.identity.userId}` };
    }

    it('a server mute reaches LiveKit when the user arrives, and they never keep the microphone', async () => {
      const s = await setup();
      const { mod, target, identity } = await assigned(s);
      ok(await mod.request('voice.moderate', { userId: target.identity.userId, action: 'mute' }));
      expect(s.backend!.updates(identity)).toEqual([]); // nobody in LiveKit to tell yet
      await s.voice.refreshPermissions();
      expect(s.backend!.updates(identity)).toEqual([]);

      s.backend!.join('ch_VC1', identity); // connects with the token it already holds
      await expect.poll(() => s.backend!.updates(identity).length).toBeGreaterThan(0);
      const pushed = s.backend!.updates(identity).at(-1)!;
      expect(pushed.canPublishSources).not.toContain(TrackSource.MICROPHONE);
      expect(pushed).toMatchObject({ canSubscribe: true, canPublishData: false, canUpdateMetadata: false, hidden: false });
      await s.voice.refreshPermissions();
      await s.voice.reconcile();
      expect(s.backend!.updates(identity)).toHaveLength(1); // once per connection, not on every sweep
    });

    it('a permission change reaches LiveKit when the user arrives', async () => {
      const s = await setup();
      const { target, identity } = await assigned(s);
      s.text.setBits(target.identity.userId, 'VC1', P.VIEW_CHANNEL | P.CONNECT_VOICE);
      s.text.emitChanged();
      await s.voice.refreshPermissions();
      expect(s.backend!.updates(identity)).toEqual([]);
      s.backend!.join('ch_VC1', identity);
      await expect.poll(() => s.backend!.updates(identity).at(-1)).toMatchObject({ canPublish: false, canPublishSources: [] });
    });

    it('every new LiveKit connection gets the current block, since its token may be older', async () => {
      const s = await setup();
      const { mod, target, identity } = await assigned(s);
      const sid = s.backend!.join('ch_VC1', identity);
      await expect.poll(() => s.backend!.updates(identity)).toHaveLength(1);
      ok(await mod.request('voice.moderate', { userId: target.identity.userId, action: 'mute' }));
      expect(s.backend!.updates(identity)).toHaveLength(2);
      s.backend!.emit({ event: 'participant_left', room: 'ch_VC1', identity, participantSid: sid, track: null });
      s.backend!.join('ch_VC1', identity); // reconnects with the (unmuted) join token
      await expect.poll(() => s.backend!.updates(identity)).toHaveLength(3);
      expect(s.backend!.updates(identity).at(-1)!.canPublishSources).not.toContain(TrackSource.MICROPHONE);
    });

    it('reconciliation pushes the current block to a participant whose webhook was lost', async () => {
      const s = await setup();
      const { mod, target, identity } = await assigned(s);
      ok(await mod.request('voice.moderate', { userId: target.identity.userId, action: 'mute' }));
      s.backend!.seed('ch_VC1', identity);
      await s.voice.reconcile();
      expect(s.backend!.updates(identity).at(-1)!.canPublishSources).not.toContain(TrackSource.MICROPHONE);
      await s.voice.reconcile();
      expect(s.backend!.updates(identity)).toHaveLength(1);
    });

    it('a later change is never overtaken by an earlier push still on its way to LiveKit', async () => {
      const s = await setup();
      const { mod, target, identity } = await assigned(s);
      // Hold the first push (the one on arrival, with the microphone) until the mute is under way.
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      const original = s.backend!.updatePermission.bind(s.backend!);
      let first = true;
      s.backend!.updatePermission = async (room, id, permission) => {
        if (first) {
          first = false;
          await held;
        }
        return original(room, id, permission);
      };
      s.backend!.join('ch_VC1', identity);
      await new Promise((r) => setTimeout(r, 20));
      const muting = mod.request('voice.moderate', { userId: target.identity.userId, action: 'mute' });
      await new Promise((r) => setTimeout(r, 50));
      release();
      ok(await muting);
      await expect.poll(() => s.backend!.updates(identity).length).toBeGreaterThan(0);
      await new Promise((r) => setTimeout(r, 50));
      expect(s.backend!.updates(identity).at(-1)!.canPublishSources).not.toContain(TrackSource.MICROPHONE);
    });
  });

  it('rebuilds the voice map from LiveKit and removes participants nobody assigned', async () => {
    const s = await setup();
    const a = await s.client();
    const b = await s.client();
    ok(await a.request('voice.join', { channelId: 'VC1' }));
    s.backend!.seed('ch_VC1', `u_${a.identity.userId}`); // its webhook was lost
    s.backend!.seed('ch_VC2', `u_${b.identity.userId}`); // never assigned
    s.backend!.seed('ch_VC2', 'intruder');
    s.backend!.seed('lobby', `u_${b.identity.userId}`); // not one of our rooms: left alone
    await s.voice.reconcile();
    expect(s.voice.registry.presentIn('VC1')).toEqual([a.identity.userId]);
    expect(s.voice.registry.hasMicrophone(a.identity.userId)).toBe(true);
    expect(s.voice.registry.presentIn('VC2')).toEqual([]);
    expect(s.backend!.removals().sort()).toEqual([`ch_VC2/intruder`, `ch_VC2/u_${b.identity.userId}`].sort());
    expect((await nextState(b, 'VC1')).participants.map((p) => p.userId)).toEqual([a.identity.userId]);
  });

  it('voice.leave removes the user from LiveKit and from the map', async () => {
    const s = await setup();
    const a = await s.client();
    ok(await a.request('voice.join', { channelId: 'VC1' }));
    s.backend!.join('ch_VC1', `u_${a.identity.userId}`);
    await nextState(a, 'VC1');
    expect(code(await a.request('voice.leave', { channelId: 'VC1' }))).toBe('BAD_REQUEST');
    ok(await a.request('voice.leave', {}));
    expect((await nextState(a, 'VC1')).participants).toEqual([]);
    expect(s.backend!.removals()).toContain(`ch_VC1/u_${a.identity.userId}`);
  });
});

