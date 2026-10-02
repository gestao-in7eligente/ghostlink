import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource as RtcTrackSource,
  dispose,
} from '@livekit/rtc-node';
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PERMISSIONS, type ResErr, type ResOk, type VoiceChannelState } from '@ghostlink/shared';
import { resolveLivekitBinary } from '../../src/livekit/binary.js';
import { createVoiceModule, type VoiceModule } from '../../src/voice/index.js';
import { connectTestClient, startTestServer, type TestClient, type TestServer } from '../helpers/testClient.js';
import { StubText, freeMediaPorts } from '../helpers/voice.js';

// spec §14 "Integração LiveKit": the real livekit-server and real WebRTC participants
// (@livekit/rtc-node). Skipped when scripts/fetch-livekit.mjs has not installed the binary.
const binary = resolveLivekitBinary();
const P = PERMISSIONS;

const servers: TestServer[] = [];
const clients: TestClient[] = [];
const rooms: Room[] = [];
afterEach(async () => {
  for (const r of rooms.splice(0)) await r.disconnect().catch(() => {});
  for (const c of clients.splice(0)) c.close();
  await Promise.all(servers.splice(0).map((s) => s.cleanup()));
});
afterAll(async () => {
  if (binary) await dispose();
});

interface Env {
  t: TestServer;
  text: StubText;
  voice: VoiceModule;
  livekitPort: number;
  rs: RoomServiceClient;
  keys: { apiKey: string; apiSecret: string };
  client(nickname: string): Promise<TestClient>;
}

async function env(): Promise<Env> {
  const text = new StubText();
  text.channels.set('VC1', { type: 'voice', userLimit: 0 });
  text.channels.set('VC2', { type: 'voice', userLimit: 0 });
  const voice = createVoiceModule({ sweepIntervalMs: 3_600_000, reconcileIntervalMs: 3_600_000 });
  const logs: string[] = [];
  const keep = (m: string, meta?: Record<string, unknown>) => void logs.push(`${m} ${JSON.stringify(meta ?? {})}`);
  const t = await startTestServer({
    joinMode: 'open',
    modules: [text, voice],
    logger: { info: keep, warn: keep, error: keep },
    voice: { binaryPath: binary!, nodeIp: '127.0.0.1', ...(await freeMediaPorts()) },
  });
  servers.push(t);
  expect(await voice.whenReady(), `LiveKit did not start: ${logs.join(' / ')}`).toBe(true);
  const livekitPort = Number(/^port: (\d+)$/m.exec(readFileSync(join(t.dataDir, 'livekit.yaml'), 'utf8'))![1]);
  const keys = JSON.parse(readFileSync(join(t.dataDir, 'livekit-keys.json'), 'utf8')) as { apiKey: string; apiSecret: string };
  return {
    t,
    text,
    voice,
    livekitPort,
    keys,
    rs: new RoomServiceClient(`http://127.0.0.1:${livekitPort}`, keys.apiKey, keys.apiSecret),
    client: async (nickname) => {
      const c = await connectTestClient(t.server, { nickname });
      clients.push(c);
      return c;
    },
  };
}

function ok<T>(res: ResOk | ResErr): T {
  if (!res.ok) throw new Error(`expected success, got ${res.error.code}`);
  return res.d as T;
}

/** A real WebRTC participant. rtc-node cannot pin our self-signed TLS key, so it talks to LiveKit's loopback port directly. */
async function participant(e: Env, token: string): Promise<Room> {
  const room = new Room();
  rooms.push(room);
  await room.connect(`ws://127.0.0.1:${e.livekitPort}`, token, { autoSubscribe: false, dynacast: false });
  return room;
}

async function publishMicrophone(room: Room): Promise<AudioSource> {
  const source = new AudioSource(48_000, 1);
  const options = new TrackPublishOptions();
  options.source = RtcTrackSource.SOURCE_MICROPHONE;
  await room.localParticipant!.publishTrack(LocalAudioTrack.createAudioTrack('mic', source), options);
  const silence = new AudioFrame(new Int16Array(480), 48_000, 1, 480);
  for (let i = 0; i < 20; i++) await source.captureFrame(silence);
  return source;
}

async function nextState(c: TestClient, channelId: string, until: (s: VoiceChannelState) => boolean, timeoutMs = 10_000): Promise<VoiceChannelState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const d = (await c.waitEvent('voice.state', Math.max(1, deadline - Date.now()))).d as VoiceChannelState;
    if (d.channelId === channelId && until(d)) return d;
  }
}

