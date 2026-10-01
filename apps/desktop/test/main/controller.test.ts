import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProtocolError, formatFingerprint, type Envelope } from '@ghostlink/shared';
import { silentLogger, startServer } from '../../../server/src/index.js';
import { getUser, setJoinMode, setPassword } from '../../../server/test/helpers/db.js';
import { startTestServer, type TestServer } from '../../../server/test/helpers/testClient.js';
import { AppError } from '../../src/shared/appErrors.js';
import type { ConnectionStateEvent, RendererWelcome } from '../../src/shared/ipcTypes.js';
import { ServerConnection } from '../../src/main/connection.js';
import { ClientController } from '../../src/main/controller.js';
import { IdentityStore } from '../../src/main/identity.js';
import type { RendererPin } from '../../src/main/pinning.js';
import { SavedServersStore } from '../../src/main/savedServers.js';
import { SettingsStore } from '../../src/main/settings.js';
import { FakeSafeStorage } from '../helpers/fakeSafeStorage.js';
import { TEST_HELLO, waitFor } from '../helpers/net.js';
import { useTempDir } from '../helpers/tempDir.js';

const dir = useTempDir();
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function server(opts: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const t = await startTestServer(opts);
  cleanups.push(() => t.cleanup());
  return t;
}

let identity: IdentityStore;
let servers: SavedServersStore;
let controller: ClientController;
let pins: RendererPin[][];
let states: ConnectionStateEvent[];
let events: Envelope[];

function makeController(id: IdentityStore) {
  const c = new ClientController({
    identity: id,
    settings: SettingsStore.load(dir.path, 'pt-BR'),
    servers,
    setRendererPins: async (set) => {
      pins.push(set);
    },
    emitConnectionState: (e) => states.push(e),
    emitServerEvent: (e) => events.push(e),
    clientName: 'ghostlink/0.1.0 (test)',
    connectionOptions: { timing: { backoffMinMs: 50, backoffMaxMs: 200 }, random: () => 0.5 },
  });
  cleanups.push(() => c.disconnect());
  return c;
}

beforeEach(() => {
  identity = IdentityStore.load(dir.path, new FakeSafeStorage());
  identity.create();
  servers = SavedServersStore.load(dir.path);
  pins = [];
  states = [];
  events = [];
  controller = makeController(identity);
});

const local = (t: TestServer) => `127.0.0.1:${t.server.port}`;

function joinOpen(t: TestServer, extra: Partial<Parameters<ClientController['join']>[0]> = {}): Promise<RendererWelcome> {
  return controller.join({ addresses: [local(t)], serverKeyId: t.server.serverKeyId, nickname: 'Ana', ...extra });
}

