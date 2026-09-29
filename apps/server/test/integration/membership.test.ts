import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { dataPaths } from '../../src/config/paths.js';
import {
  countUsers,
  getInviteUses,
  getOwner,
  getUser,
  insertBan,
  markRemoved,
  setJoinMode,
  setMaxMembers,
  setPassword,
  withDb,
} from '../helpers/db.js';
import { connectTestClient, makeIdentity, startTestServer, type TestServer } from '../helpers/testClient.js';

const servers: TestServer[] = [];
async function server(opts: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  const t = await startTestServer(opts);
  servers.push(t);
  return t;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.cleanup()));
});

describe('invite mode (default)', () => {
  it('is the default join mode', async () => {
    const t = await server();
    const c = await connectTestClient(t.server, { inviteCode: t.server.createInvite().code });
    expect(c.welcome?.server.joinMode).toBe('invite');
    c.close();
  });

  it('requires an invite for a new identity → INVITE_REQUIRED', async () => {
    const t = await server();
    expect((await connectTestClient(t.server)).error?.code).toBe('INVITE_REQUIRED');
    expect(countUsers(t.dataDir)).toBe(0);
  });

  it.each([
    ['unknown code', 'AAAAAAAAAA'],
    ['malformed code', 'not-a-code!'],
  ])('refuses an %s → INVITE_INVALID', async (_label, code) => {
    const t = await server();
    expect((await connectTestClient(t.server, { inviteCode: code })).error?.code).toBe('INVITE_INVALID');
  });

  it('accepts a valid code (any case) and consumes exactly one use', async () => {
    const t = await server();
    const { code } = t.server.createInvite({ maxUses: 5 });
    const c = await connectTestClient(t.server, { inviteCode: code.toLowerCase() });
    expect(c.welcome).toBeDefined();
    expect(getInviteUses(t.dataDir, code)).toBe(1);
    c.close();
  });

  it('lets an existing member back in without an invite and without consuming one', async () => {
    const t = await server();
    const seed = new Uint8Array(32).fill(1);
    const { code } = t.server.createInvite();
    (await connectTestClient(t.server, { seed, inviteCode: code })).close();
    const again = await connectTestClient(t.server, { seed });
    expect(again.welcome).toBeDefined();
    const withCode = await connectTestClient(t.server, { seed, inviteCode: code });
    expect(withCode.welcome).toBeDefined();
    expect(getInviteUses(t.dataDir, code)).toBe(1);
    withCode.close();
  });

  it('refuses an exhausted invite (max_uses) → INVITE_INVALID', async () => {
    const t = await server();
    const { code } = t.server.createInvite({ maxUses: 1 });
    (await connectTestClient(t.server, { inviteCode: code })).close();
    expect((await connectTestClient(t.server, { inviteCode: code })).error?.code).toBe('INVITE_INVALID');
    expect(getInviteUses(t.dataDir, code)).toBe(1);
  });

  it('refuses an expired invite (injectable clock) → INVITE_INVALID', async () => {
    const clock = { t: Date.now() };
    const t = await server({ now: () => clock.t });
    const { code } = t.server.createInvite({ expiresInHours: 1 });
    clock.t += 3_600_000;
    expect((await connectTestClient(t.server, { inviteCode: code })).error?.code).toBe('INVITE_INVALID');
  });

  it('refuses a revoked invite → INVITE_INVALID', async () => {
    const t = await server();
    const { code } = t.server.createInvite();
    withDb(t.dataDir, (db) => db.run('UPDATE invites SET revoked = 1 WHERE code = ?', code));
    expect((await connectTestClient(t.server, { inviteCode: code })).error?.code).toBe('INVITE_INVALID');
  });

  it('consumes a maxUses=1 invite exactly once when two identities race for it', async () => {
    const t = await server();
    for (let round = 0; round < 5; round++) {
      const { code } = t.server.createInvite({ maxUses: 1 });
      const [a, b] = await Promise.all([
        connectTestClient(t.server, { inviteCode: code, nickname: `a${round}` }),
        connectTestClient(t.server, { inviteCode: code, nickname: `b${round}` }),
      ]);
      const outcomes = [a, b].map((c) => (c.welcome ? 'welcome' : c.error?.code)).sort();
      expect(outcomes).toEqual(['INVITE_INVALID', 'welcome']);
      expect(getInviteUses(t.dataDir, code)).toBe(1);
      a.close();
      b.close();
    }
    expect(countUsers(t.dataDir)).toBe(5);
  });

  it('does not consume the invite when the nickname is taken → NICK_TAKEN', async () => {
    const t = await server();
    (await connectTestClient(t.server, { nickname: 'Ana', inviteCode: t.server.createInvite().code })).close();
    const { code } = t.server.createInvite({ maxUses: 1 });
    const clash = await connectTestClient(t.server, { nickname: 'ＡＮＡ', inviteCode: code }); // fullwidth → "ANA" → "ana"
    expect(clash.error?.code).toBe('NICK_TAKEN');
    expect(getInviteUses(t.dataDir, code)).toBe(0);
    const retry = await connectTestClient(t.server, { nickname: 'Ana#2', inviteCode: code });
    expect(retry.welcome?.self.nickname).toBe('Ana#2');
    retry.close();
  });

  it('does not consume the invite when the server is full → SERVER_FULL', async () => {
    const t = await server();
    const member = new Uint8Array(32).fill(3);
    (await connectTestClient(t.server, { seed: member, inviteCode: t.server.createInvite().code })).close();
    setMaxMembers(t.dataDir, 1);
    const { code } = t.server.createInvite();
    expect((await connectTestClient(t.server, { inviteCode: code })).error?.code).toBe('SERVER_FULL');
    expect(getInviteUses(t.dataDir, code)).toBe(0);
    const back = await connectTestClient(t.server, { seed: member }); // members still get in
    expect(back.welcome).toBeDefined();
    back.close();
  });
});

