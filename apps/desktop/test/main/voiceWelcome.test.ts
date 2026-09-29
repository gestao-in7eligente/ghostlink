import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { voiceJoinResponseSchemaClient, voiceWelcomeSchemaClient, type Envelope } from '@ghostlink/shared';
import { createVoiceModule } from '../../../server/src/voice/index.js';
import { startTestServer, type TestServer } from '../../../server/test/helpers/testClient.js';
import { FakeBackend, StubText } from '../../../server/test/helpers/voice.js';
import { ClientController } from '../../src/main/controller.js';
import { IdentityStore } from '../../src/main/identity.js';
import { SavedServersStore } from '../../src/main/savedServers.js';
import { SettingsStore } from '../../src/main/settings.js';
import { FakeSafeStorage } from '../helpers/fakeSafeStorage.js';
import { waitFor } from '../helpers/net.js';
import { useTempDir } from '../helpers/tempDir.js';

const dir = useTempDir();
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

let controller: ClientController;
let events: Envelope[];

beforeEach(() => {
  const identity = IdentityStore.load(dir.path, new FakeSafeStorage());
  identity.create();
  events = [];
  controller = new ClientController({
    identity,
    settings: SettingsStore.load(dir.path, 'pt-BR'),
    servers: SavedServersStore.load(dir.path),
    setRendererPin: async () => {},
    emitConnectionState: () => {},
    emitServerEvent: (e) => events.push(e),
    clientName: 'ghostlink/0.1.0 (test)',
  });
  cleanups.push(() => controller.disconnect());
});

async function voiceServer(): Promise<{ t: TestServer; backend: FakeBackend }> {
  const text = new StubText();
  text.channels.set('VC1', { type: 'voice', userLimit: 0 });
  const backend = new FakeBackend();
  const voice = createVoiceModule({ backend: () => backend, sweepIntervalMs: 3_600_000, reconcileIntervalMs: 3_600_000 });
  const t = await startTestServer({ joinMode: 'open', modules: [text, voice], publicAddresses: ['voice.example.com:7700'] });
  cleanups.push(() => t.cleanup());
  await voice.whenReady();
  return { t, backend };
}

describe('voice through the main process', () => {
  it('the welcome keeps the voice snapshot, and voice.join answers with the address this app connected to', async () => {
    const { t, backend } = await voiceServer();
    const address = `127.0.0.1:${t.server.port}`;
    const welcome = await controller.join({ addresses: [address], serverKeyId: t.server.serverKeyId, nickname: 'Ana' });
    expect(welcome).not.toHaveProperty('fileToken');
    expect(voiceWelcomeSchemaClient.parse((welcome as unknown as { voice: unknown }).voice)).toEqual([]);
    expect(welcome.features).toContain('voice');

    const joined = voiceJoinResponseSchemaClient.parse(await controller.request('voice.join', { channelId: 'VC1' }));
    // The renderer pins the host this connection used (spec §4), so LiveKit must be reached through it.
    expect(joined.livekitUrl).toBe(`wss://${address}`);
    expect(joined.iceServers).toEqual([]);

    backend.join('ch_VC1', `u_${welcome.self.userId}`);
    await waitFor(() => events.some((e) => e.t === 'voice.state'));
    expect(events.find((e) => e.t === 'voice.state')!.d).toMatchObject({ channelId: 'VC1', participants: [{ userId: welcome.self.userId }] });
  });

  it('server.request rejects with CONNECTION_LOST when nothing is connected', async () => {
    await expect(controller.request('voice.join', { channelId: 'VC1' })).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
  });
});