describe('ClientController.join', () => {
  it('joins from an invite link: strips the fileToken, saves the server, pins the renderer', async () => {
    const t = await server({ name: 'Casa do Zé' }); // default join mode: invite
    const parsed = controller.parse(t.server.createInvite().link);
    if (parsed.kind !== 'invite') throw new Error('expected an invite');
    const welcome = await controller.join({ ...parsed.invite, nickname: 'Ana' });

    expect(welcome).not.toHaveProperty('fileToken');
    expect(JSON.stringify(welcome)).not.toMatch(/fileToken/);
    const [saved] = servers.list();
    expect(saved).toMatchObject({ name: 'Casa do Zé', addresses: [local(t)], serverKeyId: t.server.serverKeyId, nickname: 'Ana' });
    expect(welcome.serverId).toBe(saved!.id);
    expect(welcome.address).toBe(local(t)); // what the renderer pin covers; voice checks livekitUrl against it
    expect(welcome.server.name).toBe('Casa do Zé');
    expect(pins.at(-1)).toEqual([{ hostname: '127.0.0.1', serverKeyId: t.server.serverKeyId }]);
    expect(states).toEqual([
      { state: 'connecting', serverId: null },
      { state: 'authenticating', serverId: null },
      { state: 'connected', serverId: saved!.id },
    ]);
    expect(getUser(t.dataDir, welcome.self.userId)).toMatchObject({ locale: 'pt-BR' }); // hello carried the settings locale
  });

  it('never writes the password or the invite code to disk', async () => {
    const t = await server();
    setJoinMode(t.dataDir, 'password');
    await setPassword(t.dataDir, 's3cret-pw');
    await joinOpen(t, { password: 's3cret-pw', inviteCode: 'ABCDEFGH23' });
    for (const file of readdirSync(dir.path)) {
      const content = readFileSync(join(dir.path, file), 'latin1');
      expect(content, file).not.toContain('s3cret-pw');
      expect(content, file).not.toContain('ABCDEFGH23');
    }
  });

  it('reports a refusal, saves nothing and pins nothing', async () => {
    const t = await server();
    const error = await joinOpen(t).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe('INVITE_REQUIRED');
    expect(states.at(-1)).toEqual({ state: 'failed', serverId: null, error: 'INVITE_REQUIRED' });
    expect(servers.list()).toEqual([]);
    expect(pins.flat()).toEqual([]);
  });

  it('refuses to connect without a ready identity', async () => {
    const t = await server({ joinMode: 'open' });
    const locked = new FakeSafeStorage();
    locked.failDecrypt = true;
    const c = makeController(IdentityStore.load(dir.path, locked));
    const error = await c.join({ addresses: [local(t)], serverKeyId: t.server.serverKeyId, nickname: 'Ana' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('IDENTITY_UNAVAILABLE');
  });

  it('without a call, keeps one server at a time: joining another one disconnects the first', async () => {
    const a = await server({ joinMode: 'open' });
    const b = await server({ joinMode: 'open' });
    const first = await joinOpen(a);
    await joinOpen(b);
    expect(states).toContainEqual({ state: 'idle', serverId: first.serverId });
    expect(pins.at(-1)).toEqual([{ hostname: '127.0.0.1', serverKeyId: b.server.serverKeyId }]);
    expect(servers.list()).toHaveLength(2);
  });
});

describe('ClientController — saved servers', () => {
  it('reconnects to a saved server without credentials', async () => {
    const t = await server();
    const first = await joinOpen(t, { inviteCode: t.server.createInvite().code });
    await controller.disconnect();
    expect(pins.at(-1)).toEqual([]);
    expect(states.at(-1)).toEqual({ state: 'idle', serverId: first.serverId });
    const again = await controller.connectSaved(first.serverId);
    expect(again.self.userId).toBe(first.self.userId);
    expect(again.serverId).toBe(first.serverId);
  });

  it('rejects an unknown saved server with NOT_FOUND', async () => {
    await expect(controller.connectSaved('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('remove() disconnects first when it is the active server', async () => {
    const t = await server({ joinMode: 'open' });
    const welcome = await joinOpen(t);
    await controller.remove(welcome.serverId);
    expect(servers.list()).toEqual([]);
    expect(pins.at(-1)).toEqual([]);
    expect(states.at(-1)).toEqual({ state: 'idle', serverId: welcome.serverId });
  });
});

describe('ClientController — after joining', () => {
  it('forwards the welcome of a reconnect as a server event, still without the fileToken', async () => {
    const t = await server({ joinMode: 'open' });
    const welcome = await joinOpen(t);
    await t.server.close();
    const again = await startServer({ dataDir: t.dataDir, port: t.server.port, host: '127.0.0.1', logger: silentLogger });
    cleanups.push(() => again.close());
    await waitFor(() => events.some((e) => e.t === 'welcome'));
    const forwarded = events.find((e) => e.t === 'welcome')!.d as RendererWelcome;
    expect(forwarded).not.toHaveProperty('fileToken');
    expect(forwarded.serverId).toBe(welcome.serverId);
    expect(forwarded.address).toBe(local(t));
    expect(forwarded.sessionId).not.toBe(welcome.sessionId);
    expect(states).toContainEqual({ state: 'reconnecting', serverId: welcome.serverId });
    expect(states.at(-1)).toEqual({ state: 'connected', serverId: welcome.serverId });
  });

  it('reports a fatal loss (SESSION_REPLACED) and clears the renderer pin', async () => {
    const t = await server({ joinMode: 'open' });
    const welcome = await joinOpen(t);
    // The same identity logs in elsewhere with the same per-server key.
    const other = new ServerConnection({
      addresses: [local(t)],
      serverKeyId: t.server.serverKeyId,
      key: identity.serverKey(t.server.serverKeyId),
      hello: TEST_HELLO,
      reconnect: false,
    });
    cleanups.push(() => other.close());
    await other.connect();
    await waitFor(() => states.at(-1)?.state === 'failed');
    expect(states.at(-1)).toEqual({ state: 'failed', serverId: welcome.serverId, error: 'SESSION_REPLACED' });
    expect(pins.at(-1)).toEqual([]);
  });

  it('probe() returns the key id and its fingerprint for the TOFU screen', async () => {
    const t = await server();
    expect(await controller.probe(local(t))).toEqual({ serverKeyId: t.server.serverKeyId, fingerprint: formatFingerprint(t.server.serverKeyId) });
  });
});
