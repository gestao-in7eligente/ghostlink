// Voice behind a TCP proxy with the real livekit-server (spec §8.6): LiveKit must accept the
// proxy config in strict mode, listen for ICE-TCP on the proxy's external port, and get what a
// "fake Railway" forwards to the server's public port. Skipped without the LiveKit binary.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect as netConnect, type Socket } from 'node:net';
import { join } from 'node:path';
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource as RtcTrackSource,
  dispose,
  type RemoteTrack,
} from '@livekit/rtc-node';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { ResErr, ResOk } from '@ghostlink/shared';
import { resolveLivekitBinary } from '../../src/livekit/binary.js';
import type { ProxyEndpoint } from '../../src/modules.js';
import { localIPv4Addresses } from '../../src/net/addresses.js';
import { createVoiceModule, type VoiceModule } from '../../src/voice/index.js';
import { FakeTcpProxy } from '../helpers/fakeProxy.js';
import { connectTestClient, startTestServer, type TestClient, type TestServer } from '../helpers/testClient.js';
import { StubText, freeMediaPorts } from '../helpers/voice.js';

const binary = resolveLivekitBinary();

const cleanups: Array<() => unknown> = [];
const clients: TestClient[] = [];
const rooms: Room[] = [];
afterEach(async () => {
  for (const r of rooms.splice(0)) await r.disconnect().catch(() => {});
  for (const c of clients.splice(0)) c.close();
  for (const c of cleanups.splice(0).reverse()) await c();
});
afterAll(async () => {
  if (binary) await dispose();
});

interface Env {
  t: TestServer;
  voice: VoiceModule;
  yaml: string;
  livekitPort: number;
  client(nickname: string): Promise<TestClient>;
}

async function env(proxy: ProxyEndpoint): Promise<Env> {
  const text = new StubText();
  text.channels.set('VC1', { type: 'voice', userLimit: 0 });
  const voice = createVoiceModule({ sweepIntervalMs: 3_600_000, reconcileIntervalMs: 3_600_000 });
  const logs: string[] = [];
  const keep = (m: string, meta?: Record<string, unknown>) => void logs.push(`${m} ${JSON.stringify(meta ?? {})}`);
  const t = await startTestServer({
    joinMode: 'open',
    proxy,
    modules: [text, voice],
    logger: { info: keep, warn: keep, error: keep },
    voice: { binaryPath: binary! },
  });
  cleanups.push(() => t.cleanup());
  expect(await voice.whenReady(), `LiveKit did not start: ${logs.join(' / ')}`).toBe(true);
  const yaml = readFileSync(join(t.dataDir, 'livekit.yaml'), 'utf8');
  return {
    t,
    voice,
    yaml,
    livekitPort: Number(/^port: (\d+)$/m.exec(yaml)![1]),
    client: async (nickname) => {
      const c = await connectTestClient(t.server, { nickname });
      clients.push(c);
      return c;
    },
  };
}

async function fakeRailway(target: number, port?: number, host?: string): Promise<FakeTcpProxy> {
  const proxy = await new FakeTcpProxy(target).listen(port, host);
  cleanups.push(() => proxy.close());
  return proxy;
}

function ok<T>(res: ResOk | ResErr): T {
  if (!res.ok) throw new Error(`expected success, got ${res.error.code}`);
  return res.d as T;
}

/** An RFC 4571 frame holding a STUN binding request with this USERNAME (no integrity: only the mux reads it). */
function stunFrame(username: string): Buffer {
  const user = Buffer.from(username);
  const attr = Buffer.alloc(4 + Math.ceil(user.length / 4) * 4);
  attr.writeUInt16BE(0x0006, 0); // USERNAME
  attr.writeUInt16BE(user.length, 2);
  user.copy(attr, 4);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(0x0001, 0); // Binding Request
  header.writeUInt16BE(attr.length, 2);
  header.writeUInt32BE(0x2112a442, 4); // magic cookie
  randomBytes(12).copy(header, 8);
  const message = Buffer.concat([header, attr]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(message.length);
  return Buffer.concat([length, message]);
}

function tcp(port: number, host = '127.0.0.1'): Promise<{ socket: Socket; closed: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ port, host });
    cleanups.push(() => socket.destroy());
    socket.on('error', () => {});
    socket.once('connect', () => resolve({ socket, closed: new Promise((r) => socket.once('close', () => r())) }));
    socket.once('close', () => reject(new Error('closed before connecting')));
  });
}

const openAfter = (closed: Promise<void>, ms: number): Promise<boolean> =>
  Promise.race([closed.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), ms))]);

