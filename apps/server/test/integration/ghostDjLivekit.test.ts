import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AudioStream, Room, RoomEvent, TrackKind, dispose, type RemoteTrack } from '@livekit/rtc-node';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { InteractionEphemeralEvent, VoiceChannelState } from '@ghostlink/shared';
import { createAvatarsModule } from '../../src/avatars/index.js';
import { createBotsModule } from '../../src/bots/index.js';
import { FRAME_BYTES, createGhostDjModule, gainOf, type GhostDjModule, type PcmSource } from '../../src/ghostDj/index.js';
import { startSignalRelay, type SignalRelay } from '../../src/ghostDj/signalRelay.js';
import { resolveLivekitBinary } from '../../src/livekit/binary.js';
import type { ProxyEndpoint } from '../../src/modules.js';
import { createTextModule } from '../../src/text/index.js';
import { createVoiceModule, type VoiceModule } from '../../src/voice/index.js';
import { startTestServer, type TestServer } from '../helpers/testClient.js';
import { freeMediaPorts } from '../helpers/voice.js';
import { channelId, joinServer, type TextClient } from '../text/helpers.js';

// The Ghost DJ against the real livekit-server (spec §5): it joins as a participant and publishes;
// a real WebRTC participant (@livekit/rtc-node) hears it. A generated signal stands in for YouTube.
// Skipped when scripts/fetch-livekit.mjs has not installed the binary.
const binary = resolveLivekitBinary();
const RATE = 48_000;

const servers: TestServer[] = [];
const clients: TextClient[] = [];
const rooms: Room[] = [];
const relays: SignalRelay[] = [];
afterEach(async () => {
  for (const r of rooms.splice(0)) await r.disconnect().catch(() => {});
  for (const r of relays.splice(0)) await r.close();
  for (const c of clients.splice(0)) c.close();
  await Promise.all(servers.splice(0).map((s) => s.cleanup()));
});
afterAll(async () => {
  if (binary) await dispose();
});

/** Tones in each channel (Hz), 8 000 each: deep bass and treble on the left, mids and top treble on the right. */
const LEFT = [40, 10_000];
const RIGHT = [1_000, 15_000];
const AMPLITUDE = 8_000;

/** A stereo test signal, s16le 48 kHz, for as long as it is read. */
function signal(): PcmSource {
  let closed = false;
  let n = 0;
  const sum = (freqs: number[], i: number) => freqs.reduce((v, f) => v + Math.sin((2 * Math.PI * f * i) / RATE), 0);
  async function* frames(): AsyncGenerator<Buffer> {
    while (!closed) {
      const chunk = Buffer.alloc(FRAME_BYTES * 5);
      for (let i = 0; i < chunk.length / 4; i++, n++) {
        chunk.writeInt16LE(Math.round(AMPLITUDE * sum(LEFT, n)), i * 4);
        chunk.writeInt16LE(Math.round(AMPLITUDE * sum(RIGHT, n)), i * 4 + 2);
      }
      yield chunk;
    }
  }
  return { stream: frames(), close: () => void (closed = true), result: () => Promise.resolve(null) };
}

/**
 * The amplitude of `freq` (a multiple of 10 Hz) in one channel of interleaved stereo: the median
 * over 100 ms blocks, so a block the jitter buffer stretched or shrank does not count.
 */
function tone(pcm: Int16Array, channel: 0 | 1, freq: number): number {
  const block = RATE / 10;
  const amplitudes: number[] = [];
  for (let start = 0; start + block <= pcm.length / 2; start += block) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < block; i++) {
      const v = pcm[(start + i) * 2 + channel]!;
      re += v * Math.cos((2 * Math.PI * freq * i) / RATE);
      im -= v * Math.sin((2 * Math.PI * freq * i) / RATE);
    }
    amplitudes.push((2 * Math.hypot(re, im)) / block);
  }
  return amplitudes.sort((a, b) => a - b)[amplitudes.length >> 1]!;
}

const dB = (a: number, b: number) => 20 * Math.log10(a / b);

interface Env {
  t: TestServer;
  voice: VoiceModule;
  dj: GhostDjModule;
  owner: TextClient;
  sala: string;
  livekitPort: number;
}

async function djEnv(proxy?: ProxyEndpoint): Promise<Env> {
  const voice = createVoiceModule({ sweepIntervalMs: 3_600_000, reconcileIntervalMs: 3_600_000 });
  const dj = createGhostDjModule({
    ffmpeg: 'ffmpeg-not-used',
    ytdlp: false,
    resolve: async () => ({ ok: true, tracks: [{ id: 'toneToneTon', title: 'Tom de teste', url: 'https://www.youtube.com/watch?v=toneToneTon', durationSec: 60 }], playlistTitle: null, skipped: 0 }),
    openSource: () => signal(),
    disposeOnStop: false,
    panelDelayMs: 50,
  });
  const media = await freeMediaPorts();
  const t = await startTestServer({
    joinMode: 'open',
    proxy,
    modules: [createTextModule(), voice, createAvatarsModule(), createBotsModule(), dj],
    voice: proxy ? { binaryPath: binary! } : { binaryPath: binary!, nodeIp: '127.0.0.1', ...media },
    limits: { newIdentitiesPerIpPerHour: 1_000, requestsPerSecondPerSession: 10_000 },
  });
  servers.push(t);
  expect(await voice.whenReady()).toBe(true);
  const livekitPort = Number(/^port: (\d+)$/m.exec(readFileSync(join(t.dataDir, 'livekit.yaml'), 'utf8'))![1]);
  const owner = (await joinServer(t.server, { nickname: 'Dono', setupCode: t.server.setupCode()! })).client!;
  clients.push(owner);
  return { t, voice, dj, owner, sala: channelId(owner, 'Sala de voz'), livekitPort };
}

