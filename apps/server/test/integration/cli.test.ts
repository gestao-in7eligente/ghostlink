import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatFingerprint, parseJoinInput } from '@ghostlink/shared';
import { runCli, type CliIo } from '../../src/cli.js';
import { SERVER_VERSION } from '../../src/index.js';
import { resolveLivekitBinary } from '../../src/livekit/binary.js';
import { withDb } from '../helpers/db.js';
import { connectTestClient, startTestServer, type TestServer } from '../helpers/testClient.js';

function capture(): CliIo & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (l) => stdout.push(l), err: (l) => stderr.push(l) };
}

const servers: TestServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.cleanup()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
async function server(opts: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const t = await startTestServer(opts);
  servers.push(t);
  return t;
}

describe('ghostlink-server CLI', () => {
  it('version prints the package version', async () => {
    const io = capture();
    expect(await runCli(['version'], io, {})).toBe(0);
    expect(io.stdout).toEqual([SERVER_VERSION]);
  });

  it('--help exits 0; no command, unknown command or unknown flag exit 1', async () => {
    const help = capture();
    expect(await runCli(['--help'], help, {})).toBe(0);
    expect(help.stdout.join('\n')).toMatch(/Usage: ghostlink-server/);
    expect(await runCli([], capture(), {})).toBe(1);
    const unknown = capture();
    expect(await runCli(['frobnicate'], unknown, {})).toBe(1);
    expect(unknown.stderr[0]).toMatch(/Unknown command/);
    const flag = capture();
    expect(await runCli(['status', '--nope'], flag, {})).toBe(1);
    expect(flag.stderr.join('\n')).toMatch(/--help/);
  });

  it('requires a data directory', async () => {
    const io = capture();
    expect(await runCli(['status'], io, {})).toBe(1);
    expect(io.stderr[0]).toMatch(/--data/);
  });

  it('refuses to operate on a directory without server data', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'ghostlink-cli-empty-'));
    dirs.push(empty);
    for (const command of ['status', 'invite', 'setup-code']) {
      const io = capture();
      expect(await runCli([command, '--data', empty], io, {}), command).toBe(1);
      expect(io.stderr[0]).toMatch(/No GhostLink server data/);
    }
  });

  it('invite works against a running server and the code is accepted by it', async () => {
    const t = await server({ publicAddresses: ['198.51.100.7:7700'], name: 'VPS' });
    const io = capture();
    expect(await runCli(['invite', '--data', t.dataDir, '--max-uses', '1', '--expires', '2d'], io, {})).toBe(0);
    const code = /^Invite code: ([A-Z2-7]{10})$/.exec(io.stdout[0]!)![1]!;
    const web = io.stdout.find((l) => l.startsWith('Web link'))!.split(': ')[1]!;
    expect(parseJoinInput(web)).toEqual({
      kind: 'invite',
      invite: { addresses: ['198.51.100.7:7700'], serverKeyId: t.server.serverKeyId, inviteCode: code, name: 'VPS' },
    });
    const row = withDb(t.dataDir, (db) => db.get<{ max_uses: number; expires_at: number }>('SELECT max_uses, expires_at FROM invites WHERE code = ?', code))!;
    expect(row.max_uses).toBe(1);
    expect(row.expires_at - Date.now()).toBeGreaterThan(47 * 3_600_000);
    const client = await connectTestClient(t.server, { inviteCode: code });
    expect(client.welcome).toBeDefined();
    client.close();
  });

  it('invite refuses when no public address is configured', async () => {
    const t = await server();
    const io = capture();
    expect(await runCli(['invite', '--data', t.dataDir], io, {})).toBe(1);
    expect(io.stderr[0]).toMatch(/--public-address/);
  });

  it.each([
    [['--max-uses', '0']],
    [['--max-uses', 'abc']],
    [['--expires', '10m']],
  ])('invite validates %j', async (flags) => {
    const t = await server({ publicAddresses: ['198.51.100.7:7700'] });
    expect(await runCli(['invite', '--data', t.dataDir, ...flags], capture(), {})).toBe(1);
  });

  it('setup-code prints the pending code, then reports the owner', async () => {
    const t = await server();
    const io = capture();
    expect(await runCli(['setup-code', '--data', t.dataDir], io, {})).toBe(0);
    expect(io.stdout).toEqual([t.server.setupCode()]);
    (await connectTestClient(t.server, { setupCode: io.stdout[0]! })).close();
    const after = capture();
    expect(await runCli(['setup-code'], after, { GHOSTLINK_DATA: t.dataDir })).toBe(0);
    expect(after.stdout[0]).toMatch(/already has an owner/);
  });

  it('status prints the fingerprint in the same format as the app', async () => {
    const t = await server({ name: 'Status', publicAddresses: ['198.51.100.7:7700'] });
    const io = capture();
    expect(await runCli(['status', '--data', t.dataDir], io, {})).toBe(0);
    const text = io.stdout.join('\n');
    expect(text).toContain(`Fingerprint: ${formatFingerprint(t.server.serverKeyId)}`);
    expect(text).toContain('Name: Status');
    expect(text).toContain('Join mode: invite');
    expect(text).toContain('Members: 0 / 100');
    expect(text).toContain('Public addresses: 198.51.100.7:7700');
  });
});

