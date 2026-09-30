import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { FRIENDS_DB_FILE, FRIENDS_MIGRATIONS, FriendsDbTooNewError, FriendsStore, applyMigrations, type FriendRow } from '../../src/main/p2p/store.js';
import { useTempDir } from '../helpers/tempDir.js';

const dir = useTempDir();
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const ME = new Uint8Array(32).fill(1);
const at = () => new Date(2026, 8, 30, 9, 15, 0);
const open: FriendsStore[] = [];

function openStore(friendKey: Uint8Array = ME): FriendsStore {
  const store = FriendsStore.open(dir.path, friendKey, { now: at });
  open.push(store);
  return store;
}

function row(fill: number, patch: Partial<FriendRow> = {}): FriendRow {
  return { key: new Uint8Array(32).fill(fill), nickname: `n${fill}`, localName: null, state: 'friend', since: 1_000 + fill, inviteSecret: null, ...patch };
}

afterEach(() => {
  for (const store of open.splice(0)) store.close();
});

describe('FriendsStore (friends spec §4.4)', () => {
  it('creates <userData>/friends.db in WAL mode at the newest schema version', () => {
    openStore().close();
    const db = new DatabaseSync(join(dir.path, FRIENDS_DB_FILE));
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: FRIENDS_MIGRATIONS.at(-1)!.version });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((t) => t.name)).toEqual(['friends', 'me']);
    db.close();
  });

  it('starts with a random invite secret, the inbox on and available on, and keeps them', () => {
    const first = openStore();
    expect(first.me.inviteSecret).toHaveLength(16);
    expect(first.me).toMatchObject({ inboxEnabled: true, available: true });
    const secret = hex(first.me.inviteSecret);
    first.close();
    expect(hex(openStore().me.inviteSecret)).toBe(secret);
  });

  it('gives every installation its own invite secret', () => {
    const other = join(dir.path, 'other');
    mkdirSync(other);
    const a = openStore();
    const b = FriendsStore.open(other, ME, { now: at });
    open.push(b);
    expect(hex(a.me.inviteSecret)).not.toBe(hex(b.me.inviteSecret));
  });

  it('persists the invite secret, the inbox switch and the available switch', () => {
    const store = openStore();
    const secret = randomBytes(16);
    store.setInviteSecret(secret);
    store.setInboxEnabled(false);
    store.setAvailable(false);
    expect(store.me).toMatchObject({ inboxEnabled: false, available: false });
    store.close();
    const again = openStore();
    expect(hex(again.me.inviteSecret)).toBe(hex(secret));
    expect(again.me).toMatchObject({ inboxEnabled: false, available: false });
    expect(() => again.setInviteSecret(new Uint8Array(15))).toThrow();
  });

  it('stores, updates, lists and removes friends', () => {
    const store = openStore();
    const secret = new Uint8Array(randomBytes(16));
    store.put(row(2, { state: 'pending_out', nickname: '', inviteSecret: secret }));
    store.put(row(3, { state: 'pending_in', localName: 'Bia do trabalho' }));
    expect(store.get(row(2).key)).toEqual(row(2, { state: 'pending_out', nickname: '', inviteSecret: secret }));
    expect(store.get(row(9).key)).toBeUndefined();
    store.put(row(2, { state: 'friend', nickname: 'Ana', since: 5_000 }));
    expect(store.get(row(2).key)).toEqual(row(2, { state: 'friend', nickname: 'Ana', since: 5_000 }));
    expect(store.list().map((r) => hex(r.key))).toEqual([hex(row(2).key), hex(row(3).key)]);
    expect(store.remove(row(3).key)).toBe(true);
    expect(store.remove(row(3).key)).toBe(false);
    store.close();
    expect(openStore().list()).toEqual([row(2, { state: 'friend', nickname: 'Ana', since: 5_000 })]);
  });

  it('counts by state and finds the oldest row of a state', () => {
    const store = openStore();
    store.put(row(2, { state: 'pending_in', since: 300 }));
    store.put(row(3, { state: 'pending_in', since: 100 }));
    store.put(row(4, { state: 'pending_in', since: 200 }));
    store.put(row(5, { state: 'friend' }));
    store.put(row(6, { state: 'pending_out' }));
    expect(store.count('pending_in')).toBe(3);
    expect(store.count('friend', 'pending_out')).toBe(2);
    expect(store.count('blocked')).toBe(0);
    expect(hex(store.oldest('pending_in')!.key)).toBe(hex(row(3).key));
    expect(store.oldest('blocked')).toBeUndefined();
  });

  it('refuses rows the schema does not allow', () => {
    const store = openStore();
    expect(() => store.put(row(2, { state: 'enemy' as FriendRow['state'] }))).toThrow();
    expect(() => store.put(row(2, { key: new Uint8Array(31) }))).toThrow();
    expect(() => store.put(row(2, { inviteSecret: new Uint8Array(8) }))).toThrow();
    expect(store.list()).toEqual([]);
  });
});

