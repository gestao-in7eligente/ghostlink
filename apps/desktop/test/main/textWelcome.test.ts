import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { textWelcomeSchemaClient, type Envelope } from '@ghostlink/shared';
import { createTextModule } from '../../../server/src/text/index.js';
import { startTestServer, type TestServer } from '../../../server/test/helpers/testClient.js';
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
    setRendererPins: async () => {},
    emitConnectionState: () => {},
    emitServerEvent: (e) => events.push(e),
    clientName: 'ghostlink/0.1.0 (test)',
  });
  cleanups.push(() => controller.disconnect());
});

async function textServer(): Promise<TestServer> {
  const t = await startTestServer({ joinMode: 'open', modules: [createTextModule()] });
  cleanups.push(() => t.cleanup());
  return t;
}

describe('module welcome fields reach the renderer (without the fileToken)', () => {
  it('keeps channels, roles, members, readStates and serverSettings', async () => {
    const t = await textServer();
    const welcome = await controller.join({ addresses: [`127.0.0.1:${t.server.port}`], serverKeyId: t.server.serverKeyId, nickname: 'Ana' });
    expect(welcome).not.toHaveProperty('fileToken');
    const text = textWelcomeSchemaClient.parse(welcome);
    expect(text.channels.map((c) => c.name)).toEqual(['geral', 'Sala de voz']);
    expect(text.members.map((m) => m.nickname)).toEqual(['Ana']);
    expect(text.roles.length).toBe(2);
  });
});

describe('ClientController.request (server.request IPC)', () => {
  it('relays requests to the connected server and events back', async () => {
    const t = await textServer();
    const welcome = await controller.join({ addresses: [`127.0.0.1:${t.server.port}`], serverKeyId: t.server.serverKeyId, nickname: 'Ana' });
    const geral = textWelcomeSchemaClient.parse(welcome).channels[0]!.id;
    const res = (await controller.request('msg.send', { channelId: geral, content: 'oi', clientMsgId: 'c1' })) as { message: { content: string } };
    expect(res.message.content).toBe('oi');
    await waitFor(() => events.some((e) => e.t === 'msg.new'));
    await expect(controller.request('msg.send', { channelId: geral })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects with CONNECTION_LOST when nothing is connected', async () => {
    await expect(controller.request('ping', {})).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
  });

  it('refuses a request meant for another server (a switch happened meanwhile)', async () => {
    const t = await textServer();
    const welcome = await controller.join({ addresses: [`127.0.0.1:${t.server.port}`], serverKeyId: t.server.serverKeyId, nickname: 'Ana' });
    await expect(controller.request('ping', {}, welcome.serverId)).resolves.toBeTruthy();
    await expect(controller.request('ping', {}, 'another-server')).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
  });
});