/**
 * The owner in the voice channel as a real participant (through `url`: LiveKit, or a relay),
 * then /play: resolves with the stereo PCM heard, once `seconds` of it are in.
 */
async function hear(e: Env, url: string, seconds: number): Promise<Int16Array> {
  const { token } = await e.owner.ok<{ token: string }>('voice.join', { channelId: e.sala });
  const room = new Room();
  rooms.push(room);
  const heard: Int16Array[] = [];
  let samples = 0;
  room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
    if (track.kind !== TrackKind.KIND_AUDIO) return;
    void (async () => {
      for await (const frame of new AudioStream(track, { sampleRate: RATE, numChannels: 2 })) {
        // From the first loud frame on.
        if (samples === 0 && !frame.data.some((v) => Math.abs(v) > 1_000)) continue;
        heard.push(new Int16Array(frame.data));
        samples += frame.data.length / 2;
      }
    })().catch(() => {});
  });
  await room.connect(url, token, { autoSubscribe: true, dynacast: false });
  await expect.poll(() => e.voice.registry.channelOf(e.owner.userId), { timeout: 10_000 }).toBe(e.sala);

  const { id } = await e.owner.ok<{ id: string }>('interaction.invoke', {
    channelId: channelId(e.owner, 'geral'),
    botId: e.dj.botId,
    command: 'play',
    options: [{ name: 'busca', value: 'tom de teste' }],
  });
  const answer = await e.owner.event<InteractionEphemeralEvent>('interaction.ephemeral', (x) => x.interactionId === id && x.content !== '', 15_000);
  expect(answer.content).toContain('Tocando agora');
  await e.owner.event<VoiceChannelState>('voice.state', (s) => s.channelId === e.sala && s.participants.some((p) => p.userId === e.dj.botId), 10_000);
  await expect.poll(() => samples, { timeout: 20_000 + seconds * 1_000, interval: 200 }).toBeGreaterThanOrEqual(seconds * RATE);
  const pcm = new Int16Array(seconds * RATE * 2);
  let at = 0;
  for (const f of heard) {
    if (at >= pcm.length) break;
    pcm.set(f.subarray(0, pcm.length - at), at);
    at += f.length;
  }
  return pcm;
}

async function stop(e: Env): Promise<void> {
  await e.owner.ok('interaction.invoke', { channelId: channelId(e.owner, 'geral'), botId: e.dj.botId, command: 'stop', options: [] });
  await e.owner.event<VoiceChannelState>('voice.state', (s) => s.channelId === e.sala && !s.participants.some((p) => p.userId === e.dj.botId), 10_000);
}

describe.skipIf(!binary)('Ghost DJ with the real LiveKit', () => {
  it('someone in the channel hears it in stereo, bass to treble, with no gaps (v0.5.1: it was mono, in Opus voice mode)', async () => {
    const e = await djEnv();
    const pcm = await hear(e, `ws://127.0.0.1:${e.livekitPort}`, 4);
    // The first second settles (jitter buffer); the next three are measured.
    const steady = pcm.subarray(RATE * 2);
    const sent = AMPLITUDE * gainOf(50);
    // Stereo: each side carries its own tones, and almost nothing of the other side's.
    for (const [ch, own, other] of [[0, LEFT, RIGHT], [1, RIGHT, LEFT]] as const) {
      for (const f of own) expect(Math.abs(dB(tone(steady, ch, f), sent)), `${f} Hz in channel ${ch}`).toBeLessThan(1.5);
      for (const f of other) expect(dB(tone(steady, ch, f), sent), `${f} Hz leaking into channel ${ch}`).toBeLessThan(-30);
    }
    // No gaps: every 10 ms holds the signal (a concealed or missing packet drops the level).
    const levels: number[] = [];
    for (let i = 0; i + 960 <= steady.length; i += 960) {
      let sum = 0;
      for (let j = i; j < i + 960; j++) sum += steady[j]! ** 2;
      levels.push(Math.sqrt(sum / 960));
    }
    const median = [...levels].sort((a, b) => a - b)[levels.length >> 1]!;
    expect(levels.filter((l) => l < median * 0.5)).toEqual([]);
    await stop(e);
  }, 60_000);
});

// Behind a TCP proxy LiveKit announces only the proxy's address. Here that address leads nowhere
// (TEST-NET-1), so the DJ, and the listener through its own relay, are heard only if the relay's
// loopback candidates work. Linux only: Windows will not connect a LAN-bound socket to loopback
// (the DJ then keeps using the proxy, as before), and macOS has no LiveKit binary.
describe.runIf(binary && process.platform === 'linux')('Ghost DJ behind a TCP proxy, real LiveKit', () => {
  it('reaches LiveKit inside the machine instead of going out to the proxy and back', async () => {
    const external = (await freeMediaPorts()).tcpPort;
    const e = await djEnv({ host: '192.0.2.1', port: external });
    const relay = await startSignalRelay({ target: `ws://127.0.0.1:${e.livekitPort}`, icePort: external });
    relays.push(relay);
    const pcm = await hear(e, relay.url, 1);
    expect(Math.abs(dB(tone(pcm, 1, 1_000), AMPLITUDE * gainOf(50)))).toBeLessThan(3);
    expect(relay.changed.candidates).toBeGreaterThan(0);
    await stop(e);
  }, 60_000);
});
