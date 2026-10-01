import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { EntryBody } from '../../src/main/p2p/entries.js';
import { FRIENDS_DB_FILE, FRIENDS_MIGRATIONS, FriendsDbTooNewError, FriendsStore, applyMigrations, type FriendRow, type StoredEntry } from '../../src/main/p2p/store.js';
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
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((t) => t.name)).toEqual(['conversations', 'entries', 'friends', 'me', 'members', 'messages']);
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

describe('friends.db migration 2: conversations (friends spec §4.4)', () => {
  it('upgrades a phase 1 database and keeps its friends', () => {
    const path = join(dir.path, FRIENDS_DB_FILE);
    const db = new DatabaseSync(path);
    applyMigrations(db, FRIENDS_MIGRATIONS.slice(0, 1));
    db.prepare('INSERT INTO me (id, friend_key, invite_secret) VALUES (1, ?, ?)').run(ME, new Uint8Array(16));
    db.prepare("INSERT INTO friends (key, state, since) VALUES (?, 'friend', 5)").run(new Uint8Array(32).fill(2));
    db.close();
    const store = openStore();
    expect(store.list()).toHaveLength(1);
    expect(store.dm.conversations()).toEqual([]);
  });
});

describe('DmStore (friends spec §4.2, §4.4)', () => {
  const ANA = new Uint8Array(32).fill(0xa1);
  const BIA = new Uint8Array(32).fill(0xb2);
  const CONV = 'c0'.repeat(16);
  const id = (n: number) => n.toString(16).padStart(32, '0');
  const ids = (rows: { id: string }[]) => rows.map((r) => Number.parseInt(r.id, 16));

  function withConversation(): FriendsStore {
    const store = openStore(ANA);
    expect(store.dm.createConversation({ id: CONV, kind: 'dm', createdAt: 100, hidden: false, members: [ANA, BIA] })).toBe(true);
    return store;
  }

  function stored(author: Uint8Array, seq: number, ts: number, kind: StoredEntry['kind'] = 'msg'): StoredEntry {
    return { conv: CONV, author, seq, ts, kind, body: `{"n":${seq}}`, sig: new Uint8Array(64).fill(seq) };
  }

  /** Appends `author`'s next msg entry, making message number `n`. */
  function say(store: FriendsStore, author: Uint8Array, n: number, ts: number, text = `m${n}`, replyTo: string | null = null) {
    const seq = store.dm.head(CONV, author) + 1;
    return store.dm.append(stored(author, seq, ts), { kind: 'msg', id: id(n), text, replyTo });
  }

  it('creates a conversation once, with its members', () => {
    const store = withConversation();
    expect(store.dm.createConversation({ id: CONV, kind: 'dm', createdAt: 999, hidden: true, members: [ANA, BIA] })).toBe(false);
    expect(store.dm.conversation(CONV)).toEqual({ id: CONV, kind: 'dm', createdAt: 100, hidden: false, readTs: 0, deliveredSeq: 0 });
    expect(store.dm.conversation('d0'.repeat(16))).toBeUndefined();
    expect(store.dm.members(CONV).map(hex)).toEqual([hex(ANA), hex(BIA)]);
    expect(store.dm.conversations().map((c) => c.id)).toEqual([CONV]);
  });

  it('appends an entry and the message it makes in one go', () => {
    const store = withConversation();
    const message = say(store, BIA, 1, 1_000, 'oi', null);
    expect(message).toEqual({ conv: CONV, id: id(1), author: BIA, seq: 1, ts: 1_000, text: 'oi', replyTo: null, editedAt: null, deleted: false });
    expect(store.dm.message(CONV, id(1))).toEqual(message);
    expect(store.dm.head(CONV, BIA)).toBe(1);
    expect(store.dm.head(CONV, ANA)).toBe(0);
    expect(store.dm.entries(CONV, BIA, 1, 10)).toEqual([stored(BIA, 1, 1_000)]);
  });

  it('keeps the entries in seq order, per author, and lists the heads', () => {
    const store = withConversation();
    for (let n = 1; n <= 5; n++) say(store, ANA, n, 1_000 + n);
    say(store, BIA, 10, 2_000);
    expect(store.dm.heads(CONV).map((h) => [hex(h.author), h.seq])).toEqual([[hex(ANA), 5], [hex(BIA), 1]]);
    expect(store.dm.entries(CONV, ANA, 2, 4).map((e) => e.seq)).toEqual([2, 3, 4]);
    expect(store.dm.entries(CONV, ANA, 4, 99).map((e) => e.seq)).toEqual([4, 5]);
    expect(store.dm.entries(CONV, BIA, 2, 99)).toEqual([]);
  });

  it('refuses the same seq twice and leaves the message as it was', () => {
    const store = withConversation();
    say(store, BIA, 1, 1_000, 'oi');
    expect(() => store.dm.append(stored(BIA, 1, 1_000, 'edit'), { kind: 'edit', id: id(1), text: 'mudou' })).toThrow();
    expect(store.dm.message(CONV, id(1))!.text).toBe('oi');
    expect(store.dm.head(CONV, BIA)).toBe(1);
  });

  it('leaves no entry behind when its effect fails', () => {
    const store = withConversation();
    expect(() => store.dm.append(stored(BIA, 1, 1_000), { kind: 'msg', id: 'not-an-id', text: 'oi', replyTo: null })).toThrow();
    expect(store.dm.head(CONV, BIA)).toBe(0);
    expect(store.dm.history(CONV, null, 50)).toEqual([]);
  });

  it('refuses an entry of a conversation it does not have', () => {
    const store = withConversation();
    expect(() => store.dm.append({ ...stored(BIA, 1, 1_000), conv: 'd0'.repeat(16) }, { kind: 'msg', id: id(1), text: 'oi', replyTo: null })).toThrow();
  });

  it('stores an entry that changes nothing (a body it could not read)', () => {
    const store = withConversation();
    expect(store.dm.append(stored(BIA, 1, 1_000), null)).toBeNull();
    expect(store.dm.head(CONV, BIA)).toBe(1);
    expect(store.dm.history(CONV, null, 50)).toEqual([]);
  });

  it("edits and deletes only the author's own message, and the entry stays either way", () => {
    const store = withConversation();
    say(store, ANA, 1, 1_000, 'oi');
    // Bia's edit of Ana's message is kept in Bia's log and changes nothing.
    expect(store.dm.append(stored(BIA, 1, 1_100, 'edit'), { kind: 'edit', id: id(1), text: 'hackeado' })).toBeNull();
    expect(store.dm.append(stored(BIA, 2, 1_200, 'delete'), { kind: 'delete', id: id(1) })).toBeNull();
    expect(store.dm.head(CONV, BIA)).toBe(2);
    expect(store.dm.message(CONV, id(1))).toMatchObject({ text: 'oi', editedAt: null, deleted: false });

    expect(store.dm.append(stored(ANA, 2, 1_300, 'edit'), { kind: 'edit', id: id(1), text: 'oi!' })).toMatchObject({ text: 'oi!', editedAt: 1_300, deleted: false });
    expect(store.dm.append(stored(ANA, 3, 1_400, 'delete'), { kind: 'delete', id: id(1) })).toMatchObject({ text: '', editedAt: 1_300, deleted: true });
    // A deleted message stays deleted.
    expect(store.dm.append(stored(ANA, 4, 1_500, 'edit'), { kind: 'edit', id: id(1), text: 'volta' })).toBeNull();
    expect(store.dm.append(stored(ANA, 5, 1_600, 'delete'), { kind: 'delete', id: id(1) })).toBeNull();
    expect(store.dm.message(CONV, id(1))).toMatchObject({ text: '', deleted: true });
    // An edit of a message that does not exist changes nothing.
    expect(store.dm.append(stored(ANA, 6, 1_700, 'edit'), { kind: 'edit', id: id(9), text: 'x' })).toBeNull();
  });

  it('never lets a message take the id of another', () => {
    const store = withConversation();
    say(store, ANA, 1, 1_000, 'meu');
    const body: EntryBody = { kind: 'msg', id: id(1), text: 'roubado', replyTo: null };
    expect(store.dm.append(stored(BIA, 1, 1_100), body)).toBeNull();
    expect(store.dm.message(CONV, id(1))).toMatchObject({ author: ANA, text: 'meu' });
    expect(store.dm.head(CONV, BIA)).toBe(1);
  });

  it('pages the history by ts, oldest first, ties broken by author and seq', () => {
    const store = withConversation();
    say(store, ANA, 1, 1_000);
    say(store, BIA, 2, 3_000);
    say(store, ANA, 3, 2_000);
    say(store, BIA, 4, 2_000);
    say(store, ANA, 5, 2_000);
    expect(ids(store.dm.history(CONV, null, 50))).toEqual([1, 3, 5, 4, 2]);
    expect(ids(store.dm.history(CONV, 3_000, 50))).toEqual([1, 3, 5, 4]);
    expect(ids(store.dm.history(CONV, 2_000, 50))).toEqual([1]);
    expect(ids(store.dm.history(CONV, null, 1))).toEqual([2]);
    expect(store.dm.history(CONV, 1_000, 50)).toEqual([]);
  });

  it('never cuts a page between messages of the same ts', () => {
    const store = withConversation();
    say(store, ANA, 1, 1_000);
    say(store, ANA, 2, 2_000);
    say(store, BIA, 3, 2_000);
    say(store, ANA, 4, 3_000);
    // Asked for 2: the newest is 4, the next has ts 2000, and so has another one.
    const page = store.dm.history(CONV, null, 2);
    expect(ids(page)).toEqual([2, 3, 4]);
    // The next page, before the oldest ts shown, misses nothing.
    expect(ids(store.dm.history(CONV, page[0]!.ts, 2))).toEqual([1]);
  });

  it('gives the newest message of a conversation', () => {
    const store = withConversation();
    expect(store.dm.last(CONV)).toBeUndefined();
    say(store, ANA, 1, 2_000);
    say(store, BIA, 2, 1_000);
    expect(store.dm.last(CONV)!.id).toBe(id(1));
  });

  it("counts the other person's messages after the read mark, deleted ones aside", () => {
    const store = withConversation();
    say(store, BIA, 1, 1_000);
    say(store, BIA, 2, 2_000);
    say(store, ANA, 3, 2_500);
    say(store, BIA, 4, 3_000);
    expect(store.dm.unread(CONV, ANA)).toBe(3);
    expect(store.dm.markRead(CONV, ANA, 2_000)).toBe(true);
    expect(store.dm.conversation(CONV)!.readTs).toBe(2_000);
    expect(store.dm.unread(CONV, ANA)).toBe(1);
    // Never back.
    expect(store.dm.markRead(CONV, ANA, 1_500)).toBe(false);
    expect(store.dm.unread(CONV, ANA)).toBe(1);
    store.dm.append(stored(BIA, 4, 3_100, 'delete'), { kind: 'delete', id: id(4) });
    expect(store.dm.unread(CONV, ANA)).toBe(0);
  });

  it('never moves the read mark past the newest message of the other person', () => {
    const store = withConversation();
    say(store, BIA, 1, 1_000);
    say(store, ANA, 2, 5_000);
    // "Read up to now": what Bia writes later, even with an older clock, still counts as unread.
    expect(store.dm.markRead(CONV, ANA, 9_000)).toBe(true);
    expect(store.dm.conversation(CONV)!.readTs).toBe(1_000);
    say(store, BIA, 3, 4_000);
    expect(store.dm.unread(CONV, ANA)).toBe(1);
    // Nothing from the other person yet: there is nothing to mark.
    const other = 'd0'.repeat(16);
    store.dm.createConversation({ id: other, kind: 'dm', createdAt: 1, hidden: false, members: [ANA, new Uint8Array(32).fill(3)] });
    expect(store.dm.markRead(other, ANA, 9_000)).toBe(false);
  });

  it('raises the delivered mark only upwards and finds the own messages it covers', () => {
    const store = withConversation();
    say(store, ANA, 1, 1_000);
    store.dm.append(stored(ANA, 2, 1_100, 'edit'), { kind: 'edit', id: id(1), text: 'x' });
    say(store, ANA, 3, 1_200);
    say(store, BIA, 4, 1_300);
    expect(store.dm.raiseDelivered(CONV, 2)).toBe(0);
    expect(store.dm.conversation(CONV)!.deliveredSeq).toBe(2);
    expect(store.dm.raiseDelivered(CONV, 2)).toBeNull();
    expect(store.dm.raiseDelivered(CONV, 1)).toBeNull();
    expect(ids(store.dm.ownMessages(CONV, ANA, 0, 2))).toEqual([1]);
    expect(ids(store.dm.ownMessages(CONV, ANA, 2, 3))).toEqual([3]);
  });

  it('hides and shows a conversation', () => {
    const store = withConversation();
    expect(store.dm.setHidden(CONV, true)).toBe(true);
    expect(store.dm.setHidden(CONV, true)).toBe(false);
    expect(store.dm.conversation(CONV)!.hidden).toBe(true);
    expect(store.dm.setHidden(CONV, false)).toBe(true);
    expect(store.dm.conversation(CONV)!.hidden).toBe(false);
  });

  it('keeps everything across restarts', () => {
    const store = withConversation();
    say(store, BIA, 1, 1_000, 'oi', null);
    say(store, ANA, 2, 1_100, 'resposta', id(1));
    store.dm.markRead(CONV, ANA, 1_000);
    store.close();
    const again = openStore(ANA);
    expect(again.dm.conversation(CONV)).toMatchObject({ readTs: 1_000 });
    expect(again.dm.history(CONV, null, 50).map((m) => [m.text, m.replyTo])).toEqual([['oi', null], ['resposta', id(1)]]);
    expect(again.dm.head(CONV, ANA)).toBe(1);
  });
});
