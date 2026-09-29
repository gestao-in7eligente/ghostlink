// Host mode end to end, minus Electron: the real forkServer, whose utility process
// runs the real hosted-server body in-process; a real server; a real ClientController.
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseJoinInput } from '@ghostlink/shared';
import { silentLogger } from '../../../server/src/index.js';
import { connectTestClient } from '../../../server/test/helpers/testClient.js';
import type { ConnectionStateEvent } from '../../src/shared/ipcTypes.js';
import type { HostStatus } from '../../src/shared/hostTypes.js';
import { FakeSafeStorage } from '../helpers/fakeSafeStorage.js';
import { useTempDir } from '../helpers/tempDir.js';

/** A UtilityProcess whose body is runHostedServer, in this process. */
class InProcessChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  readonly #toChild = new EventEmitter();
  constructor(argv: string[]) {
    super();
    void import('../../src/main/hostedServer.js').then(({ runHostedServer }) =>
      runHostedServer(
        {
          on: (_event, listener) => this.#toChild.on('message', listener),
          postMessage: (m) => setImmediate(() => this.emit('message', structuredClone(m))),
        },
        argv,
        { exit: (code) => setImmediate(() => this.emit('exit', code)), logger: silentLogger, localAddresses: () => [] },
      ),
    );
  }
  postMessage(message: unknown): void {
    setImmediate(() => this.#toChild.emit('message', { data: structuredClone(message) }));
  }
  kill(): boolean {
    this.emit('exit', 1);
    return true;
  }
}

const electron = vi.hoisted(() => ({ utilityProcess: { fork: vi.fn() }, app: { isPackaged: false } }));
vi.mock('electron', () => electron);

const { forkServer } = await import('../../src/main/hostProcess.js');
const { HostManager, HOSTED_DIR } = await import('../../src/main/hostManager.js');
const { ClientController } = await import('../../src/main/controller.js');
const { IdentityStore } = await import('../../src/main/identity.js');
const { SavedServersStore } = await import('../../src/main/savedServers.js');
const { SettingsStore } = await import('../../src/main/settings.js');

const dir = useTempDir();
let manager: InstanceType<typeof HostManager>;
let controller: InstanceType<typeof ClientController>;
let servers: ReturnType<typeof SavedServersStore.load>;
let states: ConnectionStateEvent[];
let emitted: HostStatus[];

beforeEach(() => {
  electron.utilityProcess.fork.mockImplementation((_entry: string, argv: string[]) => new InProcessChild(argv));
  const identity = IdentityStore.load(dir.path, new FakeSafeStorage());
  identity.create();
  const settings = SettingsStore.load(dir.path, 'pt-BR');
  settings.set({ nickname: 'Ana' });
  servers = SavedServersStore.load(dir.path);
  states = [];
  emitted = [];
  controller = new ClientController({
    identity,
    settings,
    servers,
    setRendererPin: async () => {},
    emitConnectionState: (e) => states.push(e),
    emitServerEvent: () => {},
    clientName: 'ghostlink/0.1.0 (test)',
    connectionOptions: { timing: { backoffMinMs: 50, backoffMaxMs: 200 }, random: () => 0.5 },
  });
  manager = new HostManager({
    userDataDir: dir.path,
    fork: forkServer,
    join: (req) => controller.join(req),
    leave: async (serverKeyId) => {
      if (servers.findByServerKeyId(serverKeyId)?.id === controller.currentServerId) await controller.disconnect();
    },
    nickname: () => settings.get().nickname,
    emit: (s) => emitted.push(s),
    // Loopback in tests: 0.0.0.0 can pop a firewall prompt. Port 0 = any free port.
    bindHost: '127.0.0.1',
  });
});

afterEach(async () => {
  await manager.stop().catch(() => {});
  await controller.disconnect();
});

// Every test picks a free port (the form refuses port 0).
const CONFIG = { name: 'Casa do Zé', joinMode: 'invite' as const, maxMembers: 10 };