describe('FriendsStore and the identity', () => {
  it('keeps the friends of the same friend key across restarts', () => {
    const first = openStore();
    first.put(row(2));
    first.close();
    const again = openStore();
    expect(again.list()).toHaveLength(1);
    again.close();
    expect(readdirSync(dir.path)).toEqual([FRIENDS_DB_FILE]);
  });

  it('sets the database of another identity aside, never mixing two people\'s friends', () => {
    const first = openStore();
    first.put(row(2));
    const secret = hex(first.me.inviteSecret);
    first.close();

    const other = openStore(new Uint8Array(32).fill(7));
    expect(other.list()).toEqual([]);
    expect(hex(other.me.inviteSecret)).not.toBe(secret);
    other.close();
    expect(readdirSync(dir.path).sort()).toEqual([FRIENDS_DB_FILE, `${FRIENDS_DB_FILE}.bak-20260930-091500`]);

    // The file set aside is the first identity's database, intact.
    const kept = new DatabaseSync(join(dir.path, `${FRIENDS_DB_FILE}.bak-20260930-091500`));
    expect(kept.prepare('SELECT count(*) AS n FROM friends').get()).toEqual({ n: 1 });
    kept.close();

    // A second switch never overwrites the first backup.
    openStore(ME).close();
    expect(readdirSync(dir.path).sort()).toEqual([FRIENDS_DB_FILE, `${FRIENDS_DB_FILE}.bak-20260930-091500`, `${FRIENDS_DB_FILE}.bak-20260930-091500-1`]);
  });

  it('keeps an unreadable file as friends.db.corrupt-<date> and starts over', () => {
    writeFileSync(join(dir.path, FRIENDS_DB_FILE), 'this is not a database, not even close to one');
    const store = openStore();
    expect(store.list()).toEqual([]);
    expect(readFileSync(join(dir.path, `${FRIENDS_DB_FILE}.corrupt-20260930-091500`), 'utf8')).toMatch(/^this is not a database/);
  });

  it('refuses a database written by a newer GhostLink and leaves it alone', () => {
    openStore().close();
    const path = join(dir.path, FRIENDS_DB_FILE);
    const db = new DatabaseSync(path);
    db.exec('PRAGMA user_version = 99');
    db.close();
    const before = readFileSync(path);
    expect(() => FriendsStore.open(dir.path, ME, { now: at })).toThrow(FriendsDbTooNewError);
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(readdirSync(dir.path)).toEqual([FRIENDS_DB_FILE]);
  });
});

describe('friends.db migrations', () => {
  it('are numbered 1, 2, 3… without gaps', () => {
    expect(FRIENDS_MIGRATIONS.map((m) => m.version)).toEqual(FRIENDS_MIGRATIONS.map((_, i) => i + 1));
  });

  it('apply each pending step once, in order, and remember the version', () => {
    const db = new DatabaseSync(join(dir.path, 'm.db'));
    const steps = [
      { version: 1, sql: 'CREATE TABLE a (x INTEGER) STRICT; INSERT INTO a VALUES (1);' },
      { version: 2, sql: 'ALTER TABLE a ADD COLUMN y INTEGER; INSERT INTO a VALUES (2, 2);' },
    ];
    applyMigrations(db, steps.slice(0, 1));
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
    applyMigrations(db, steps);
    applyMigrations(db, steps);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 });
    expect(db.prepare('SELECT x, y FROM a ORDER BY x').all()).toEqual([{ x: 1, y: null }, { x: 2, y: 2 }]);
    db.close();
  });

  it('roll a failing step back, leaving the version and the data as they were', () => {
    const db = new DatabaseSync(join(dir.path, 'm.db'));
    applyMigrations(db, [{ version: 1, sql: 'CREATE TABLE a (x INTEGER) STRICT;' }]);
    const broken = [{ version: 1, sql: '' }, { version: 2, sql: 'CREATE TABLE b (x INTEGER) STRICT; INSERT INTO nowhere VALUES (1);' }];
    expect(() => applyMigrations(db, broken)).toThrow();
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'b'").get()).toEqual({ n: 0 });
    db.close();
  });

  it('refuse a version this build does not know', () => {
    const db = new DatabaseSync(join(dir.path, 'm.db'));
    db.exec('PRAGMA user_version = 3');
    expect(() => applyMigrations(db, [{ version: 1, sql: 'CREATE TABLE a (x INTEGER);' }])).toThrow(FriendsDbTooNewError);
    expect(existsSync(join(dir.path, 'm.db'))).toBe(true);
    db.close();
  });
});