/** GET /rtc/validate through the proxy (the v1 route also wants a join_request; v0 needs only the token). */
function validate(port: number, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path: `/rtc/validate?access_token=${token}`, rejectUnauthorized: false }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }).on('error', reject).end();
  });
}

describe.skipIf(!binary)('voice with the real LiveKit', () => {
  it('tokens carry the right sources, as LiveKit itself reports them', async () => {
    const e = await env();
    const ana = await e.client('ana');
    const bia = await e.client('bia');
    e.text.setBits(bia.identity.userId, 'VC1', P.VIEW_CHANNEL | P.CONNECT_VOICE | P.SPEAK);
    await participant(e, ok<{ token: string }>(await ana.request('voice.join', { channelId: 'VC1' })).token);
    await participant(e, ok<{ token: string }>(await bia.request('voice.join', { channelId: 'VC1' })).token);
    const list = await e.rs.listParticipants('ch_VC1');
    const byId = new Map(list.map((p) => [p.identity, p]));
    expect(byId.get(`u_${ana.identity.userId}`)!.permission).toMatchObject({
      canSubscribe: true,
      canPublish: true,
      canPublishData: false,
      canPublishSources: [TrackSource.MICROPHONE, TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
    });
    expect(byId.get(`u_${bia.identity.userId}`)!.permission!.canPublishSources).toEqual([TrackSource.MICROPHONE]);
    expect(byId.get(`u_${bia.identity.userId}`)!.name).toBe('bia');
  });

  it('webhooks update voice.state for watchers, on join and on leave', async () => {
    const e = await env();
    const ana = await e.client('ana');
    const watcher = await e.client('watcher');
    const room = await participant(e, ok<{ token: string }>(await ana.request('voice.join', { channelId: 'VC1' })).token);
    const joined = await nextState(watcher, 'VC1', (s) => s.participants.length === 1);
    expect(joined.participants[0]).toMatchObject({ userId: ana.identity.userId, serverMuted: false });
    await publishMicrophone(room);
    await expect.poll(() => e.voice.registry.hasMicrophone(ana.identity.userId), { timeout: 10_000 }).toBe(true);
    await room.disconnect();
    await nextState(watcher, 'VC1', (s) => s.participants.length === 0);
  });

  it('a server mute takes the microphone off the air and LiveKit refuses to republish it', async () => {
    const e = await env();
    const ana = await e.client('ana');
    const mod = await e.client('mod');
    e.text.setBits(mod.identity.userId, 'VC1', e.text.defaultBits | P.MUTE_MEMBERS);
    e.text.positions.set(mod.identity.userId, 5);
    const room = await participant(e, ok<{ token: string }>(await ana.request('voice.join', { channelId: 'VC1' })).token);
    await publishMicrophone(room);
    await expect.poll(() => e.voice.registry.hasMicrophone(ana.identity.userId), { timeout: 10_000 }).toBe(true);

    ok(await mod.request('voice.moderate', { userId: ana.identity.userId, action: 'mute' }));
    await expect.poll(async () => (await e.rs.listParticipants('ch_VC1'))[0]?.tracks.length, { timeout: 10_000 }).toBe(0);
    await expect.poll(() => e.voice.registry.hasMicrophone(ana.identity.userId), { timeout: 10_000 }).toBe(false);
    await expect(publishMicrophone(room)).rejects.toThrow();

    ok(await mod.request('voice.moderate', { userId: ana.identity.userId, action: 'unmute' }));
    await expect.poll(async () => (await e.rs.listParticipants('ch_VC1'))[0]?.permission?.canPublishSources, { timeout: 10_000 }).toContain(TrackSource.MICROPHONE);
    await publishMicrophone(room);
    await expect.poll(() => e.voice.registry.hasMicrophone(ana.identity.userId), { timeout: 10_000 }).toBe(true);
  });

  it('a server deafen cuts the sound in place and refuses new subscriptions until undeafen', async () => {
    const e = await env();
    const ana = await e.client('ana');
    const bia = await e.client('bia');
    const mod = await e.client('mod');
    e.text.setBits(mod.identity.userId, 'VC1', e.text.defaultBits | P.MUTE_MEMBERS);
    e.text.positions.set(mod.identity.userId, 5);
    const listener = await participant(e, ok<{ token: string }>(await ana.request('voice.join', { channelId: 'VC1' })).token);
    const speaker = await participant(e, ok<{ token: string }>(await bia.request('voice.join', { channelId: 'VC1' })).token);
    // Ana hears Bia's tone while frames with sound reach her.
    let heardAt = 0;
    listener.on(RoomEvent.TrackSubscribed, (track) => {
      void (async () => {
        for await (const frame of new AudioStream(track)) if (frame.data.some((v) => Math.abs(v) > 2_000)) heardAt = Date.now();
      })().catch(() => {});
    });
    const hearing = () => Date.now() - heardAt < 300;
    // Subscriptions by hand, as the app makes them (autoSubscribe off).
    const subscribe = () => {
      for (const p of listener.remoteParticipants.values()) for (const pub of p.trackPublications.values()) pub.setSubscribed(true);
    };
    const source = new AudioSource(48_000, 1);
    const options = new TrackPublishOptions();
    options.source = RtcTrackSource.SOURCE_MICROPHONE;
    await speaker.localParticipant!.publishTrack(LocalAudioTrack.createAudioTrack('mic', source), options);
    const tone = Int16Array.from({ length: 480 }, (_, i) => Math.round(8_000 * Math.sin((2 * Math.PI * 440 * i) / 48_000)));
    let speaking = true;
    void (async () => {
      while (speaking) await source.captureFrame(new AudioFrame(tone, 48_000, 1, 480));
    })().catch(() => {});
    try {
      await expect.poll(() => (subscribe(), hearing()), { timeout: 15_000 }).toBe(true);

      ok(await mod.request('voice.moderate', { userId: ana.identity.userId, action: 'deafen' }));
      await expect.poll(async () => (await e.rs.listParticipants('ch_VC1')).find((p) => p.identity === `u_${ana.identity.userId}`)?.permission?.canSubscribe, { timeout: 10_000 }).toBe(false);
      await expect.poll(hearing, { timeout: 10_000 }).toBe(false);
      subscribe();
      await new Promise((r) => setTimeout(r, 1_500));
      expect(hearing()).toBe(false);

      ok(await mod.request('voice.moderate', { userId: ana.identity.userId, action: 'undeafen' }));
      await expect.poll(() => (subscribe(), hearing()), { timeout: 15_000 }).toBe(true);
    } finally {
      speaking = false;
    }
  });

  it('a server mute before the user reaches LiveKit is applied when they arrive, though their token allows the microphone', async () => {
    const e = await env();
    const ana = await e.client('ana');
    const mod = await e.client('mod');
    e.text.setBits(mod.identity.userId, 'VC1', e.text.defaultBits | P.MUTE_MEMBERS);
    e.text.positions.set(mod.identity.userId, 5);
    const { token } = ok<{ token: string }>(await ana.request('voice.join', { channelId: 'VC1' }));
    ok(await mod.request('voice.moderate', { userId: ana.identity.userId, action: 'mute' }));

    const room = await participant(e, token);
    await expect
      .poll(async () => (await e.rs.listParticipants('ch_VC1'))[0]?.permission?.canPublishSources, { timeout: 10_000 })
      .toEqual([TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO]);
    await expect(publishMicrophone(room)).rejects.toThrow();
  });

  it('removeParticipant plus the proxy keep a disconnected user out, though LiveKit alone would let them back', async () => {
    const e = await env();
    const ana = await e.client('ana');
    const mod = await e.client('mod');
    e.text.setBits(mod.identity.userId, 'VC1', e.text.defaultBits | P.MOVE_MEMBERS);
    e.text.positions.set(mod.identity.userId, 5);
    const { token } = ok<{ token: string }>(await ana.request('voice.join', { channelId: 'VC1' }));
    const port = e.t.server.port;

    // Through the proxy, the real LiveKit answers the WebSocket join with its binary JoinResponse.
    const first = await new Promise<Buffer>((resolve, reject) => {
      const ws = new WebSocket(`wss://127.0.0.1:${port}/rtc?access_token=${token}`, { rejectUnauthorized: false });
      ws.once('message', (data) => {
        resolve(data as Buffer);
        ws.close();
      });
      ws.once('error', reject);
    });
    expect(first.length).toBeGreaterThan(0);
    await expect.poll(async () => (await e.rs.listParticipants('ch_VC1')).length, { timeout: 5_000 }).toBe(0);

    const room = await participant(e, token);
    const disconnected = new Promise<void>((r) => room.once(RoomEvent.Disconnected, () => r()));
    expect(await validate(port, token)).toBe(200);
    ok(await mod.request('voice.moderate', { userId: ana.identity.userId, action: 'disconnect' }));
    await disconnected;
    await ana.waitEvent('voice.forceDisconnect');
    expect(await validate(port, token)).toBe(403);
    const refused = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`wss://127.0.0.1:${port}/rtc/v1?access_token=${token}`, { rejectUnauthorized: false });
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.once('open', () => resolve(101));
      ws.on('error', () => {});
    });
    expect(refused).toBe(403);
    // LiveKit OSS does not revoke tokens: straight to its (loopback-only) port the same token is
    // still accepted — which is why the proxy exists. Even then, the webhook check throws it out.
    const bypass = new Room();
    rooms.push(bypass);
    const thrownOut = new Promise<void>((r) => bypass.once(RoomEvent.Disconnected, () => r()));
    await bypass.connect(`ws://127.0.0.1:${e.livekitPort}`, token, { autoSubscribe: false, dynacast: false });
    await thrownOut;
    await expect.poll(async () => (await e.rs.listParticipants('ch_VC1')).length, { timeout: 5_000 }).toBe(0);
  });

  it('the proxy lets no second credential reach LiveKit: no Authorization header, nothing after a refused upgrade', async () => {
    const e = await env();
    const ana = await e.client('ana');
    const bia = await e.client('bia');
    const { token } = ok<{ token: string }>(await ana.request('voice.join', { channelId: 'VC1' }));
    // Correctly signed, for a user the server never assigned to VC2: LiveKit alone accepts it.
    const rogue = new AccessToken(e.keys.apiKey, e.keys.apiSecret, { identity: `u_${bia.identity.userId}`, ttl: 60 });
    rogue.addGrant({ roomJoin: true, room: 'ch_VC2', canSubscribe: true });
    const rogueJwt = await rogue.toJwt();
    const port = e.t.server.port;

    // LiveKit prefers `Authorization: Bearer` over the access_token the proxy authorized.
    const withHeader = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`wss://127.0.0.1:${port}/rtc?access_token=${token}`, { rejectUnauthorized: false, headers: { Authorization: `Bearer ${rogueJwt}` } });
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.once('open', () => {
        resolve(101);
        ws.close();
      });
      ws.on('error', () => {});
    });
    expect(withHeader).toBe(403);

    // /rtc/v1 without join_request: authorized by the proxy, refused by LiveKit (400) on a kept-alive connection.
    const socket = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false });
    let received = '';
    let closed = false;
    socket.on('data', (d: Buffer) => (received += d.toString('latin1')));
    socket.on('close', () => (closed = true));
    socket.on('error', () => {});
    const handshake = (path: string) =>
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`;
    socket.write(handshake(`/rtc/v1?access_token=${token}`));
    await expect.poll(() => received, { timeout: 5_000 }).toMatch(/^HTTP\/1\.1 400 /);
    socket.write(handshake(`/rtc?access_token=${rogueJwt}`));
    await expect.poll(() => closed || / 101 /.test(received), { timeout: 5_000 }).toBe(true);
    expect(received).not.toMatch(/ 101 /);
    socket.destroy();
  });

  it('reconciliation rebuilds the map and removes whoever the server did not assign', async () => {
    const e = await env();
    const ana = await e.client('ana');
    const bia = await e.client('bia');
    await participant(e, ok<{ token: string }>(await ana.request('voice.join', { channelId: 'VC1' })).token);
    await expect.poll(() => e.voice.registry.presentIn('VC1'), { timeout: 10_000 }).toEqual([ana.identity.userId]);

    // A token minted outside voice.join (bia was never assigned): LiveKit accepts it, voice throws her out.
    const rogue = new AccessToken(e.keys.apiKey, e.keys.apiSecret, { identity: `u_${bia.identity.userId}`, ttl: 60 });
    rogue.addGrant({ roomJoin: true, room: 'ch_VC1', canSubscribe: true });
    const rogueRoom = await participant(e, await rogue.toJwt());
    const kicked = new Promise<void>((r) => rogueRoom.once(RoomEvent.Disconnected, () => r()));
    await kicked;

    e.voice.registry.replacePresence(new Map()); // as if every webhook had been lost
    expect(e.voice.registry.presentIn('VC1')).toEqual([]);
    await e.voice.reconcile();
    expect(e.voice.registry.presentIn('VC1')).toEqual([ana.identity.userId]);
    expect((await e.rs.listParticipants('ch_VC1')).map((p) => p.identity)).toEqual([`u_${ana.identity.userId}`]);
  });
});
