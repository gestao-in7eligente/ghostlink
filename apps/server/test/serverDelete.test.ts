import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FEATURE_SERVER_DELETE, SERVER_DELETE_LIMITS, type ErrorCode } from '@ghostlink/shared';
import { createServerDeleteModule, type ServerDeleteModule } from '../src/deletion/index.js';
import { silentLogger, startServer, type GhostServer } from '../src/index.js';
import { createTextModule } from '../src/text/index.js';
import { countUsers, getInviteUses, withDb } from './helpers/db.js';
import { connectTestClient } from './helpers/testClient.js';
import { channelId, joinServer, nextClientMsgId, textFixture, type TextClient } from './text/helpers.js';

const HOUR = 3_600_000;
const GRACE = SERVER_DELETE_LIMITS.graceMs;
const AVATAR = `${'ab'.repeat(32)}.png`;

/** A handshake that must be refused: the error event as sent (code and, for SERVER_DELETING, `at`). */
async function refusal(server: GhostServer, opts: { seed?: Uint8Array; inviteCode?: string } = {}): Promise<{ code: ErrorCode; at?: number }> {
  const c = await connectTestClient(server, opts);
  c.close();
  if (!c.error) throw new Error('handshake unexpectedly admitted');
  return c.error;
}

async function deleteFixture(opts: { checkIntervalMs?: number; joinMode?: 'open' | 'invite' } = {}) {
  const deletion = createServerDeleteModule({ checkIntervalMs: opts.checkIntervalMs });
  const f = await textFixture({ joinMode: opts.joinMode, extraModules: [deletion] });
  return { ...f, deletion };
}

/** True when `marker` is in the bytes of the database file or of its WAL. */
function onDisk(dataDir: string, marker: string): boolean {
  return ['ghostlink.db', 'ghostlink.db-wal'].some((file) => {
    const path = join(dataDir, file);
    return existsSync(path) && readFileSync(path).includes(Buffer.from(marker));
  });
}

/** Waits for the server to end this client's session; returns the code it gave. */
async function closedWith(c: TextClient): Promise<ErrorCode | null> {
  await c.closed;
  return c.closedWith;
}

describe('server.delete (spec "sair e excluir servidor" §3–§4)', () => {
  it('is owner only, and so is server.restore', async () => {
    const f = await deleteFixture();
    const bia = await f.join({ nickname: 'Bia' });
    expect(f.owner.welcome.features).toContain(FEATURE_SERVER_DELETE);
    expect(f.owner.welcome.serverDelete).toEqual({ deletingAt: null });
    expect(await bia.fail('server.delete', {})).toBe('FORBIDDEN');
    expect(await bia.fail('server.restore', {})).toBe('FORBIDDEN');
    expect(await f.owner.fail('server.delete', { now: true })).toBe('BAD_REQUEST');
    expect(f.t.server.info()).toMatchObject({ deletingAt: null, deleted: false });
    await bia.sync();
    expect(bia.seen('server.deleting')).toEqual([]);
  });

  it('sets the deadline 48 h ahead, tells everyone and closes every session but the owner\'s', async () => {
    const f = await deleteFixture();
    const bia = await f.join({ nickname: 'Bia' });
    const caio = await f.join({ nickname: 'Caio' });
    const at = f.clock.now + GRACE;

    expect(await f.owner.ok('server.delete', {})).toEqual({ at });
    expect(await closedWith(bia)).toBe('SERVER_DELETING');
    expect(await closedWith(caio)).toBe('SERVER_DELETING');
    // The event first, then the error with the deadline.
    expect(bia.events.map((e) => e.t).slice(-2)).toEqual(['server.deleting', 'error']);
    expect(bia.seen('server.deleting')).toEqual([{ at }]);
    expect(bia.seen('error')).toEqual([{ code: 'SERVER_DELETING', at }]);
    expect(await f.owner.event('server.deleting')).toEqual({ at });
    await f.owner.sync(); // still connected
    expect(f.owner.closedWith).toBeNull();
    expect(f.t.server.info()).toMatchObject({ deletingAt: at, deleted: false });

    // A repeat keeps the first deadline.
    f.clock.now += HOUR;
    expect(await f.owner.ok('server.delete', {})).toEqual({ at });
  });

  it('refuses every handshake but the owner\'s while the deadline runs, invites included', async () => {
    const f = await deleteFixture({ joinMode: 'invite' });
    const invite = f.t.server.createInvite();
    const bia = await f.join({ nickname: 'Bia', inviteCode: invite.code });
    const at = (await f.owner.ok<{ at: number }>('server.delete', {})).at;
    await bia.closed;
    const usesBefore = getInviteUses(f.t.dataDir, invite.code);

    expect(await refusal(f.t.server, { seed: bia.seed })).toEqual({ code: 'SERVER_DELETING', at });
    expect(await refusal(f.t.server, { inviteCode: invite.code })).toEqual({ code: 'SERVER_DELETING', at });
    expect(await refusal(f.t.server)).toEqual({ code: 'SERVER_DELETING', at });
    expect(getInviteUses(f.t.dataDir, invite.code)).toBe(usesBefore);

    // The owner comes back normally and learns the deadline from the welcome.
    f.owner.close();
    const back = await joinServer(f.t.server, { seed: f.owner.seed, nickname: 'Dono' });
    expect(back.client?.welcome.serverDelete).toEqual({ deletingAt: at });
    back.client?.close();
  });

  it('server.restore clears the deadline, tells everyone and lets the members back in', async () => {
    const f = await deleteFixture();
    const bia = await f.join({ nickname: 'Bia' });
    await f.owner.ok('server.delete', {});
    await bia.closed;

    expect(await f.owner.ok('server.restore', {})).toEqual({});
    expect(await f.owner.event('server.restored')).toEqual({});
    expect(f.t.server.info()).toMatchObject({ deletingAt: null, deleted: false });
    const again = await f.join({ seed: bia.seed, nickname: 'Bia' });
    expect(again.welcome.serverDelete).toEqual({ deletingAt: null });

    // Restoring a server that is not being deleted does nothing.
    f.owner.clear();
    expect(await f.owner.ok('server.restore', {})).toEqual({});
    await f.owner.sync();
    expect(f.owner.seen('server.restored')).toEqual([]);
  });

  it('allows 5 deletes and 5 restores per hour', async () => {
    const f = await deleteFixture();
    for (let i = 0; i < 5; i++) await f.owner.ok('server.delete', {});
    expect(await f.owner.fail('server.delete', {})).toBe('RATE_LIMITED');
    for (let i = 0; i < 5; i++) await f.owner.ok('server.restore', {});
    expect(await f.owner.fail('server.restore', {})).toBe('RATE_LIMITED');
    expect(f.t.server.info().deletingAt).toBeNull();
    f.clock.now += HOUR;
    await f.owner.ok('server.delete', {});
    expect(f.t.server.info().deletingAt).toBe(f.clock.now + GRACE);
  });
});

