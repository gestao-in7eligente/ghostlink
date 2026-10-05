import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProtocolError, parseJoinInput } from '@ghostlink/shared';
import { DatabaseTooNewError } from '../../src/db/database.js';
import { silentLogger, startServer } from '../../src/index.js';
import { withDb } from '../helpers/db.js';
import { connectRaw, connectTestClient, startTestServer, type TestServer } from '../helpers/testClient.js';

const servers: TestServer[] = [];
const dirs: string[] = [];
async function server(opts: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const t = await startTestServer({ joinMode: 'open', ...opts });
  servers.push(t);
  return t;
}
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ghostlink-life-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.cleanup()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('single session per identity', () => {
  it('a new login closes the previous one with SESSION_REPLACED', async () => {
    const t = await server();
    const seed = new Uint8Array(32).fill(1);
    const first = await connectTestClient(t.server, { seed });
    const second = await connectTestClient(t.server, { seed });
    expect(await first.waitEvent('error')).toEqual({ t: 'error', d: { code: 'SESSION_REPLACED' } });
    expect(await first.raw.closed).toEqual({ code: 4000, reason: 'SESSION_REPLACED' });
    expect(await second.request('ping')).toMatchObject({ ok: true });
    second.close();
  });

  it('other identities are unaffected', async () => {
    const t = await server();
    const a = await connectTestClient(t.server);
    const b = await connectTestClient(t.server);
    expect(await a.request('ping')).toMatchObject({ ok: true });
    a.close();
    b.close();
  });
});

describe('graceful shutdown', () => {
  it('sends SERVER_SHUTDOWN to authenticated and unauthenticated sockets, then stops listening', async () => {
    const t = await startTestServer({ joinMode: 'open' });
    const authed = await connectTestClient(t.server);
    const pending = await connectRaw(t.server);
    await t.server.close();
    expect(await authed.waitEvent('error')).toEqual({ t: 'error', d: { code: 'SERVER_SHUTDOWN' } });
    expect(await pending.next()).toEqual({ t: 'error', d: { code: 'SERVER_SHUTDOWN' } });
    expect((await pending.closed).reason).toBe('SERVER_SHUTDOWN');
    await expect(new Promise((resolve, reject) => {
      request({ host: '127.0.0.1', port: t.server.port, path: '/health', rejectUnauthorized: false }, resolve).on('error', reject).end();
    })).rejects.toThrow();
    await t.server.close(); // idempotent
    rmSync(t.dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
});

describe('persistence across restarts', () => {
  it('keeps serverKeyId, name, members and invites; first-run options are ignored later', async () => {
    const dataDir = tempDir();
    const first = await startServer({ dataDir, port: 0, host: '127.0.0.1', logger: silentLogger, name: 'Primeiro', joinMode: 'invite' });
    const invite = first.createInvite({ maxUses: 2 });
    const seed = new Uint8Array(32).fill(2);
    const member = await connectTestClient(first, { seed, inviteCode: invite.code });
    expect(member.welcome).toBeDefined();
    const keyId = first.serverKeyId;
    await first.close();

    const second = await startServer({ dataDir, port: 0, host: '127.0.0.1', logger: silentLogger, name: 'Outro', joinMode: 'open' });
    try {
      expect(second.serverKeyId).toBe(keyId);
      const back = await connectTestClient(second, { seed });
      expect(back.welcome?.server).toMatchObject({ name: 'Primeiro', joinMode: 'invite' });
      back.close();
      const other = await connectTestClient(second, { inviteCode: invite.code });
      expect(other.welcome).toBeDefined(); // second use of the same invite
      other.close();
    } finally {
      await second.close();
    }
  });

  it('refuses to start on a database from a newer version', async () => {
    const dataDir = tempDir();
    const s = await startServer({ dataDir, port: 0, host: '127.0.0.1', logger: silentLogger });
    await s.close();
    withDb(dataDir, (db) => db.exec('PRAGMA user_version = 999'));
    await expect(startServer({ dataDir, port: 0, host: '127.0.0.1', logger: silentLogger })).rejects.toBeInstanceOf(DatabaseTooNewError);
  });

  it('reports EADDRINUSE and releases the database so a retry works', async () => {
    const t = await server();
    const dataDir = tempDir();
    await expect(startServer({ dataDir, port: t.server.port, host: '127.0.0.1', logger: silentLogger }))
      .rejects.toMatchObject({ code: 'EADDRINUSE' });
    const retry = await startServer({ dataDir, port: 0, host: '127.0.0.1', logger: silentLogger });
    await retry.close();
  });
});

describe('GhostServer.createInvite', () => {
  it('uses the configured public addresses and the server name', async () => {
    const t = await server({ name: 'Casa', publicAddresses: ['203.0.113.9:7700', 'casa.example:7710', '203.0.113.9'] });
    const info = t.server.createInvite({ maxUses: 3, expiresInHours: 24 });
    expect(parseJoinInput(info.link)).toEqual({
      kind: 'invite',
      invite: { addresses: ['203.0.113.9:7700', 'casa.example:7710'], serverKeyId: t.server.serverKeyId, inviteCode: info.code, name: 'Casa' },
    });
    expect(parseJoinInput(info.webLink)).toEqual(parseJoinInput(info.pasteCode));
  });

  it('falls back to 127.0.0.1:<port> when no public address is configured', async () => {
    const t = await server();
    const parsed = parseJoinInput(t.server.createInvite().pasteCode);
    expect(parsed.kind === 'invite' && parsed.invite.addresses).toEqual([`127.0.0.1:${t.server.port}`]);
  });

  it('rejects invalid public addresses at startup', async () => {
    await expect(startServer({ dataDir: tempDir(), port: 0, host: '127.0.0.1', logger: silentLogger, publicAddresses: ['bad host'] }))
      .rejects.toBeInstanceOf(ProtocolError);
  });

  it('validates invite options', async () => {
    const t = await server();
    expect(() => t.server.createInvite({ maxUses: 0 })).toThrow(ProtocolError);
  });
});