describe('open mode', () => {
  it('admits anyone with the address, without consuming anything', async () => {
    const t = await server({ joinMode: 'open' });
    const c = await connectTestClient(t.server);
    expect(c.welcome?.server.joinMode).toBe('open');
    c.close();
  });

  it(`limits new identities to 5 per IP per hour; members are not affected`, async () => {
    const clock = { t: Date.now() };
    const t = await server({ joinMode: 'open', now: () => clock.t });
    const first = new Uint8Array(32).fill(9);
    for (let i = 0; i < 5; i++) {
      const c = await connectTestClient(t.server, i === 0 ? { seed: first } : {});
      expect(c.welcome, `identity ${i}`).toBeDefined();
      c.close();
    }
    expect((await connectTestClient(t.server)).error?.code).toBe('RATE_LIMITED');
    expect((await connectTestClient(t.server, { seed: first })).welcome).toBeDefined();
    clock.t += 3_600_001;
    expect((await connectTestClient(t.server)).welcome).toBeDefined();
  });
});

describe('password mode', () => {
  it('asks for the password only on first access', async () => {
    const t = await server({ joinMode: 'password' });
    await setPassword(t.dataDir, 'segredo');
    const seed = new Uint8Array(32).fill(4);
    expect((await connectTestClient(t.server, { seed })).error?.code).toBe('BAD_PASSWORD');
    expect((await connectTestClient(t.server, { seed, password: 'Segredo' })).error?.code).toBe('BAD_PASSWORD');
    const ok = await connectTestClient(t.server, { seed, password: 'segredo' });
    expect(ok.welcome?.server.joinMode).toBe('password');
    ok.close();
    const again = await connectTestClient(t.server, { seed });
    expect(again.welcome).toBeDefined();
    again.close();
  });

  it('refuses everyone new while no password is configured', async () => {
    const t = await server({ joinMode: 'password' });
    expect((await connectTestClient(t.server, { password: 'anything' })).error?.code).toBe('BAD_PASSWORD');
  });

  it('changing the join mode never kicks existing members', async () => {
    const t = await server({ joinMode: 'open' });
    const seed = new Uint8Array(32).fill(5);
    (await connectTestClient(t.server, { seed })).close();
    setJoinMode(t.dataDir, 'password');
    await setPassword(t.dataDir, 'x');
    const c = await connectTestClient(t.server, { seed });
    expect(c.welcome).toBeDefined();
    c.close();
  });
});

