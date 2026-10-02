import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AudioStream, Room, RoomEvent, dispose } from '@livekit/rtc-node';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { InteractionEphemeralEvent, VoiceChannelState } from '@ghostlink/shared';
import { createAvatarsModule } from '../../src/avatars/index.js';
import { createBotsModule } from '../../src/bots/index.js';
import { FRAME_BYTES, createGhostDjModule, type PcmSource } from '../../src/ghostDj/index.js';
import { resolveLivekitBinary } from '../../src/livekit/binary.js';
import { createTextModule } from '../../src/text/index.js';
import { createVoiceModule } from '../../src/voice/index.js';
import { startTestServer, type TestServer } from '../helpers/testClient.js';
import { freeMediaPorts } from '../helpers/voice.js';
import { channelId, joinServer, type TextClient } from '../text/helpers.js';

// The Ghost DJ against the real livekit-server (spec §5): it joins as a participant and publishes;
// a real WebRTC participant (@livekit/rtc-node) hears it. A generated tone stands in for YouTube.
// Skipped when scripts/fetch-livekit.mjs has not installed the binary.
const binary = resolveLivekitBinary();

const servers: TestServer[] = [];
const clients: TextClient[] = [];
const rooms: Room[] = [];
afterEach(async () => {
  for (const r of rooms.splice(0)) await r.disconnect().catch(() => {});
  for (const c of clients.splice(0)) c.close();
  await Promise.all(servers.splice(0).map((s) => s.cleanup()));
});
afterAll(async () => {
  if (binary) await dispose();
});

/** 440 Hz in both channels, s16le 48 kHz, for as long as it is read. */
function tone(): PcmSource {
  let closed = false;
  let n = 0;
  async function* frames(): AsyncGenerator<Buffer> {
    while (!closed) {
      const chunk = Buffer.alloc(FRAME_BYTES * 5);
      for (let i = 0; i < chunk.length / 4; i++, n++) {
        const v = Math.round(16_000 * Math.sin((2 * Math.PI * 440 * n) / 48_000));
        chunk.writeInt16LE(v, i * 4);
        chunk.writeInt16LE(v, i * 4 + 2);
      }
      yield chunk;
    }
  }
  return {
    stream: frames(),
    close: () => void (closed = true),
    result: () => Promise.resolve(null),
  };
}

describe.skipIf(!binary)('Ghost DJ with the real LiveKit', () => {
  it('joins the channel as a participant and someone in it hears what it plays', async () => {
    const voice = createVoiceModule({ sweepIntervalMs: 3_600_000, reconcileIntervalMs: 3_600_000 });
    const dj = createGhostDjModule({
      ffmpeg: 'ffmpeg-not-used',
      ytdlp: false,
      resolve: async () => ({ ok: true, tracks: [{ id: 'toneToneTon', title: 'Tom de teste', url: 'https://www.youtube.com/watch?v=toneToneTon', durationSec: 60 }], playlistTitle: null, skipped: 0 }),
      openSource: () => tone(),
      disposeOnStop: false,
      panelDelayMs: 50,
    });
    const t = await startTestServer({
      joinMode: 'open',
      modules: [createTextModule(), voice, createAvatarsModule(), createBotsModule(), dj],
      voice: { binaryPath: binary!, nodeIp: '127.0.0.1', ...(await freeMediaPorts()) },
      limits: { newIdentitiesPerIpPerHour: 1_000, requestsPerSecondPerSession: 10_000 },
    });
    servers.push(t);
    expect(await voice.whenReady()).toBe(true);
    const livekitPort = Number(/^port: (\d+)$/m.exec(readFileSync(join(t.dataDir, 'livekit.yaml'), 'utf8'))![1]);
    const joined = await joinServer(t.server, { nickname: 'Dono', setupCode: t.server.setupCode()! });
    const owner = joined.client!;
    clients.push(owner);
    const sala = channelId(owner, 'Sala de voz');

    // The owner in the voice channel, as the app connects: a real participant, subscribing by hand.
    const { token } = await owner.ok<{ token: string }>('voice.join', { channelId: sala });
    const room = new Room();
    rooms.push(room);
    let loudFrames = 0;
    room.on(RoomEvent.TrackSubscribed, (track) => {
      void (async () => {
        for await (const frame of new AudioStream(track)) if (frame.data.some((v) => Math.abs(v) > 1_000)) loudFrames++;
      })().catch(() => {});
    });
    await room.connect(`ws://127.0.0.1:${livekitPort}`, token, { autoSubscribe: false, dynacast: false });
    await expect.poll(() => voice.registry.channelOf(owner.userId), { timeout: 10_000 }).toBe(sala);

    const { id } = await owner.ok<{ id: string }>('interaction.invoke', {
      channelId: channelId(owner, 'geral'),
      botId: dj.botId,
      command: 'play',
      options: [{ name: 'busca', value: 'tom de teste' }],
    });
    const answer = await owner.event<InteractionEphemeralEvent>('interaction.ephemeral', (e) => e.interactionId === id && e.content !== '', 15_000);
    expect(answer.content).toContain('Tocando agora');
    await owner.event<VoiceChannelState>('voice.state', (s) => s.channelId === sala && s.participants.some((p) => p.userId === dj.botId), 10_000);

    const subscribe = () => {
      for (const p of room.remoteParticipants.values()) for (const pub of p.trackPublications.values()) pub.setSubscribed(true);
    };
    await expect.poll(() => (subscribe(), loudFrames), { timeout: 15_000 }).toBeGreaterThan(10);

    await owner.ok('interaction.invoke', { channelId: channelId(owner, 'geral'), botId: dj.botId, command: 'stop', options: [] });
    await owner.event<VoiceChannelState>('voice.state', (s) => s.channelId === sala && !s.participants.some((p) => p.userId === dj.botId), 10_000);
  }, 60_000);
});
