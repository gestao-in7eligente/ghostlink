import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatFingerprint, parseJoinInput } from '@ghostlink/shared';
import { runCli, type CliIo } from '../../src/cli.js';
import { SERVER_VERSION } from '../../src/index.js';
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
