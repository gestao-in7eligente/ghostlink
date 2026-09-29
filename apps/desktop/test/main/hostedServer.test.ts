import { createSocket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseJoinInput } from '@ghostlink/shared';
import { silentLogger, type GhostServer, type StartServerOptions } from '../../../server/src/index.js';
import { resolveLivekitBinary } from '../../../server/src/livekit/binary.js';
import { discoverGateway } from '../../../server/src/net/upnp.js';
import { startFakeIgd } from '../../../server/test/helpers/fakeIgd.js';
import { connectTestClient, startTestServer } from '../../../server/test/helpers/testClient.js';
import { probeServerKeyId } from '../../src/main/connection.js';
import { parseHostArgs, runHostedServer, type HostMessage } from '../../src/main/hostedServer.js';
import { useTempDir } from '../helpers/tempDir.js';

const dir = useTempDir();

/** Plays process.parentPort: records what the child posts, lets the test send commands. */
function fakeParentPort() {
  const emitter = new EventEmitter();
  const posted: HostMessage[] = [];
  return {
    posted,
    port: {
      on: (event: 'message', listener: (e: { data: unknown }) => void) => emitter.on(event, listener),
      postMessage: (m: HostMessage) => posted.push(m),
    },
    send: (data: unknown) => emitter.emit('message', { data }),
  };
}

function exitRecorder() {
  const codes: number[] = [];
  let resolve!: (code: number) => void;
  const done = new Promise<number>((r) => {
    resolve = r;
  });
  return {
    codes,
    done,
    exit: (code: number) => {
      codes.push(code);
      resolve(code);
    },
  };
}