describe.skipIf(!binary)('voice behind a TCP proxy, real LiveKit (spec §8.6)', () => {
  it('boots in strict mode with ICE-TCP only on the external port, and gets the ICE-TCP a fake Railway forwards', async () => {
    const external = (await freeMediaPorts()).tcpPort;
    const e = await env({ host: '127.0.0.1', port: external });
    expect(e.yaml).toContain(`tcp_port: ${external}`);
    expect(e.yaml).toContain('force_tcp: true');
    expect(e.yaml).toContain('node_ip: "127.0.0.1"');
    expect(e.yaml).not.toContain('udp_port');
    expect(e.voice.iceTcpPort?.()).toBe(external);

    // "Railway": another port, forwarded to the server's public port.
    const railway = await fakeRailway(e.t.server.port);
    // TLS through it, pin included.
    const ana = await connectTestClient({ ...e.t.server, port: railway.port }, { nickname: 'ana' });
    clients.push(ana);
    expect(ok<{ token: string }>(await ana.request('voice.join', { channelId: 'VC1' })).token).toBeTruthy();

    // ICE-TCP through it reaches LiveKit's TCP mux: a binding request for an unknown ufrag is
    // parsed and kept (pion holds it 30 s for its ICE agent), a frame that is not STUN is dropped.
    const held = await tcp(railway.port);
    held.socket.write(stunFrame('nobody0000000000:client'));
    const garbage = await tcp(railway.port);
    garbage.socket.write(Buffer.from([0x00, 0x08, 1, 2, 3, 4, 5, 6, 7, 8]));
    await garbage.closed;
    expect(await openAfter(held.closed, 1_500)).toBe(true);
    expect(railway.iceConnections).toHaveLength(2);
  }, 60_000);
});

// Real WebRTC over ICE-TCP only, through the fake Railway. The proxy's "external" address is
// this machine's LAN IP at LiveKit's port: Windows lets the forwarder hold that one address
// next to LiveKit's wildcard listener on the same port (the more specific binding wins), so
// LiveKit's only candidate, <LAN IP>:<port>, leads to the forwarder. Linux refuses that bind,
// hence Windows only (the Windows CI runner and the e2e run cover it).
const lan = localIPv4Addresses().find((a) => a.kind === 'lan') ?? localIPv4Addresses().find((a) => a.kind !== 'virtual');

describe.runIf(binary && process.platform === 'win32' && lan)('voice behind a TCP proxy, real WebRTC (spec §8.6)', () => {
  it('two participants hear each other over ICE-TCP alone, through the fake Railway and the public port', async () => {
    const external = (await freeMediaPorts()).tcpPort;
    const e = await env({ host: lan!.ip, port: external });
    expect(e.voice.nodeIp).toBe(lan!.ip);
    const railway = await fakeRailway(e.t.server.port, external, lan!.ip);

    const ana = await e.client('ana');
    const bia = await e.client('bia');
    const anaToken = ok<{ token: string }>(await ana.request('voice.join', { channelId: 'VC1' })).token;
    const biaToken = ok<{ token: string }>(await bia.request('voice.join', { channelId: 'VC1' })).token;
    // rtc-node cannot pin our TLS key, so its signaling goes to LiveKit's loopback port; the
    // media still has one way only: LiveKit's candidate, i.e. the fake Railway.
    const speaker = new Room();
    const listener = new Room();
    rooms.push(speaker, listener);
    let loudFrames = 0;
    listener.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind !== TrackKind.KIND_AUDIO) return;
      void (async () => {
        for await (const frame of new AudioStream(track)) {
          if (frame.data.some((v) => Math.abs(v) > 1_000)) loudFrames++;
          if (loudFrames >= 25) break;
        }
      })();
    });
    await speaker.connect(`ws://127.0.0.1:${e.livekitPort}`, anaToken, { autoSubscribe: false, dynacast: false });
    await listener.connect(`ws://127.0.0.1:${e.livekitPort}`, biaToken, { autoSubscribe: true, dynacast: false });

    const source = new AudioSource(48_000, 1);
    const options = new TrackPublishOptions();
    options.source = RtcTrackSource.SOURCE_MICROPHONE;
    await speaker.localParticipant!.publishTrack(LocalAudioTrack.createAudioTrack('mic', source), options);
    const tone = new Int16Array(480);
    for (let i = 0; i < tone.length; i++) tone[i] = Math.round(8_000 * Math.sin((2 * Math.PI * 440 * i) / 48_000));
    const deadline = Date.now() + 20_000;
    while (loudFrames < 25 && Date.now() < deadline) await source.captureFrame(new AudioFrame(tone, 48_000, 1, 480));

    expect(loudFrames).toBeGreaterThanOrEqual(25);
    // The media itself came back through the fake Railway: LiveKit answered both peers over
    // those ICE-TCP connections (STUN, DTLS, then SRTP). A connection LiveKit did not match to
    // its ICE agent gets no answer at all, and LiveKit has no UDP socket to go around it.
    // Over 1 kB down is more than STUN answers alone (the DTLS flight with the certificate);
    // the speaker's side stays small (RTCP only), so a higher bar fails under load.
    const answered = railway.iceConnections.filter((c) => c.down > 1_000);
    expect(answered.length, JSON.stringify(railway.connections)).toBeGreaterThanOrEqual(2);
  }, 90_000);
});