describe('the deadline (spec §3.5)', () => {
  it('erases the data, keeps the certificate and refuses everyone, the owner included', async () => {
    const f = await deleteFixture({ checkIntervalMs: 20 });
    const { dataDir } = f.t;
    const keyId = f.t.server.serverKeyId;
    const marker = `segredo-${nextClientMsgId()}-${Date.now()}`;
    await f.owner.ok('msg.send', { channelId: channelId(f.owner, 'geral'), content: marker, clientMsgId: nextClientMsgId() });
    expect(onDisk(dataDir, marker)).toBe(true);
    const bia = await f.join({ nickname: 'Bia' });
    mkdirSync(join(dataDir, 'avatars'), { recursive: true });
    writeFileSync(join(dataDir, 'avatars', AVATAR), 'photo');
    writeFileSync(join(dataDir, 'avatars', 'upload-0a1b.tmp'), 'half');
    writeFileSync(join(dataDir, 'backups', 'ghostlink-v2.db'), marker);
    writeFileSync(join(dataDir, 'setup-code.txt'), 'CODE\n');
    // The Ghost DJ's YouTube cookies (fake ones): the owner's login, not the server's.
    mkdirSync(join(dataDir, 'ghost-dj'), { recursive: true });
    writeFileSync(join(dataDir, 'ghost-dj', 'cookies.txt'), `# Netscape HTTP Cookie File\n${marker}\n`);

    await f.owner.ok('server.delete', {});
    await bia.closed;
    f.clock.now += GRACE - 1;
    f.deletion.check();
    expect(f.t.server.info().deleted).toBe(false); // nothing is erased before the deadline
    expect(existsSync(join(dataDir, 'avatars', AVATAR))).toBe(true);

    f.clock.now += 1;
    expect(await closedWith(f.owner)).toBe('SERVER_DELETED'); // the periodic check
    expect(f.t.server.info()).toMatchObject({ members: 0, hasOwner: false, publicAddresses: [], deletingAt: null, deleted: true });
    withDb(dataDir, (db) => {
      for (const table of ['users', 'messages', 'channels', 'roles', 'invites', 'bans']) {
        expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n, table).toBe(0);
      }
    });
    // No page of the old data survives in the database file nor in its WAL.
    expect(onDisk(dataDir, marker)).toBe(false);
    expect(readdirSync(join(dataDir, 'avatars'))).toEqual([]);
    expect(readdirSync(join(dataDir, 'backups'))).toEqual([]);
    expect(existsSync(join(dataDir, 'setup-code.txt'))).toBe(false);
    expect(existsSync(join(dataDir, 'ghost-dj', 'cookies.txt'))).toBe(false);
    expect(statSync(join(dataDir, 'tls', 'server.key')).isFile()).toBe(true);

    // The pin still matches (connectRaw pins serverKeyId) and everyone is refused.
    expect(f.t.server.serverKeyId).toBe(keyId);
    expect(await refusal(f.t.server, { seed: f.owner.seed })).toEqual({ code: 'SERVER_DELETED' });
    expect(await refusal(f.t.server, { seed: bia.seed })).toEqual({ code: 'SERVER_DELETED' });
    expect(await refusal(f.t.server)).toEqual({ code: 'SERVER_DELETED' });
    expect(f.t.server.setupCode()).toBeNull();
  });

  it('judges the deadline by the clock even between two checks', async () => {
    const f = await deleteFixture(); // the default check: once a minute
    const bia = await f.join({ nickname: 'Bia' });
    await f.owner.ok('server.delete', {});
    await bia.closed;
    f.clock.now += GRACE;
    expect(await refusal(f.t.server, { seed: bia.seed })).toEqual({ code: 'SERVER_DELETED' });
    // A late restore erases at once and ends the owner's session.
    void f.owner.request('server.restore', {}).catch(() => {});
    expect(await closedWith(f.owner)).toBe('SERVER_DELETED');
    expect(f.t.server.info()).toMatchObject({ members: 0, deleted: true });
  });
});