function tempData(): string {
  const d = mkdtempSync(join(tmpdir(), 'ghostlink-cli-'));
  dirs.push(d);
  return d;
}

async function freePort(): Promise<number> {
  for (;;) {
    const s = await new Promise<Server>((r) => {
      const srv = createServer();
      srv.listen(0, '127.0.0.1', () => r(srv));
    });
    const { port } = s.address() as { port: number };
    await new Promise<void>((r) => s.close(() => r()));
    if (port > 1024 && port < 60_000) return port;
  }
}

describe('ghostlink-server start (spec §10)', () => {
  /** Runs `start` until the output shows it is up, then stops it like SIGTERM would. */
  async function runStart(flags: string[]) {
    const io = capture();
    let stop!: () => void;
    const stopped = new Promise<void>((r) => {
      stop = r;
    });
    const exit = runCli(['start', ...flags], io, {}, { untilStop: stopped });
    for (let i = 0; i < 200 && !io.stdout.some((l) => l.startsWith('Fingerprint:')) && io.stderr.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    stop();
    return { io, code: await exit };
  }

  it('starts, prints fingerprint, setup code, node IP and addresses, and stops cleanly', async () => {
    const data = tempData();
    const port = await freePort();
    const { io, code } = await runStart(['--data', data, '--port', String(port), '--host', '127.0.0.1', '--node-ip', '203.0.113.9', '--public-address', 'vps.example.com:7700']);
    expect(code).toBe(0);
    const text = io.stdout.join('\n');
    expect(text).toContain(`Listening on 127.0.0.1:${port}`);
    expect(text).toMatch(/Fingerprint: [A-Z2-7]{8} [A-Z2-7]{8} [A-Z2-7]{8} [A-Z2-7]{8}/);
    expect(text).toMatch(/Setup code \(use it once to become the owner\): [0-9a-f]{8}-/);
    expect(text).toContain('Node IP (announced for voice): 203.0.113.9');
    expect(text).toContain('Public addresses: vps.example.com:7700');
    expect(text).toContain('UPnP: off');
    expect(text).toContain('Shutting down');
  });

  // install.sh runs `start --node-ip <public IP>` on a VPS (spec §8.1, §10): LiveKit must announce it.
  it.skipIf(!resolveLivekitBinary())('--node-ip reaches the LiveKit config', async () => {
    const data = tempData();
    const { io, code } = await runStart(['--data', data, '--port', String(await freePort()), '--host', '127.0.0.1', '--node-ip', '203.0.113.9']);
    expect(code, io.stderr.join(' / ')).toBe(0);
    expect(readFileSync(join(data, 'livekit.yaml'), 'utf8')).toContain('node_ip: "203.0.113.9"');
    expect(io.stdout).toContain('Node IP (announced for voice): 203.0.113.9');
  });

  it('exits 2 on a busy port and suggests the next free one', async () => {
    const t = await server();
    const io = capture();
    expect(await runCli(['start', '--data', tempData(), '--port', String(t.server.port), '--host', '127.0.0.1'], io, {})).toBe(2);
    const text = io.stderr.join('\n');
    expect(text).toMatch(new RegExp(`Port ${t.server.port} is already in use by another program`));
    expect(text).toMatch(/--port \d+/);
    expect(text).toMatch(/old invites/i);
  });

  it.each([[['--node-ip', 'example.com']], [['--node-ip', '999.1.1.1']], [['--port', '70000']]])('refuses %j', async (flags) => {
    const io = capture();
    expect(await runCli(['start', '--data', tempData(), ...flags], io, {})).toBe(1);
  });
});

describe('ghostlink-server reset-owner (spec §3.3 "Recuperar posse")', () => {
  it('issues a new setup code that makes another identity the owner', async () => {
    const t = await server({ joinMode: 'open' });
    (await connectTestClient(t.server, { setupCode: t.server.setupCode()!, nickname: 'Old' })).close();
    const io = capture();
    expect(await runCli(['reset-owner', '--data', t.dataDir], io, {})).toBe(0);
    const code = /([0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8})/.exec(io.stdout.join('\n'))![1]!;
    expect(readFileSync(join(t.dataDir, 'setup-code.txt'), 'utf8').trim()).toBe(code);
    const next = await connectTestClient(t.server, { setupCode: code, nickname: 'New' });
    expect(next.welcome?.self.isOwner).toBe(true);
    next.close();
    expect(existsSync(join(t.dataDir, 'setup-code.txt'))).toBe(false);
  });

  it('refuses a directory without server data', async () => {
    const io = capture();
    expect(await runCli(['reset-owner', '--data', tempData()], io, {})).toBe(1);
    expect(io.stderr[0]).toMatch(/No GhostLink server data/);
  });
});
