import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeNickname, type JoinMode } from '@ghostlink/shared';
import { admit, type AdmissionDeps, type AdmissionRequest } from '../src/auth/admission.js';
import { hashPassword } from '../src/auth/password.js';
import { ensureSetupCode } from '../src/auth/setupCode.js';
import { dataPaths, ensureDataDirs } from '../src/config/paths.js';
import { Db } from '../src/db/database.js';
import { ensureMeta, getMeta } from '../src/db/serverMeta.js';
import { createInvite } from '../src/invites/invites.js';
import { SlidingWindowLimiter } from '../src/ratelimit/limiter.js';
import { makeIdentity, type TestIdentity } from './helpers/identity.js';

interface Env {
  dir: string;
  db: Db;
  clock: { t: number };
  deps: AdmissionDeps;
}
const envs: Env[] = [];
afterEach(() => {
  for (const e of envs.splice(0)) {
    e.db.close();
    rmSync(e.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function env(joinMode: JoinMode): Env {
  const dir = mkdtempSync(join(tmpdir(), 'ghostlink-admit-'));
  const db = new Db(ensureDataDirs(dir).db);
  db.migrate();
  ensureMeta(db, { name: 'S', joinMode, now: 0 });
  const clock = { t: 10_000_000 };
  const deps: AdmissionDeps = { db, dataDir: dir, now: () => clock.t, newIdentities: new SlidingWindowLimiter(5, 3_600_000, () => clock.t) };
  const e = { dir, db, clock, deps };
  envs.push(e);
  return e;
}

function req(id: TestIdentity, extra: Partial<AdmissionRequest> & { nick?: string } = {}): AdmissionRequest {
  const { nick = `n${id.userId.slice(0, 8)}`, ...rest } = extra;
  return {
    userId: id.userId,
    publicKey: id.publicKeyRaw,
    nickname: normalizeNickname(nick),
    locale: 'pt-BR',
    ip: '203.0.113.1',
    ipKey: '203.0.113.1',
    ...rest,
  };
}

const uses = (db: Db, code: string) => Number(db.get<{ uses: number }>('SELECT uses FROM invites WHERE code = ?', code)?.uses);
const users = (db: Db) => Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n);

describe('admit — open mode', () => {
  it('inserts a new member with the normalized nickname', async () => {
    const e = env('open');
    const id = makeIdentity();
    const r = await admit(req(id, { nick: ' Ana ' }), e.deps);
    expect(r).toEqual({ ok: true, user: { id: id.userId, nickname: 'Ana', isOwner: false }, created: true });
    expect(e.db.get('SELECT nickname, nickname_norm, last_ip, joined_at FROM users WHERE id = ?', id.userId))
      .toEqual({ nickname: 'Ana', nickname_norm: 'ana', last_ip: '203.0.113.1', joined_at: e.clock.t });
  });

  it('lets an existing member in and only refreshes last_seen/last_ip/locale', async () => {
    const e = env('open');
    const id = makeIdentity();
    await admit(req(id, { nick: 'Ana' }), e.deps);
    e.clock.t += 1_000;
    const r = await admit(req(id, { nick: 'Other', ip: '198.51.100.2', locale: 'en' }), e.deps);
    expect(r).toMatchObject({ ok: true, user: { nickname: 'Ana' }, created: false });
    expect(e.db.get('SELECT nickname, last_ip, locale, last_seen_at FROM users WHERE id = ?', id.userId))
      .toEqual({ nickname: 'Ana', last_ip: '198.51.100.2', locale: 'en', last_seen_at: e.clock.t });
  });

  it('refuses a taken nickname (case/NFKC-insensitive) → NICK_TAKEN, not a credential failure', async () => {
    const e = env('open');
    await admit(req(makeIdentity(), { nick: 'Ana' }), e.deps);
    expect(await admit(req(makeIdentity(), { nick: 'ＡＮＡ' }), e.deps)).toEqual({ ok: false, code: 'NICK_TAKEN', countsAsFailure: false });
  });

  it('allows 5 new identities per IP per hour → then RATE_LIMITED; other IPs and members are unaffected', async () => {
    const e = env('open');
    const first = makeIdentity();
    await admit(req(first), e.deps);
    for (let i = 0; i < 4; i++) expect((await admit(req(makeIdentity()), e.deps)).ok).toBe(true);
    expect(await admit(req(makeIdentity()), e.deps)).toEqual({ ok: false, code: 'RATE_LIMITED', countsAsFailure: false });
    expect((await admit(req(makeIdentity(), { ipKey: '198.51.100.9' }), e.deps)).ok).toBe(true);
    expect((await admit(req(first), e.deps)).ok).toBe(true);
    e.clock.t += 3_600_001;
    expect((await admit(req(makeIdentity()), e.deps)).ok).toBe(true);
  });
});

describe('admit — invite mode', () => {
  it('requires an invite → INVITE_REQUIRED (credential failure)', async () => {
    const e = env('invite');
    expect(await admit(req(makeIdentity()), e.deps)).toEqual({ ok: false, code: 'INVITE_REQUIRED', countsAsFailure: true });
    expect(users(e.db)).toBe(0);
  });

  it('refuses malformed and unknown codes → INVITE_INVALID', async () => {
    const e = env('invite');
    expect(await admit(req(makeIdentity(), { inviteCode: '!!' }), e.deps)).toMatchObject({ ok: false, code: 'INVITE_INVALID', countsAsFailure: true });
    expect(await admit(req(makeIdentity(), { inviteCode: 'AAAAAAAAAA' }), e.deps)).toMatchObject({ ok: false, code: 'INVITE_INVALID' });
  });

  it('consumes one use per new identity and none for members', async () => {
    const e = env('invite');
    const { code } = createInvite(e.db, { now: 0 });
    const id = makeIdentity();
    expect((await admit(req(id, { inviteCode: code.toLowerCase() }), e.deps)).ok).toBe(true);
    expect((await admit(req(id, { inviteCode: code }), e.deps)).ok).toBe(true);
    expect((await admit(req(id), e.deps)).ok).toBe(true);
    expect(uses(e.db, code)).toBe(1);
  });

  it('gives the use back when a later check fails in the same transaction (NICK_TAKEN, SERVER_FULL)', async () => {
    const e = env('invite');
    const { code } = createInvite(e.db, { maxUses: 1, now: 0 });
    const seed = createInvite(e.db, { now: 0 }).code;
    await admit(req(makeIdentity(), { nick: 'Ana', inviteCode: seed }), e.deps);
    expect(await admit(req(makeIdentity(), { nick: 'ana', inviteCode: code }), e.deps)).toMatchObject({ code: 'NICK_TAKEN' });
    expect(uses(e.db, code)).toBe(0);
    e.db.run('UPDATE server_meta SET max_members = 1');
    expect(await admit(req(makeIdentity(), { inviteCode: code }), e.deps)).toEqual({ ok: false, code: 'SERVER_FULL', countsAsFailure: false });
    expect(uses(e.db, code)).toBe(0);
  });

  it('reports INVITE_INVALID before NICK_TAKEN (fix the invite first)', async () => {
    const e = env('invite');
    await admit(req(makeIdentity(), { nick: 'Ana', inviteCode: createInvite(e.db, { now: 0 }).code }), e.deps);
    expect(await admit(req(makeIdentity(), { nick: 'Ana', inviteCode: 'AAAAAAAAAA' }), e.deps)).toMatchObject({ code: 'INVITE_INVALID' });
  });
});

describe('admit — password mode', () => {
  it('checks the password only for new identities', async () => {
    const e = env('password');
    e.db.run('UPDATE server_meta SET password_hash = ?', await hashPassword('pw'));
    const id = makeIdentity();
    expect(await admit(req(id), e.deps)).toEqual({ ok: false, code: 'BAD_PASSWORD', countsAsFailure: true });
    expect(await admit(req(id, { password: 'PW' }), e.deps)).toMatchObject({ ok: false, code: 'BAD_PASSWORD' });
    expect((await admit(req(id, { password: 'pw' }), e.deps)).ok).toBe(true);
    expect((await admit(req(id), e.deps)).ok).toBe(true);
  });

  it('refuses everyone new while no password is set', async () => {
    const e = env('password');
    expect(await admit(req(makeIdentity(), { password: 'x' }), e.deps)).toMatchObject({ ok: false, code: 'BAD_PASSWORD' });
  });
});

describe('admit — setup code', () => {
  it('makes the owner, bypassing invite and max_members, and burns the code', async () => {
    const e = env('invite');
    e.db.run('UPDATE server_meta SET max_members = 1');
    await admit(req(makeIdentity(), { inviteCode: createInvite(e.db, { now: 0 }).code }), e.deps);
    const code = ensureSetupCode(e.db, e.dir)!;
    const owner = makeIdentity();
    expect(await admit(req(owner, { setupCode: code }), e.deps)).toMatchObject({ ok: true, user: { isOwner: true } });
    expect(getMeta(e.db)).toMatchObject({ ownerUserId: owner.userId, setupCodeHash: null });
    expect(existsSync(dataPaths(e.dir).setupCodeFile)).toBe(false);
    expect(await admit(req(makeIdentity(), { setupCode: code }), e.deps)).toEqual({ ok: false, code: 'BAD_SETUP_CODE', countsAsFailure: true });
    expect((await admit(req(owner), e.deps))).toMatchObject({ ok: true, user: { isOwner: true } });
  });

  it('does not use up a new-identity slot', async () => {
    const e = env('open');
    const code = ensureSetupCode(e.db, e.dir)!;
    await admit(req(makeIdentity(), { setupCode: code }), e.deps);
    for (let i = 0; i < 5; i++) expect((await admit(req(makeIdentity()), e.deps)).ok).toBe(true);
  });

  it('keeps NICK_TAKEN and leaves the code usable', async () => {
    const e = env('open');
    await admit(req(makeIdentity(), { nick: 'Ana' }), e.deps);
    const code = ensureSetupCode(e.db, e.dir)!;
    expect(await admit(req(makeIdentity(), { nick: 'ana', setupCode: code }), e.deps)).toMatchObject({ code: 'NICK_TAKEN' });
    expect(getMeta(e.db).ownerUserId).toBeNull();
    expect(existsSync(dataPaths(e.dir).setupCodeFile)).toBe(true);
  });
});

describe('admit — bans and removal', () => {
  type BanRow = { userId: string; publicKey: Uint8Array | null; ip: string | null };
  it.each<[string, (id: TestIdentity) => BanRow]>([
    ['user id', (id) => ({ userId: id.userId, publicKey: null, ip: null })],
    ['public key', (id) => ({ userId: 'other', publicKey: id.publicKeyRaw, ip: null })],
    ['IP (/64 key)', () => ({ userId: 'other', publicKey: null, ip: '203.0.113.1' })],
  ])('refuses a ban by %s → BANNED', async (_label, row) => {
    const e = env('open');
    const id = makeIdentity();
    const ban = row(id);
    e.db.run('INSERT INTO bans (user_id, public_key, ip, created_at) VALUES (?, ?, ?, 0)', ban.userId, ban.publicKey, ban.ip);
    expect(await admit(req(id), e.deps)).toEqual({ ok: false, code: 'BANNED', countsAsFailure: true });
  });

  it('blocks rejoining until rejoin_blocked_until, then reactivates the same user through the join mode', async () => {
    const e = env('invite');
    const id = makeIdentity();
    await admit(req(id, { nick: 'Ana', inviteCode: createInvite(e.db, { now: 0 }).code }), e.deps);
    e.db.run('UPDATE users SET removed_at = ?, rejoin_blocked_until = ? WHERE id = ?', e.clock.t, e.clock.t + 600_000, id.userId);
    const { code } = createInvite(e.db, { maxUses: 1, now: 0 });
    expect(await admit(req(id, { inviteCode: code }), e.deps)).toEqual({ ok: false, code: 'REJOIN_BLOCKED', countsAsFailure: false });
    e.clock.t += 600_001;
    expect(await admit(req(id), e.deps)).toMatchObject({ code: 'INVITE_REQUIRED' });
    expect(await admit(req(id, { nick: 'Ana 2', inviteCode: code }), e.deps)).toEqual({
      ok: true, user: { id: id.userId, nickname: 'Ana 2', isOwner: false }, created: false,
    });
    expect(e.db.get('SELECT removed_at, rejoin_blocked_until FROM users WHERE id = ?', id.userId)).toEqual({ removed_at: null, rejoin_blocked_until: null });
    expect(uses(e.db, code)).toBe(1);
  });
});