describe('a restart', () => {
  const dirs: string[] = [];
  const servers: GhostServer[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const start = async (dataDir: string, clock: { now: number }): Promise<{ server: GhostServer; deletion: ServerDeleteModule }> => {
    const deletion = createServerDeleteModule();
    const server = await startServer({
      dataDir,
      port: 0,
      host: '127.0.0.1',
      logger: silentLogger,
      joinMode: 'open',
      now: () => clock.now,
      modules: [createTextModule(), deletion],
      limits: { newIdentitiesPerIpPerHour: 1_000, presenceGraceMs: 50 },
    });
    servers.push(server);
    return { server, deletion };
  };

  const stop = async (server: GhostServer): Promise<void> => {
    servers.splice(servers.indexOf(server), 1);
    await server.close();
  };

  it('keeps the deletion before the deadline, and erases at start-up after it', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ghostlink-delete-'));
    dirs.push(dataDir);
    const clock = { now: Date.UTC(2026, 9, 1, 12) };
    const first = await start(dataDir, clock);
    const keyId = first.server.serverKeyId;
    const owner = (await joinServer(first.server, { nickname: 'Dono', setupCode: first.server.setupCode()! })).client!;
    const bia = (await joinServer(first.server, { nickname: 'Bia' })).client!;
    const { at } = await owner.ok<{ at: number }>('server.delete', {});
    await bia.closed;
    owner.close();
    await stop(first.server);
    mkdirSync(join(dataDir, 'avatars'), { recursive: true });
    writeFileSync(join(dataDir, 'avatars', AVATAR), 'photo');

    // Before the deadline: still offline for the members, open to the owner.
    clock.now = at - 1;
    const second = await start(dataDir, clock);
    expect(second.server.info()).toMatchObject({ deletingAt: at, deleted: false, members: 2 });
    expect(await refusal(second.server, { seed: bia.seed })).toEqual({ code: 'SERVER_DELETING', at });
    const back = await joinServer(second.server, { seed: owner.seed, nickname: 'Dono' });
    expect(back.client?.welcome.serverDelete).toEqual({ deletingAt: at });
    back.client?.close();
    await stop(second.server);

    // After it: erased before listening, and nobody gets in.
    clock.now = at + 10 * HOUR;
    const third = await start(dataDir, clock);
    expect(third.server.serverKeyId).toBe(keyId);
    expect(third.server.info()).toMatchObject({ members: 0, hasOwner: false, deleted: true });
    expect(countUsers(dataDir)).toBe(0);
    expect(readdirSync(join(dataDir, 'avatars'))).toEqual([]);
    expect(third.server.setupCode()).toBeNull();
    expect(existsSync(join(dataDir, 'setup-code.txt'))).toBe(false);
    expect(await refusal(third.server, { seed: owner.seed })).toEqual({ code: 'SERVER_DELETED' });
    expect(await refusal(third.server)).toEqual({ code: 'SERVER_DELETED' });
    await stop(third.server);

    // Deleted for good, whatever the clock says afterwards.
    clock.now = at - HOUR;
    const fourth = await start(dataDir, clock);
    expect(fourth.server.info().deleted).toBe(true);
    expect(fourth.server.setupCode()).toBeNull();
    expect(await refusal(fourth.server, { seed: owner.seed })).toEqual({ code: 'SERVER_DELETED' });
  });
});
