import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatFingerprint } from '@ghostlink/shared';
import { dataPaths } from '../../../server/src/config/paths.js';
import { loadOrCreateCertificate } from '../../../server/src/tls/certificate.js';
import { AppError } from '../../src/shared/appErrors.js';
import type { HostConfig, HostStatus } from '../../src/shared/hostTypes.js';
import type { JoinConnectRequest, RendererWelcome } from '../../src/shared/ipcTypes.js';
import type { ForkServerOptions, ForkedServer } from '../../src/main/hostProcess.js';
import type { HostRequest, HostedStatus } from '../../src/main/hostedServer.js';
import {
  HOST_FILE,
  HOSTED_DIR,
  HostManager,
  SERVER_CERT_FILE,
  SETUP_CODE_FILE,
  hostSlug,
  normalizeHostConfig,
} from '../../src/main/hostManager.js';
import { useTempDir } from '../helpers/tempDir.js';

const dir = useTempDir();
const SETUP = '3f9a2b1c-7d4e5f60-a1b2c3d4-e5f60718';
const CONFIG: HostConfig = { name: 'Casa do Zé', port: 7700, joinMode: 'invite', maxMembers: 100 };
const WELCOME = { serverId: 'saved-1', self: { isOwner: true } } as unknown as RendererWelcome;

/** A hosted server double: writes real TLS material and a setup code, answers requests, can crash. */
class FakeServer implements ForkedServer {
  requests: HostRequest[] = [];
  shutdowns = 0;
  exited: Promise<number>;
  #exit!: (code: number) => void;
  replies: Partial<Record<HostRequest['cmd'], (r: HostRequest) => unknown>> = {};
  constructor(
    readonly port: number,
    readonly opts: ForkServerOptions,
  ) {
    this.exited = new Promise((r) => {
      this.#exit = r;
    });
  }
  request<T>(command: HostRequest): Promise<T> {
    this.requests.push(command);
    const reply = this.replies[command.cmd];
    return reply ? Promise.resolve(reply(command) as T) : Promise.reject(new AppError('TIMEOUT'));
  }
  shutdown(): Promise<void> {
    this.shutdowns++;
    this.#exit(0);
    return this.exited.then(() => {});
  }
  crash(code = 1): void {
    this.#exit(code);
  }
}

function statusReply(server: FakeServer, extra: Partial<HostedStatus> = {}): HostedStatus {
  return {
    port: server.port,
    serverKeyId: 'x',
    version: '0.1.0',
    name: CONFIG.name,
    joinMode: 'invite',
    maxMembers: 100,
    members: 0,
    hasOwner: false,
    publicAddresses: [`192.168.0.10:${server.port}`, `26.1.2.3:${server.port}`],
    localAddresses: [
      { ip: '192.168.0.10', interface: 'Ethernet', kind: 'lan' },
      { ip: '26.1.2.3', interface: 'Radmin VPN', kind: 'radmin' },
    ],
    ...extra,
  };
}

let forks: FakeServer[];
let forkImpl: (opts: ForkServerOptions) => Promise<FakeServer>;
let joins: JoinConnectRequest[];
let joinImpl: (req: JoinConnectRequest) => Promise<RendererWelcome>;
let leaves: string[];
let emitted: HostStatus[];
let manager: HostManager;

/** The default fork: real certificate + setup code in the data dir, like the real server writes them. */
async function realisticFork(opts: ForkServerOptions, writeSetupCode = true): Promise<FakeServer> {
  await loadOrCreateCertificate(opts.dataDir);
  if (writeSetupCode) writeFileSync(join(opts.dataDir, SETUP_CODE_FILE), `${SETUP}\n`);
  opts.onLog?.('2026-09-28T00:00:00.000Z info GhostLink server listening {"port":7700}\n');
  const server = new FakeServer(opts.port, opts);
  server.replies.status = () => statusReply(server);
  forks.push(server);
  return server;
}

function makeManager(extra: Partial<ConstructorParameters<typeof HostManager>[0]> = {}): HostManager {
  return new HostManager({
    userDataDir: dir.path,
    fork: (opts) => forkImpl(opts),
    join: (req) => {
      joins.push(req);
      return joinImpl(req);
    },
    leave: async (serverKeyId) => {
      leaves.push(serverKeyId);
    },
    nickname: () => 'Ana',
    emit: (s) => emitted.push(s),
    now: () => 1_000,
    ...extra,
  });
}

beforeEach(() => {
  forks = [];
  forkImpl = (opts) => realisticFork(opts);
  joins = [];
  joinImpl = async () => WELCOME;
  leaves = [];
  emitted = [];
  manager = makeManager();
});