/** Sends a request and waits for its reply. */
async function ask(parent: ReturnType<typeof fakeParentPort>, id: number, command: object): Promise<HostMessage> {
  parent.send({ id, ...command });
  for (let i = 0; i < 300; i++) {
    const reply = parent.posted.find((m) => m.type === 'reply' && m.id === id);
    if (reply) return reply;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no reply to ${JSON.stringify(command)}`);
}

describe('parseHostArgs', () => {
  it('reads --data, --port and an optional --host (loopback by default)', () => {
    expect(parseHostArgs(['--data', '/d', '--port', '0'])).toEqual({ dataDir: '/d', port: 0, host: '127.0.0.1' });
    expect(parseHostArgs(['--data', '/d', '--port', '7700', '--host', '0.0.0.0'])).toEqual({ dataDir: '/d', port: 7700, host: '0.0.0.0' });
  });

  it('reads the first-run settings of Host mode (spec §9), even a name that looks like an option', () => {
    expect(parseHostArgs(['--data', '/d', '--port', '7700', '--name=--Casa do Zé', '--join-mode=open', '--max-members=12'])).toEqual({
      dataDir: '/d',
      port: 7700,
      host: '127.0.0.1',
      name: '--Casa do Zé',
      joinMode: 'open',
      maxMembers: 12,
    });
  });

  it.each([
    [['--port', '0']],
    [['--data', '/d']],
    [['--data', '/d', '--port', '65536']],
    [['--data', '/d', '--port', '-1']],
    [['--data', '/d', '--port', '7700', '--evil', 'x']],
    [['--data', '/d', '--port', '7700', 'positional']],
    [['--data', '/d', '--port', '7700', '--join-mode=password']],
    [['--data', '/d', '--port', '7700', '--join-mode=anything']],
    [['--data', '/d', '--port', '7700', '--max-members=0']],
    [['--data', '/d', '--port', '7700', '--max-members=1e3']],
  ])('rejects %j', (argv) => {
    expect(() => parseHostArgs(argv)).toThrow();
  });
});

describe('parseHostArgs: networking flags', () => {
  it('reads --upnp and --node-ip', () => {
    expect(parseHostArgs(['--data', '/d', '--port', '7700', '--upnp', '--node-ip=203.0.113.9'])).toMatchObject({ upnp: true, nodeIp: '203.0.113.9' });
    expect(parseHostArgs(['--data', '/d', '--port', '7700'])).not.toHaveProperty('upnp');
  });
});

describe('parseHostArgs: the bundled LiveKit binary', () => {
  it('reads --livekit-bin=<absolute path>, and has no binary without it', () => {
    const bin = join(dir.path, 'livekit', 'livekit-server.exe');
    expect(parseHostArgs(['--data', '/d', '--port', '7700', `--livekit-bin=${bin}`])).toMatchObject({ livekitBinary: bin });
    expect(parseHostArgs(['--data', '/d', '--port', '7700'])).not.toHaveProperty('livekitBinary');
  });

  it.each(['livekit-server.exe', 'livekit/livekit-server', ''])('refuses the relative --livekit-bin %j', (bin) => {
    expect(() => parseHostArgs(['--data', '/d', '--port', '7700', `--livekit-bin=${bin}`])).toThrow(/livekit-bin/);
  });
});

describe('runHostedServer: voice options', () => {
  async function voiceOptionsFor(argv: string[]): Promise<StartServerOptions['voice']> {
    const seen: StartServerOptions[] = [];
    const exit = exitRecorder();
    await runHostedServer(fakeParentPort().port, ['--data', dir.path, '--port', '0', ...argv], {
      exit: exit.exit,
      logger: silentLogger,
      mediaPorts: [],
      start: async (o) => {
        seen.push(o);
        throw new Error('stop here');
      },
    });
    expect(exit.codes).toEqual([1]);
    return seen[0]!.voice;
  }

  it('hands --livekit-bin to the server as voice.binaryPath (the packaged app: no env var, no folder search)', async () => {
    const bin = join(dir.path, 'resources', 'livekit', 'livekit-server.exe');
    expect(await voiceOptionsFor([`--livekit-bin=${bin}`])).toEqual({ binaryPath: bin });
    expect(await voiceOptionsFor([`--livekit-bin=${bin}`, '--node-ip=203.0.113.9'])).toEqual({ binaryPath: bin, nodeIp: '203.0.113.9' });
  });

  it('without it, the server keeps its own lookup (development)', async () => {
    expect(await voiceOptionsFor([])).toBeUndefined();
    expect(await voiceOptionsFor(['--node-ip=203.0.113.9'])).toEqual({ nodeIp: '203.0.113.9' });
  });
});

describe('runHostedServer (utility process body, spec §9)', () => {
  it('reports ready with the bound port, serves TLS, and shuts down gracefully on command', async () => {
    const parent = fakeParentPort();
    const exit = exitRecorder();
    await runHostedServer(parent.port, ['--data', dir.path, '--port', '0'], { exit: exit.exit, logger: silentLogger });
    const [ready] = parent.posted;
    expect(ready).toEqual({ type: 'ready', port: expect.any(Number) });
    const port = (ready as { port: number }).port;
    expect(await probeServerKeyId(`127.0.0.1:${port}`)).toMatch(/^[A-Za-z0-9_-]{43}$/);

    parent.send({ cmd: 'status' }); // no request id: ignored
    parent.send({ cmd: 'shutdown' });
    parent.send({ cmd: 'shutdown' }); // only once
    expect(await exit.done).toBe(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(exit.codes).toEqual([0]);
    expect(parent.posted).toHaveLength(1);
    await expect(probeServerKeyId(`127.0.0.1:${port}`, { timeoutMs: 1_000 })).rejects.toMatchObject({ code: 'UNREACHABLE' });
  });

  it('reports bad arguments and exits 1', async () => {
    const parent = fakeParentPort();
    const exit = exitRecorder();
    await runHostedServer(parent.port, ['--port', '0'], { exit: exit.exit, logger: silentLogger });
    expect(parent.posted).toEqual([{ type: 'error', message: '--data is required' }]);
    expect(exit.codes).toEqual([1]);
  });

  it('reports a busy port with its errno code and exits 1', async () => {
    const busy = await startTestServer();
    try {
      const parent = fakeParentPort();
      const exit = exitRecorder();
      await runHostedServer(parent.port, ['--data', dir.path, '--port', String(busy.server.port)], { exit: exit.exit, logger: silentLogger });
      // spec §8.5: the next free port (7710, 7720, … style) comes with the error.
      expect(parent.posted).toEqual([{ type: 'error', message: expect.stringMatching(/EADDRINUSE/), code: 'EADDRINUSE', suggestedPort: expect.any(Number) }]);
      const { suggestedPort } = parent.posted[0] as { suggestedPort: number };
      expect((suggestedPort - busy.server.port) % 10).toBe(0);
      expect(exit.codes).toEqual([1]);
    } finally {
      await busy.cleanup();
    }
  });
});

describe('parent-port control commands (spec §9)', () => {
  // Loopback plus an injected address list: binding 0.0.0.0 in tests can pop a firewall prompt.
  async function running(extra: string[] = []) {
    const parent = fakeParentPort();
    const exit = exitRecorder();
    await runHostedServer(parent.port, ['--data', dir.path, '--port', '0', ...extra], {
      exit: exit.exit,
      logger: silentLogger,
      localAddresses: () => [{ ip: '127.0.0.1', interface: 'test', kind: 'lan' }],
      mediaPorts: [],
    });
    const ready = parent.posted[0] as { type: 'ready'; port: number };
    expect(ready.type).toBe('ready');
    return { parent, exit, port: ready.port };
  }

  it('seeds name, join mode and member limit, and answers status', async () => {
    const { parent, exit, port } = await running(['--host', '127.0.0.1', '--name=Casa do Zé', '--join-mode=open', '--max-members=12']);
    expect(await ask(parent, 1, { cmd: 'status' })).toEqual({
      type: 'reply',
      id: 1,
      ok: true,
      value: {
        port,
        serverKeyId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        version: expect.any(String),
        name: 'Casa do Zé',
        joinMode: 'open',
        maxMembers: 12,
        members: 0,
        hasOwner: false,
        publicAddresses: [`127.0.0.1:${port}`],
        localAddresses: [{ ip: '127.0.0.1', interface: 'test', kind: 'lan' }],
        net: {
          upnp: { state: 'off', wanIp: null, mappings: [] },
          cgnat: false,
          nodeIp: '127.0.0.1',
          localAddresses: [{ ip: '127.0.0.1', interface: 'test', kind: 'lan' }],
        },
        busyMediaPorts: [],
      },
    });
    parent.send({ cmd: 'shutdown' });
    expect(await exit.done).toBe(0);
  });

  it('creates invites that carry the advertised addresses, and validates every command', async () => {
    const { parent, exit, port } = await running(['--host', '127.0.0.1']);
    const reply = await ask(parent, 7, { cmd: 'invite', maxUses: 5, expiresInHours: 24 });
    if (reply.type !== 'reply' || !reply.ok) throw new Error('invite failed');
    const invite = reply.value as { webLink: string; code: string };
    const parsed = parseJoinInput(invite.webLink);
    expect(parsed.kind === 'invite' && parsed.invite).toMatchObject({ addresses: [`127.0.0.1:${port}`], inviteCode: invite.code });

    expect(await ask(parent, 8, { cmd: 'invite', maxUses: 0 })).toEqual({ type: 'reply', id: 8, ok: false, error: 'BAD_REQUEST' });
    expect(await ask(parent, 9, { cmd: 'invite', admin: true })).toEqual({ type: 'reply', id: 9, ok: false, error: 'BAD_REQUEST' });
    expect(await ask(parent, 10, { cmd: 'format-disk' })).toEqual({ type: 'reply', id: 10, ok: false, error: 'BAD_REQUEST' });
    parent.send({ cmd: 'shutdown' });
    expect(await exit.done).toBe(0);
  });

  it('keeps the last log lines and returns them on logs', async () => {
    const { parent, exit } = await running();
    const reply = await ask(parent, 2, { cmd: 'logs' });
    if (reply.type !== 'reply' || !reply.ok) throw new Error('logs failed');
    expect((reply.value as string[]).some((l) => /info GhostLink server listening/.test(l))).toBe(true);
    parent.send({ cmd: 'shutdown' });
    expect(await exit.done).toBe(0);
  });

  it('reset-owner issues a new setup code that works right away (Recuperar posse)', async () => {
    const { parent, exit, port } = await running();
    const setupFile = join(dir.path, 'setup-code.txt');
    const original = readFileSync(setupFile, 'utf8').trim();
    const reply = await ask(parent, 3, { cmd: 'reset-owner' });
    if (reply.type !== 'reply' || !reply.ok) throw new Error('reset-owner failed');
    const { setupCode } = reply.value as { setupCode: string };
    expect(setupCode).not.toBe(original);
    expect(readFileSync(setupFile, 'utf8').trim()).toBe(setupCode);

    const serverKeyId = await probeServerKeyId(`127.0.0.1:${port}`);
    const owner = await connectTestClient({ port, serverKeyId } as GhostServer, { setupCode });
    try {
      expect(owner.welcome?.self.isOwner).toBe(true);
      expect(existsSync(setupFile)).toBe(false);
    } finally {
      owner.close();
    }
    parent.send({ cmd: 'shutdown' });
    expect(await exit.done).toBe(0);
  });
});

describe('networking in the hosted server (spec §8.5)', () => {
  it('reports LiveKit media ports another program already holds', async () => {
    const held = createSocket('udp4');
    await new Promise<void>((r) => held.bind(0, '127.0.0.1', () => r()));
    const udpPort = held.address().port;
    try {
      const parent = fakeParentPort();
      const exit = exitRecorder();
      await runHostedServer(parent.port, ['--data', dir.path, '--port', '0'], {
        exit: exit.exit,
        logger: silentLogger,
        mediaPorts: [{ protocol: 'UDP', port: udpPort }],
      });
      const status = await ask(parent, 1, { cmd: 'status' });
      expect(status).toMatchObject({ ok: true, value: { busyMediaPorts: [`UDP ${udpPort}`] } });
      parent.send({ cmd: 'shutdown' });
      expect(await exit.done).toBe(0);
    } finally {
      await new Promise<void>((r) => held.close(() => r()));
    }
  });

  it('with --upnp: maps the ports on the router, reports the WAN, and unmaps on shutdown', async () => {
    const fake = await startFakeIgd();
    try {
      const parent = fakeParentPort();
      const exit = exitRecorder();
      await runHostedServer(parent.port, ['--data', dir.path, '--port', '0', '--host', '0.0.0.0', '--upnp'], {
        exit: exit.exit,
        logger: silentLogger,
        localAddresses: () => [{ ip: '192.168.0.10', interface: 'Ethernet', kind: 'lan' }],
        discover: () => discoverGateway({ ssdpAddress: '127.0.0.1', ssdpPort: fake.ssdpPort, interfaces: ['127.0.0.1'], timeoutMs: 1_500 }),
        mediaPorts: [{ protocol: 'UDP', port: 7882 }],
      });
      const { port } = parent.posted[0] as { port: number };
      let value: { net: { upnp: { state: string; wanIp: string } }; publicAddresses: string[] } | undefined;
      for (let i = 1; i < 50 && value?.net.upnp.state !== 'mapped'; i++) {
        value = ((await ask(parent, i, { cmd: 'status' })) as { value: typeof value }).value;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(value).toMatchObject({ net: { upnp: { state: 'mapped', wanIp: '203.0.113.7' } }, publicAddresses: [`203.0.113.7:${port}`, `192.168.0.10:${port}`] });
      expect([...fake.mappings.keys()].sort()).toEqual([`TCP:${port}`, 'UDP:7882']);
      parent.send({ cmd: 'shutdown' });
      expect(await exit.done).toBe(0);
      expect(fake.mappings.size).toBe(0);
    } finally {
      await fake.close();
    }
  });

  // spec §8.1: in Host mode LiveKit announces the router's WAN IP, so friends on the internet get audio.
  it.skipIf(!resolveLivekitBinary())("with --upnp: LiveKit announces the router's WAN IP (node_ip)", async () => {
    const fake = await startFakeIgd();
    const parent = fakeParentPort();
    const exit = exitRecorder();
    try {
      await runHostedServer(parent.port, ['--data', dir.path, '--port', '0', '--host', '0.0.0.0', '--upnp'], {
        exit: exit.exit,
        logger: silentLogger,
        localAddresses: () => [{ ip: '192.168.0.10', interface: 'Ethernet', kind: 'lan' }],
        discover: () => discoverGateway({ ssdpAddress: '127.0.0.1', ssdpPort: fake.ssdpPort, interfaces: ['127.0.0.1'], timeoutMs: 1_500 }),
        mediaPorts: [],
      });
      expect(parent.posted[0]).toMatchObject({ type: 'ready' });
      // The config is written before the server reports ready: UPnP answered first.
      expect(readFileSync(join(dir.path, 'livekit.yaml'), 'utf8')).toContain('node_ip: "203.0.113.7"');
    } finally {
      if (parent.posted[0]?.type === 'ready') {
        parent.send({ cmd: 'shutdown' });
        await exit.done;
      }
      await fake.close();
    }
    expect(exit.codes).toEqual([0]);
  });
});
