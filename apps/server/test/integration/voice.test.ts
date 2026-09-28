import { createHmac } from 'node:crypto';
import { request } from 'node:https';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PERMISSIONS, type ResErr, type ResOk, type VoiceChannelState } from '@ghostlink/shared';
import type { Logger } from '../../src/logger.js';
import { createVoiceModule, type VoiceModule } from '../../src/voice/index.js';
import { withDb } from '../helpers/db.js';
import { connectTestClient, startTestServer, type TestClient, type TestServer } from '../helpers/testClient.js';
import { FAKE_KEYS, FakeBackend, StubText } from '../helpers/voice.js';

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

async function setup(o: { backend?: FakeBackend | null; graceMs?: number } = {}): Promise<Setup> {
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
  const t = await startTestServer({ joinMode: 'open', modules: [text, voice], logger, limits: o.graceMs ? { presenceGraceMs: o.graceMs } : undefined });
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

function https(port: number, path: string, method = 'GET'): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, method, rejectUnauthorized: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    }).on('error', reject).end();
  });
}

function wsUpgrade(port: number, path: string): Promise<{ status: number; first?: string; ws?: WebSocket }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}${path}`, { rejectUnauthorized: false });
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

describe('permission changes and reconciliation (spec §7, §8.3)', () => {
  it('re-applies the complete permission block when bits change, and removes users who lost access', async () => {
    const s = await setup();
    const a = await s.client();
    const identity = `u_${a.identity.userId}`;
    ok(await a.request('voice.join', { channelId: 'VC1' }));
    s.backend!.join('ch_VC1', identity);
    await nextState(a, 'VC1');
    s.text.setBits(a.identity.userId, 'VC1', P.VIEW_CHANNEL | P.CONNECT_VOICE | P.VIDEO);
    s.text.emitChanged();
    await expect.poll(() => s.backend!.updates(identity).length).toBe(1);
    const p = s.backend!.updates(identity)[0]!;
    expect(p.canPublishSources).not.toContain(2);
    expect(p).toMatchObject({ canSubscribe: true, canPublish: true, canPublishData: false, canUpdateMetadata: false, hidden: false });
    s.text.emitChanged();
    await new Promise((r) => setTimeout(r, 50));
    expect(s.backend!.updates(identity)).toHaveLength(1); // unchanged bits: no call

    s.text.setBits(a.identity.userId, 'VC1', 0);
    await s.voice.refreshPermissions();
    expect(s.backend!.removals()).toContain(`ch_VC1/${identity}`);
    await a.waitEvent('voice.forceDisconnect');
    expect(s.voice.registry.assignedChannel(a.identity.userId)).toBeNull();
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