describe('setup code → owner (spec §3.3)', () => {
  it('bypasses the invite and makes the first identity the owner; the code is then burned', async () => {
    const t = await server();
    const code = t.server.setupCode()!;
    const owner = await connectTestClient(t.server, { setupCode: code });
    expect(owner.welcome?.self.isOwner).toBe(true);
    expect(getOwner(t.dataDir)).toBe(owner.identity.userId);
    expect(t.server.setupCode()).toBeNull();
    expect(existsSync(dataPaths(t.dataDir).setupCodeFile)).toBe(false);
    owner.close();
    const again = await connectTestClient(t.server, { seed: owner.identity.seed });
    expect(again.welcome?.self.isOwner).toBe(true);
    again.close();
    expect((await connectTestClient(t.server, { setupCode: code })).error?.code).toBe('BAD_SETUP_CODE');
  });

  it('bypasses password and max_members', async () => {
    const t = await server({ joinMode: 'password' });
    await setPassword(t.dataDir, 'pw');
    (await connectTestClient(t.server, { password: 'pw' })).close();
    setMaxMembers(t.dataDir, 1);
    const owner = await connectTestClient(t.server, { setupCode: t.server.setupCode()! });
    expect(owner.welcome?.self.isOwner).toBe(true);
    owner.close();
  });

  it('refuses a wrong setup code → BAD_SETUP_CODE, without falling back to other checks', async () => {
    const t = await server({ joinMode: 'open' });
    const c = await connectTestClient(t.server, { setupCode: '00000000-00000000-00000000-00000000' });
    expect(c.error?.code).toBe('BAD_SETUP_CODE');
    expect(countUsers(t.dataDir)).toBe(0);
  });

  it('lets an existing member claim ownership with the code', async () => {
    const t = await server({ joinMode: 'open' });
    const seed = new Uint8Array(32).fill(6);
    const member = await connectTestClient(t.server, { seed });
    expect(member.welcome?.self.isOwner).toBe(false);
    member.close();
    const owner = await connectTestClient(t.server, { seed, setupCode: t.server.setupCode()! });
    expect(owner.welcome?.self.isOwner).toBe(true);
    owner.close();
  });

  it('two identities racing with the same code: exactly one becomes owner', async () => {
    const t = await server();
    const code = t.server.setupCode()!;
    const results = await Promise.all([
      connectTestClient(t.server, { setupCode: code, nickname: 'one' }),
      connectTestClient(t.server, { setupCode: code, nickname: 'two' }),
    ]);
    const owners = results.filter((c) => c.welcome?.self.isOwner);
    expect(owners).toHaveLength(1);
    expect(results.find((c) => !c.welcome)?.error?.code).toBe('BAD_SETUP_CODE');
    expect(getOwner(t.dataDir)).toBe(owners[0]!.identity.userId);
    expect(countUsers(t.dataDir)).toBe(1); // the loser's insert was rolled back
    for (const c of results) c.close();
  });
});

describe('bans and removal', () => {
  it('refuses a banned identity, even an existing member → BANNED', async () => {
    const t = await server({ joinMode: 'open' });
    const seed = new Uint8Array(32).fill(7);
    const c = await connectTestClient(t.server, { seed });
    c.close();
    insertBan(t.dataDir, { userId: c.identity.userId, publicKey: c.identity.publicKeyRaw });
    expect((await connectTestClient(t.server, { seed })).error?.code).toBe('BANNED');
  });

  it('refuses any identity from a banned IP → BANNED', async () => {
    const t = await server({ joinMode: 'open' });
    insertBan(t.dataDir, { userId: 'someone-else', ip: '127.0.0.1' });
    expect((await connectTestClient(t.server)).error?.code).toBe('BANNED');
  });

  it('blocks a removed member until rejoin_blocked_until → REJOIN_BLOCKED, then requires a new invite', async () => {
    const clock = { t: Date.now() };
    const t = await server({ now: () => clock.t });
    const seed = new Uint8Array(32).fill(8);
    const c = await connectTestClient(t.server, { seed, inviteCode: t.server.createInvite().code });
    c.close();
    markRemoved(t.dataDir, c.identity.userId, clock.t, clock.t + 600_000); // kicked (spec §7)
    const fresh = t.server.createInvite({ maxUses: 1 });
    expect((await connectTestClient(t.server, { seed, inviteCode: fresh.code })).error?.code).toBe('REJOIN_BLOCKED');
    expect(getInviteUses(t.dataDir, fresh.code)).toBe(0);
    clock.t += 600_001;
    expect((await connectTestClient(t.server, { seed })).error?.code).toBe('INVITE_REQUIRED');
    const back = await connectTestClient(t.server, { seed, inviteCode: fresh.code });
    expect(back.welcome?.self.userId).toBe(c.identity.userId);
    expect(getUser(t.dataDir, c.identity.userId)).toMatchObject({ removed_at: null, rejoin_blocked_until: null });
    expect(getInviteUses(t.dataDir, fresh.code)).toBe(1);
    back.close();
  });

  it('a returning member does not count as a new identity for the per-IP limit', async () => {
    const clock = { t: Date.now() };
    const t = await server({ joinMode: 'open', now: () => clock.t });
    const seeds = Array.from({ length: 5 }, (_, i) => new Uint8Array(32).fill(20 + i));
    for (const seed of seeds) (await connectTestClient(t.server, { seed })).close();
    markRemoved(t.dataDir, makeIdentity(seeds[0]).userId, clock.t, null);
    const back = await connectTestClient(t.server, { seed: seeds[0] });
    expect(back.welcome).toBeDefined();
    back.close();
  });
});
