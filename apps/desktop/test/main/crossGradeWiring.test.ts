// The app side wired together (plan 2026-10-05-v083-troca-automatica, Task 7): a welcome that advertises a neutral
// `updateChannel` reaches the per-server store through the controller, and a changed latest triggers the one-time
// switch. A build that is not the open-source one (enabled = false) never cross-grades. All public; no edition here.
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WelcomePayload } from '@ghostlink/shared';
import type { ConnState } from '../../src/shared/ipcTypes.js';
import type { ServerConnectionOptions } from '../../src/main/connection.js';
import { ClientController, type ConnectionLike } from '../../src/main/controller.js';
import { IdentityStore } from '../../src/main/identity.js';
import { SavedServersStore } from '../../src/main/savedServers.js';
import { SettingsStore } from '../../src/main/settings.js';
import { CrossGrade } from '../../src/main/updater/crossGrade.js';
import { ServerChannelStore } from '../../src/main/updater/serverChannel.js';
import { FakeSafeStorage } from '../helpers/fakeSafeStorage.js';
import { waitFor } from '../helpers/net.js';
import { useTempDir } from '../helpers/tempDir.js';

const dir = useTempDir('ghostlink-crossgrade-wiring-');
const VERSION = '0.8.3';
const INSTALLER = 'GhostLink-Alt-Setup-0.8.3.exe';
const CHANNEL_A = 'https://a.example/updates/QUJDREVGR0hJSktMTU5PUFFSU1RVVldY/';
const CHANNEL_B = 'https://b.example/updates/Zm9vYmFyLWRvd25sb2FkLWNvZGUtMDAw/';
const enc = (s: string) => new TextEncoder().encode(s);
const latestYml = (version: string, path: string) => `version: ${version}\npath: ${path}\nsha512: 3q2+7w==\n`;

/** A connection that connects at once and hands back a welcome that may carry a top-level updateChannel. */
class FakeConnection extends EventEmitter implements ConnectionLike {
  connectedAddress: string | null = null;
  constructor(
    readonly options: ServerConnectionOptions,
    readonly welcome: WelcomePayload,
  ) {
    super();
  }
  async connect(): Promise<WelcomePayload> {
    this.emit('state', 'connecting' satisfies ConnState);
    this.connectedAddress = this.options.addresses[0]!;
    this.emit('state', 'connected' satisfies ConnState);
    return this.welcome;
  }
  async request<T>(): Promise<T> {
    return {} as T;
  }
  close(): void {}
}

function welcomeWithChannel(serverKeyId: string, url: string | undefined): WelcomePayload {
  const welcome: WelcomePayload = {
    self: { userId: randomBytes(16).toString('hex'), nickname: 'Ana', isOwner: false },
    sessionId: `s-${randomBytes(4).toString('hex')}`,
    serverTime: Date.now(),
    server: { name: 'Servidor', version: VERSION, joinMode: 'open', serverKeyId },
    features: [],
    fileToken: 'secret',
    protocol: { min: 1, max: 1 },
  };
  return url === undefined ? welcome : ({ ...welcome, updateChannel: { url } } as unknown as WelcomePayload);
}

function setup(makeCrossGrade: (store: ServerChannelStore) => Pick<CrossGrade, 'maybeCrossGrade'>) {
  const identity = IdentityStore.load(dir.path, new FakeSafeStorage());
  identity.create();
  const servers = SavedServersStore.load(dir.path);
  const store = ServerChannelStore.load(dir.path, { saved: (k) => servers.findByServerKeyId(k) !== undefined });
  const crossGrade = makeCrossGrade(store);
  const channelByKey = new Map<string, string | undefined>();
  const controller = new ClientController({
    identity,
    settings: SettingsStore.load(dir.path, 'pt-BR'),
    servers,
    setRendererPins: async () => {},
    emitConnectionState: () => {},
    emitServerEvent: () => {},
    clientName: 'ghostlink/0.8.3 (test)',
    createConnection: (options) => new FakeConnection(options, welcomeWithChannel(options.serverKeyId, channelByKey.get(options.serverKeyId))),
    onServerUpdateChannel: (serverKeyId, channel) => {
      if (store.note(serverKeyId, channel)) void crossGrade.maybeCrossGrade();
    },
  });
  const join = (url: string | undefined) => {
    const serverKeyId = randomBytes(32).toString('base64url');
    channelByKey.set(serverKeyId, url);
    return controller.join({ addresses: ['127.0.0.1:7700'], serverKeyId, nickname: 'Ana' });
  };
  return { store, join };
}