describe('hostSlug / normalizeHostConfig', () => {
  it.each([
    ['Casa do Zé', 'casa-do-ze'],
    ['  Clã dos Fantasmas!! ', 'cla-dos-fantasmas'],
    ['../../Windows/System32', 'windows-system32'],
    ['..\\..\\evil', 'evil'],
    ['CON', 'con-server'],
    ['lpt1', 'lpt1-server'],
    ['💀👻', 'server'],
    ['a'.repeat(100), 'a'.repeat(40)],
  ])('%j → %s', (name, slug) => {
    expect(hostSlug(name)).toBe(slug);
    expect(hostSlug(name)).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it('keeps a clean config and sanitizes the name', () => {
    expect(normalizeHostConfig({ ...CONFIG, name: '  Casa\u0000 do Zé  ' })).toEqual({ ...CONFIG, name: 'Casa do Zé' });
  });

  it.each<[string, Partial<HostConfig>]>([
    ['an empty name', { name: '   ' }],
    ['a privileged port', { port: 80 }],
    ['port 0', { port: 0 }],
    ['a port above 65535', { port: 65536 }],
    ['a fractional port', { port: 7700.5 }],
    ['the password mode', { joinMode: 'password' as never }],
    ['zero members', { maxMembers: 0 }],
    ['too many members', { maxMembers: 10_001 }],
  ])('refuses %s', (_label, patch) => {
    expect(() => normalizeHostConfig({ ...CONFIG, ...patch })).toThrow(expect.objectContaining({ code: 'BAD_REQUEST' }));
  });

  it('uses the same file layout as the server (setup code, certificate)', () => {
    const p = dataPaths('/data');
    expect(join('/data', SETUP_CODE_FILE)).toBe(p.setupCodeFile);
    expect(join('/data', ...SERVER_CERT_FILE)).toBe(p.certFile);
  });
});

describe('HostManager.start (spec §9)', () => {
  it('forks the server on 0.0.0.0 in <userData>/hosted/<slug> with the first-run settings', async () => {
    await manager.start(CONFIG);
    const [server] = forks;
    expect(server!.opts).toMatchObject({
      dataDir: join(dir.path, HOSTED_DIR, 'casa-do-ze'),
      port: 7700,
      host: '0.0.0.0',
      args: ['--name=Casa do Zé', '--join-mode=invite', '--max-members=100'],
    });
  });

  it('auto-joins as owner: setup code read from disk, pin computed from the generated certificate', async () => {
    const result = await manager.start(CONFIG);
    const dataDir = join(dir.path, HOSTED_DIR, 'casa-do-ze');
    const { serverKeyId } = await loadOrCreateCertificate(dataDir); // reads the existing cert
    expect(joins).toEqual([
      {
        addresses: ['127.0.0.1:7700', '192.168.0.10:7700', '26.1.2.3:7700'],
        serverKeyId,
        nickname: 'Ana',
        name: 'Casa do Zé',
        setupCode: SETUP,
      },
    ]);
    expect(result.welcome).toBe(WELCOME);
    expect(result.status).toMatchObject({
      state: 'running',
      port: 7700,
      serverKeyId,
      fingerprint: formatFingerprint(serverKeyId),
      joinError: null,
      error: null,
      config: CONFIG,
      startedAt: 1_000,
      addresses: [
        { address: '127.0.0.1:7700', kind: 'loopback' },
        { address: '192.168.0.10:7700', kind: 'lan', interface: 'Ethernet' },
        { address: '26.1.2.3:7700', kind: 'radmin', interface: 'Radmin VPN' },
      ],
    });
  });

  it('announces starting, then running, with increasing revisions', async () => {
    await manager.start(CONFIG);
    expect(emitted.map((s) => s.state)).toEqual(expect.arrayContaining(['starting', 'running']));
    expect(emitted[0]!.state).toBe('starting');
    const revisions = emitted.map((s) => s.revision);
    expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
    expect(new Set(revisions).size).toBe(revisions.length);
  });

  it('joins without a setup code once the server already has an owner (the file is gone)', async () => {
    forkImpl = (opts) => realisticFork(opts, false);
    await manager.start(CONFIG);
    expect(joins[0]).not.toHaveProperty('setupCode');
  });

  it('ignores a setup-code file that does not look like one', async () => {
    forkImpl = async (opts) => {
      const server = await realisticFork(opts, false);
      writeFileSync(join(opts.dataDir, SETUP_CODE_FILE), 'x'.repeat(10_000));
      return server;
    };
    await manager.start(CONFIG);
    expect(joins[0]).not.toHaveProperty('setupCode');
  });

  it('keeps the server running when the auto-join fails, and reports why', async () => {
    joinImpl = async () => {
      throw new AppError('UNREACHABLE');
    };
    const result = await manager.start(CONFIG);
    expect(result.welcome).toBeNull();
    expect(result.status).toMatchObject({ state: 'running', joinError: 'UNREACHABLE' });
    expect(forks[0]!.shutdowns).toBe(0);
  });

  it('remembers the last settings in hosted/host.json and prefills them next time', async () => {
    await manager.start(CONFIG);
    expect(JSON.parse(readFileSync(join(dir.path, HOSTED_DIR, HOST_FILE), 'utf8'))).toMatchObject({ version: 1, last: CONFIG });
    expect(makeManager().status()).toMatchObject({ state: 'stopped', config: CONFIG });
  });

  it('survives a corrupt host.json', () => {
    mkdirSync(join(dir.path, HOSTED_DIR), { recursive: true });
    writeFileSync(join(dir.path, HOSTED_DIR, HOST_FILE), '{"version":1,"last":{"name":"x","port":"7700"}}');
    expect(makeManager().status()).toMatchObject({ state: 'stopped', config: null });
  });

  it('reports a busy port as PORT_IN_USE with the port, and can start again on another port', async () => {
    forkImpl = async () => {
      throw Object.assign(new Error('the hosted server failed to start: listen EADDRINUSE'), { code: 'EADDRINUSE' });
    };
    const result = await manager.start(CONFIG);
    expect(result).toEqual({ status: expect.objectContaining({ state: 'failed', error: 'PORT_IN_USE', errorPort: 7700 }), welcome: null });
    expect(joins).toEqual([]);
    expect(manager.logs().some((l) => /EADDRINUSE/.test(l))).toBe(true);

    forkImpl = (opts) => realisticFork(opts);
    expect((await manager.start({ ...CONFIG, port: 7710 })).status).toMatchObject({ state: 'running', port: 7710, error: null, errorPort: null });
  });

  it('reports any other startup failure as HOST_FAILED', async () => {
    forkImpl = async () => {
      throw new Error('the hosted server exited with code 1 before it was ready');
    };
    expect((await manager.start(CONFIG)).status).toMatchObject({ state: 'failed', error: 'HOST_FAILED' });
  });

  it('hosts one server at a time', async () => {
    await manager.start(CONFIG);
    await expect(manager.start({ ...CONFIG, name: 'Outro' })).rejects.toMatchObject({ code: 'HOST_BUSY' });
    expect(forks).toHaveLength(1);
  });

  it('refuses a second start while the first is still starting', async () => {
    let release!: () => void;
    forkImpl = async (opts) => {
      await new Promise<void>((r) => {
        release = r;
      });
      return realisticFork(opts);
    };
    const first = manager.start(CONFIG);
    await expect(manager.start(CONFIG)).rejects.toMatchObject({ code: 'HOST_BUSY' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    expect((await first).status.state).toBe('running');
  });
});

describe('HostManager stop / restart / crash', () => {
  it('stop leaves the server, shuts it down gracefully and clears the invite', async () => {
    const { status } = await manager.start(CONFIG);
    forks[0]!.replies.invite = () => ({ code: 'ABCDEFGH23', link: 'ghostlink://join?x', pasteCode: 'GL1-x', webLink: 'https://site/j/#GL1-x' });
    await manager.invite({});
    const stopped = await manager.stop();
    expect(leaves).toEqual([status.serverKeyId]);
    expect(forks[0]!.shutdowns).toBe(1);
    expect(stopped).toMatchObject({ state: 'stopped', port: null, serverKeyId: null, invite: null, addresses: [], config: CONFIG });
    expect(emitted.at(-2)!.state).toBe('stopping');
    expect(emitted.at(-1)!.state).toBe('stopped');
    expect(manager.isActive()).toBe(false);
  });

  it('stopForQuit waits for a start in progress, then stops (quitting never fails with HOST_BUSY)', async () => {
    let release!: () => void;
    forkImpl = async (opts) => {
      await new Promise<void>((r) => {
        release = r;
      });
      return realisticFork(opts);
    };
    const starting = manager.start(CONFIG);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const quitting = manager.stopForQuit();
    release();
    await starting;
    await quitting;
    expect(forks[0]!.shutdowns).toBe(1);
    expect(manager.status().state).toBe('stopped');
    expect(manager.isActive()).toBe(false);
  });

  it('stop is harmless when nothing runs', async () => {
    expect((await manager.stop()).state).toBe('stopped');
    expect(leaves).toEqual([]);
  });

  it('a crash turns running into failed (HOST_FAILED) and keeps the logs', async () => {
    await manager.start(CONFIG);
    forks[0]!.opts.onLog?.('boom: out of memory\n');
    forks[0]!.crash(1);
    await vi.waitFor(() => expect(manager.status().state).toBe('failed'));
    expect(manager.status()).toMatchObject({ error: 'HOST_FAILED', port: null });
    expect(emitted.at(-1)!.state).toBe('failed');
    expect(manager.logs()).toEqual(expect.arrayContaining(['boom: out of memory']));
    expect((await manager.stop()).state).toBe('stopped');
    expect(forks[0]!.shutdowns).toBe(0);
  });

  it('restart = shutdown + a new fork with the same settings, then the auto-join again', async () => {
    await manager.start(CONFIG);
    const result = await manager.restart();
    expect(forks).toHaveLength(2);
    expect(forks[0]!.shutdowns).toBe(1);
    expect(forks[1]!.opts).toMatchObject({ dataDir: forks[0]!.opts.dataDir, port: 7700, args: forks[0]!.opts.args });
    expect(joins).toHaveLength(2);
    expect(leaves).toEqual([]); // the client reconnects through the auto-join
    expect(result).toMatchObject({ status: { state: 'running' }, welcome: WELCOME });
  });

  it('restart relaunches a crashed server; refuses when nothing was ever hosted', async () => {
    await expect(manager.restart()).rejects.toMatchObject({ code: 'HOST_NOT_RUNNING' });
    await manager.start(CONFIG);
    forks[0]!.crash();
    await vi.waitFor(() => expect(manager.status().state).toBe('failed'));
    expect((await manager.restart()).status.state).toBe('running');
    expect(forks).toHaveLength(2);
  });
});

describe('HostManager commands', () => {
  it('invite asks the server and keeps the invite in the status', async () => {
    await manager.start(CONFIG);
    forks[0]!.replies.invite = () => ({ code: 'ABCDEFGH23', link: 'ghostlink://join?x', pasteCode: 'GL1-x', webLink: 'https://site/j/#GL1-x' });
    const invite = await manager.invite({ maxUses: 5, expiresInHours: 24 });
    expect(forks[0]!.requests.at(-1)).toEqual({ cmd: 'invite', maxUses: 5, expiresInHours: 24 });
    expect(invite).toEqual({
      code: 'ABCDEFGH23',
      link: 'ghostlink://join?x',
      pasteCode: 'GL1-x',
      webLink: 'https://site/j/#GL1-x',
      maxUses: 5,
      expiresInHours: 24,
      createdAt: 1_000,
    });
    expect(manager.status().invite).toEqual(invite);
    expect(emitted.at(-1)!.invite).toEqual(invite);
  });

  it('commands need a running server', async () => {
    await expect(manager.invite({})).rejects.toMatchObject({ code: 'HOST_NOT_RUNNING' });
    await expect(manager.join()).rejects.toMatchObject({ code: 'HOST_NOT_RUNNING' });
    await expect(manager.recoverOwnership()).rejects.toMatchObject({ code: 'HOST_NOT_RUNNING' });
  });

  it('recoverOwnership resets the setup code in the server and uses it right away', async () => {
    await manager.start(CONFIG);
    forks[0]!.replies['reset-owner'] = () => ({ setupCode: 'aaaaaaaa-bbbbbbbb-cccccccc-dddddddd' });
    const result = await manager.recoverOwnership();
    expect(forks[0]!.requests.slice(-2)).toEqual([{ cmd: 'reset-owner' }, { cmd: 'status' }]);
    expect(joins.at(-1)).toMatchObject({ setupCode: 'aaaaaaaa-bbbbbbbb-cccccccc-dddddddd', nickname: 'Ana' });
    expect(result.welcome).toBe(WELCOME);
  });

  it('join runs the auto-join again after a failure', async () => {
    joinImpl = async () => {
      throw new AppError('TIMEOUT');
    };
    await manager.start(CONFIG);
    joinImpl = async () => WELCOME;
    const result = await manager.join();
    expect(result).toMatchObject({ welcome: WELCOME, status: { joinError: null } });
  });

  it('refresh updates members and addresses from the server', async () => {
    await manager.start(CONFIG);
    forks[0]!.replies.status = () => statusReply(forks[0]!, { members: 3, hasOwner: true, publicAddresses: [], localAddresses: [] });
    expect(await manager.refresh()).toMatchObject({ members: 3, hasOwner: true, addresses: [{ address: '127.0.0.1:7700', kind: 'loopback' }] });
  });

  it('logs keep the server output line by line (at most 500)', async () => {
    await manager.start(CONFIG);
    const onLog = forks[0]!.opts.onLog!;
    onLog('half a li');
    onLog('ne\r\nsecond\n');
    for (let i = 0; i < 600; i++) onLog(`line ${i}\n`);
    const logs = manager.logs();
    expect(logs).toHaveLength(500);
    expect(logs.at(-1)).toBe('line 599');
    expect(manager.logs()).not.toContain('half a li');
  });

  it('remembers that the tray notice was shown', () => {
    expect(manager.trayNoticeShown()).toBe(false);
    manager.markTrayNoticeShown();
    expect(makeManager().trayNoticeShown()).toBe(true);
    expect(existsSync(join(dir.path, HOSTED_DIR, HOST_FILE))).toBe(true);
  });
});