describe('Host mode flow (spec §9)', () => {
  it('hosts, becomes the owner automatically, saves the server, and invites a second person', async () => {
    const result = await manager.start({ ...CONFIG, port: await freePort() });
    expect(result.status).toMatchObject({ state: 'running', joinError: null, hasOwner: true, members: 1, maxMembers: 10 });
    expect(result.welcome).toMatchObject({ self: { isOwner: true, nickname: 'Ana' }, server: { name: 'Casa do Zé', joinMode: 'invite' } });
    expect(result.welcome).not.toHaveProperty('fileToken');
    expect(controller.currentServerId).toBe(result.welcome!.serverId);
    // The setup code was consumed: the file is gone.
    expect(existsSync(join(dir.path, HOSTED_DIR, 'casa-do-ze', 'setup-code.txt'))).toBe(false);
    expect(servers.list()).toEqual([
      expect.objectContaining({ name: 'Casa do Zé', serverKeyId: result.status.serverKeyId, addresses: [`127.0.0.1:${result.status.port}`] }),
    ]);

    const invite = await manager.invite({ maxUses: 1 });
    const parsed = parseJoinInput(invite.webLink);
    if (parsed.kind !== 'invite') throw new Error('expected an invite');
    expect(parsed.invite.serverKeyId).toBe(result.status.serverKeyId);
    const guest = await connectTestClient({ port: result.status.port!, serverKeyId: result.status.serverKeyId! } as never, {
      nickname: 'Bia',
      inviteCode: parsed.invite.inviteCode,
    });
    try {
      expect(guest.welcome?.self.isOwner).toBe(false);
    } finally {
      guest.close();
    }
    expect((await manager.refresh()).members).toBe(2);
  });

  it('stop disconnects the client and frees the port; hosting again resumes the same server as owner', async () => {
    const port = await freePort();
    const first = await manager.start({ ...CONFIG, port });
    const stopped = await manager.stop();
    expect(stopped.state).toBe('stopped');
    expect(controller.currentServerId).toBeNull();
    expect(states.at(-1)).toEqual({ state: 'idle', serverId: first.welcome!.serverId });

    const again = await manager.start({ ...CONFIG, port });
    expect(again.status.serverKeyId).toBe(first.status.serverKeyId); // same data dir, same certificate
    expect(again.welcome).toMatchObject({ self: { isOwner: true }, serverId: first.welcome!.serverId });
  });

  it('restart keeps the owner connected through a new process', async () => {
    const first = await manager.start({ ...CONFIG, port: await freePort() });
    const restarted = await manager.restart();
    expect(electron.utilityProcess.fork).toHaveBeenCalledTimes(2);
    expect(restarted.status).toMatchObject({ state: 'running', serverKeyId: first.status.serverKeyId, joinError: null });
    expect(restarted.welcome).toMatchObject({ self: { isOwner: true } });
  });

  it('a busy port is reported as PORT_IN_USE', async () => {
    const first = await manager.start({ ...CONFIG, port: await freePort() });
    const other = new HostManager({
      userDataDir: join(dir.path, 'other'),
      fork: forkServer,
      join: () => Promise.reject(new Error('unused')),
      leave: async () => {},
      nickname: () => 'Bia',
      emit: () => {},
      bindHost: '127.0.0.1',
    });
    const result = await other.start({ ...CONFIG, port: first.status.port! });
    expect(result.status).toMatchObject({ state: 'failed', error: 'PORT_IN_USE', errorPort: first.status.port });
  });

  it('"Recuperar posse" gives ownership back to this identity after it was lost', async () => {
    const first = await manager.start({ ...CONFIG, port: await freePort() });
    expect(first.welcome?.self.isOwner).toBe(true);
    const recovered = await manager.recoverOwnership();
    expect(recovered.welcome).toMatchObject({ self: { isOwner: true } });
    expect(recovered.status.hasOwner).toBe(true);
  });
});

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  // Above 1024 (the form's minimum), picked by the OS.
  for (;;) {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    await new Promise<void>((r) => server.close(() => r()));
    if (port >= 1024) return port;
  }
}