describe('the cross-grade wiring', () => {
  beforeEach(() => {
    // a fresh identity/servers/store per test share the same temp dir
  });

  it('a welcome that advertises a channel reaches the store and triggers the switch only when the latest changes', async () => {
    const maybeCrossGrade = vi.fn(async () => {});
    const { store, join } = setup(() => ({ maybeCrossGrade }));

    await join(undefined); // a server that advertises nothing: nothing recorded, nothing triggered
    expect(store.latest()).toBeNull();
    expect(maybeCrossGrade).not.toHaveBeenCalled();

    await join(CHANNEL_A); // the first channel: recorded, the switch is tried
    expect(store.latest()?.url).toBe(CHANNEL_A);
    expect(maybeCrossGrade).toHaveBeenCalledTimes(1);

    await join(CHANNEL_A); // another server, the same channel: the latest is unchanged, so no new attempt
    expect(maybeCrossGrade).toHaveBeenCalledTimes(1);

    await join(CHANNEL_B); // a different, newer channel: the switch is tried again
    expect(maybeCrossGrade).toHaveBeenCalledTimes(2);
    expect(store.latest()?.url).toBe(CHANNEL_B);
  });

  it('the open-source build fetches, verifies and runs the offered build end to end', async () => {
    const fetchReleaseFile = vi.fn(async () => enc(latestYml(VERSION, INSTALLER)));
    const verify = vi.fn(async () => null as string | null);
    const run = vi.fn(async () => {});
    const { join } = setup(
      (store) =>
        new CrossGrade({
          enabled: true,
          currentVersion: VERSION,
          autoCheck: () => true,
          updateInFlight: () => false,
          channel: () => store.latest(),
          tempDir: dir.path,
          fetchReleaseFile,
          fetchInstaller: vi.fn(async (_url: string, _max: number, d: string) => d),
          verify,
          run,
          log: () => {},
        }),
    );
    await join(CHANNEL_A);
    await waitFor(() => run.mock.calls.length === 1);
    expect(fetchReleaseFile).toHaveBeenCalledWith(`${CHANNEL_A}latest.yml`, expect.any(Number));
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('a build that is not the open-source one never cross-grades, even when a channel is advertised', async () => {
    const fetchReleaseFile = vi.fn(async () => enc(latestYml(VERSION, INSTALLER)));
    const run = vi.fn(async () => {});
    const { store, join } = setup(
      (store) =>
        new CrossGrade({
          enabled: false, // the build updates through its own path; it must stand aside
          currentVersion: VERSION,
          autoCheck: () => true,
          updateInFlight: () => false,
          channel: () => store.latest(),
          tempDir: dir.path,
          fetchReleaseFile,
          fetchInstaller: vi.fn(async (_url: string, _max: number, d: string) => d),
          verify: vi.fn(async () => null as string | null),
          run,
          log: () => {},
        }),
    );
    await join(CHANNEL_A);
    await new Promise((r) => setTimeout(r, 0));
    expect(store.latest()?.url).toBe(CHANNEL_A); // the channel is still remembered
    expect(fetchReleaseFile).not.toHaveBeenCalled(); // but nothing is fetched or run
    expect(run).not.toHaveBeenCalled();
  });
});
