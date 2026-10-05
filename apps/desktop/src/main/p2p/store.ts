// <userData>/friends.db (friends spec §4.4): node:sqlite in WAL mode with numbered migrations,
// like the server's database. Phase 1 holds `me` and `friends`; phase 2 adds the conversations,
// their signed entries and the messages those entries make (DmStore, reached as `store.dm`).
// Not encrypted on disk (spec §1.3): it is protected by the system account, like identity.bin's folder.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { DmAttachmentKind, DmFileInfo } from '../../shared/dmTypes.js';
import type { FriendState } from '../../shared/friendsTypes.js';
import { fileTimestamp, freePath } from '../files.js';
import type { EntryBody, EntryKind } from './entries.js';
import { INVITE_SECRET_BYTES } from './friendCode.js';
import { sameKey } from './friendKey.js';

export const FRIENDS_DB_FILE = 'friends.db';

export interface FriendsMigration {
  version: number;
  sql: string;
}

/** Later phases append 2, 3, … and never edit a step that shipped. */
export const FRIENDS_MIGRATIONS: readonly FriendsMigration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE me (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        -- The friend key this database belongs to: another identity never reads these friends.
        friend_key BLOB NOT NULL CHECK (length(friend_key) = 32),
        invite_secret BLOB NOT NULL CHECK (length(invite_secret) = 16),
        inbox_enabled INTEGER NOT NULL DEFAULT 1 CHECK (inbox_enabled IN (0, 1)),
        available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1))
      ) STRICT;

      CREATE TABLE friends (
        key BLOB PRIMARY KEY CHECK (length(key) = 32),
        nickname TEXT NOT NULL DEFAULT '',
        local_name TEXT,
        state TEXT NOT NULL CHECK (state IN ('pending_out', 'pending_in', 'friend', 'blocked')),
        since INTEGER NOT NULL,
        -- The person's invite secret, kept only until our request reached their inbox.
        invite_secret BLOB CHECK (invite_secret IS NULL OR length(invite_secret) = 16)
      ) STRICT, WITHOUT ROWID;

      CREATE INDEX friends_by_state ON friends (state, since);
    `,
  },
  {
    // Direct messages (phase 2, spec §4.4).
    version: 2,
    sql: `
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY CHECK (length(id) = 32),
        kind TEXT NOT NULL CHECK (kind IN ('dm')),
        created_at INTEGER NOT NULL,
        -- Closed in the sidebar ("×"); a new message shows it again.
        hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
        -- The read mark: the other people's messages up to this ts are read.
        read_ts INTEGER NOT NULL DEFAULT 0,
        -- 1:1 only: the highest seq of our own entries the other person's sync.have covered.
        delivered_seq INTEGER NOT NULL DEFAULT 0
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE members (
        conv TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
        key BLOB NOT NULL CHECK (length(key) = 32),
        joined_at INTEGER NOT NULL,
        left_at INTEGER,
        PRIMARY KEY (conv, key)
      ) STRICT, WITHOUT ROWID;

      -- Every signed entry exactly as its author signed it (spec §4.2): one log per author.
      CREATE TABLE entries (
        conv TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
        author BLOB NOT NULL CHECK (length(author) = 32),
        seq INTEGER NOT NULL CHECK (seq >= 1),
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        sig BLOB NOT NULL CHECK (length(sig) = 64),
        PRIMARY KEY (conv, author, seq)
      ) STRICT;

      -- What the entries say, kept in step with them in the same transaction (a materialized view).
      CREATE TABLE messages (
        conv TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
        id TEXT NOT NULL CHECK (length(id) = 32),
        author BLOB NOT NULL CHECK (length(author) = 32),
        -- The seq of the msg entry: "delivered" compares it with conversations.delivered_seq.
        seq INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        text TEXT NOT NULL,
        reply_to TEXT CHECK (reply_to IS NULL OR length(reply_to) = 32),
        edited_at INTEGER,
        deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
        PRIMARY KEY (conv, id)
      ) STRICT;

      CREATE INDEX messages_by_time ON messages (conv, ts, author, seq);
      CREATE INDEX messages_by_author ON messages (conv, author, seq);
    `,
  },
  {
    // Files of messages (attachments spec §3): what each msg entry says about them. The bytes
    // live in <userData>/friends/files/<hash>; a deleted message loses its rows.
    version: 3,
    sql: `
      CREATE TABLE attachments (
        conv TEXT NOT NULL,
        message TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position >= 0),
        hash TEXT NOT NULL CHECK (length(hash) = 64),
        name TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 1),
        kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'file')),
        mime TEXT NOT NULL,
        width INTEGER,
        height INTEGER,
        PRIMARY KEY (conv, message, position),
        FOREIGN KEY (conv, message) REFERENCES messages (conv, id) ON DELETE CASCADE
      ) STRICT, WITHOUT ROWID;

      CREATE INDEX attachments_by_hash ON attachments (hash, conv);
    `,
  },
];

export class FriendsDbTooNewError extends Error {
  constructor(found: number, supported: number) {
    super(`friends.db is at schema v${found}, but this GhostLink only knows up to v${supported}`);
    this.name = 'FriendsDbTooNewError';
  }
}

/** Applies the pending steps, each in its own transaction; refuses a database from a newer app. */
export function applyMigrations(db: DatabaseSync, migrations: readonly FriendsMigration[] = FRIENDS_MIGRATIONS): void {
  const current = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  const supported = migrations.at(-1)?.version ?? 0;
  if (current > supported) throw new FriendsDbTooNewError(current, supported);
  for (const step of migrations) {
    if (step.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(step.sql);
      db.exec(`PRAGMA user_version = ${step.version}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

export interface FriendRow {
  key: Uint8Array;
  /** The nickname the person announced, as last seen; '' before the first contact. */
  nickname: string;
  localName: string | null;
  state: FriendState;
  /** When the row reached its current state (ms since the epoch). */
  since: number;
  /** Set only while a pending_out request has not reached the person's inbox. */
  inviteSecret: Uint8Array | null;
}

export interface Me {
  inviteSecret: Uint8Array;
  inboxEnabled: boolean;
  available: boolean;
}

interface FriendSqlRow {
  key: Uint8Array;
  nickname: string;
  local_name: string | null;
  state: FriendState;
  since: number;
  invite_secret: Uint8Array | null;
}

interface MeSqlRow {
  friend_key: Uint8Array;
  invite_secret: Uint8Array;
  inbox_enabled: number;
  available: number;
}

const toRow = (r: FriendSqlRow): FriendRow => ({
  key: r.key,
  nickname: r.nickname,
  localName: r.local_name,
  state: r.state,
  since: Number(r.since),
  inviteSecret: r.invite_secret,
});

/** SQLITE_CORRUPT and SQLITE_NOTADB: the file is not a database any more (never a busy or I/O error). */
function isCorrupt(e: unknown): boolean {
  const errcode = (e as { errcode?: unknown } | null)?.errcode;
  return errcode === 11 || errcode === 26;
}

function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON; PRAGMA foreign_keys = ON;');
    applyMigrations(db);
    // Personal data: owner-only on POSIX, like every other file in userData.
    if (process.platform !== 'win32') chmodSync(path, 0o600);
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}

/** Moves a closed database out of the way (never overwriting an older copy), with its WAL leftovers. */
function setAside(path: string, suffix: string): void {
  renameSync(path, freePath(`${path}.${suffix}`));
  for (const extra of ['-wal', '-shm']) rmSync(path + extra, { force: true });
}

/** A conversation as stored (spec §4.4). */
export interface ConversationRow {
  id: string;
  kind: 'dm';
  createdAt: number;
  hidden: boolean;
  /** The other people's messages up to this ts are read. */
  readTs: number;
  /** 1:1: the highest seq of our own entries the other person has (their sync.have said so). */
  deliveredSeq: number;
}

export interface NewConversation {
  id: string;
  kind: 'dm';
  createdAt: number;
  hidden: boolean;
  members: readonly Uint8Array[];
}

/** A signed entry as stored: the keys and the signature as bytes. */
export interface StoredEntry {
  conv: string;
  author: Uint8Array;
  seq: number;
  ts: number;
  kind: EntryKind;
  body: string;
  sig: Uint8Array;
}

/** A message as its entries left it. */
export interface MessageRow {
  conv: string;
  id: string;
  author: Uint8Array;
  /** The seq of the entry that wrote it (the msg entry). */
  seq: number;
  ts: number;
  /** '' once deleted. */
  text: string;
  replyTo: string | null;
  editedAt: number | null;
  deleted: boolean;
}

interface ConversationSqlRow {
  id: string;
  kind: 'dm';
  created_at: number;
  hidden: number;
  read_ts: number;
  delivered_seq: number;
}

interface EntrySqlRow {
  conv: string;
  author: Uint8Array;
  seq: number;
  ts: number;
  kind: EntryKind;
  body: string;
  sig: Uint8Array;
}

interface MessageSqlRow {
  conv: string;
  id: string;
  author: Uint8Array;
  seq: number;
  ts: number;
  text: string;
  reply_to: string | null;
  edited_at: number | null;
  deleted: number;
}

const toConversation = (r: ConversationSqlRow): ConversationRow => ({
  id: r.id,
  kind: r.kind,
  createdAt: Number(r.created_at),
  hidden: r.hidden === 1,
  readTs: Number(r.read_ts),
  deliveredSeq: Number(r.delivered_seq),
});

interface AttachmentSqlRow {
  hash: string;
  name: string;
  size: number;
  kind: DmAttachmentKind;
  mime: string;
  width: number | null;
  height: number | null;
}

const toFile = (r: AttachmentSqlRow): DmFileInfo => ({
  hash: r.hash,
  name: r.name,
  size: Number(r.size),
  kind: r.kind,
  mime: r.mime,
  ...(r.width === null ? {} : { width: Number(r.width) }),
  ...(r.height === null ? {} : { height: Number(r.height) }),
});

const toEntry = (r: EntrySqlRow): StoredEntry => ({ conv: r.conv, author: r.author, seq: Number(r.seq), ts: Number(r.ts), kind: r.kind, body: r.body, sig: r.sig });

const toMessage = (r: MessageSqlRow): MessageRow => ({
  conv: r.conv,
  id: r.id,
  author: r.author,
  seq: Number(r.seq),
  ts: Number(r.ts),
  text: r.text,
  replyTo: r.reply_to,
  editedAt: r.edited_at === null ? null : Number(r.edited_at),
  deleted: r.deleted === 1,
});

/** The display order (spec §4.2): ts, then author, then seq. */
const byTime = (a: MessageRow, b: MessageRow) => a.ts - b.ts || Buffer.compare(a.author, b.author) || a.seq - b.seq;
const NEWEST_FIRST = 'ORDER BY ts DESC, author DESC, seq DESC';

/**
 * The conversations of friends.db (spec §4.4). An entry and the message it makes or changes are
 * written in one transaction, so the `messages` table never disagrees with the log.
 */
export class DmStore {
  readonly #db: DatabaseSync;
  readonly #prepare: (sql: string) => StatementSync;

  constructor(db: DatabaseSync, prepare: (sql: string) => StatementSync) {
    this.#db = db;
    this.#prepare = prepare;
  }

  conversation(id: string): ConversationRow | undefined {
    const row = this.#prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationSqlRow | undefined;
    return row && toConversation(row);
  }

  conversations(): ConversationRow[] {
    return (this.#prepare('SELECT * FROM conversations ORDER BY created_at, id').all() as unknown as ConversationSqlRow[]).map(toConversation);
  }

  /** Creates the conversation with its members; false (and nothing changes) when it exists. */
  createConversation(c: NewConversation): boolean {
    return this.#transaction(() => {
      const insert = this.#prepare('INSERT INTO conversations (id, kind, created_at, hidden) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING');
      if (Number(insert.run(c.id, c.kind, c.createdAt, c.hidden ? 1 : 0).changes) === 0) return false;
      for (const key of c.members) this.#prepare('INSERT INTO members (conv, key, joined_at) VALUES (?, ?, ?)').run(c.id, key, c.createdAt);
      return true;
    });
  }

  /** The current members, in key order. */
  members(id: string): Uint8Array[] {
    return (this.#prepare('SELECT key FROM members WHERE conv = ? AND left_at IS NULL ORDER BY key').all(id) as unknown as { key: Uint8Array }[]).map((r) => r.key);
  }

  /** True when it changed. */
  setHidden(id: string, hidden: boolean): boolean {
    const flag = hidden ? 1 : 0;
    return Number(this.#prepare('UPDATE conversations SET hidden = ? WHERE id = ? AND hidden != ?').run(flag, id, flag).changes) > 0;
  }

  /**
   * Moves the read mark up to `ts`, never back, and never past the newest message of the other
   * people: a message they wrote later with a slower clock still counts as unread. True when it moved.
   */
  markRead(id: string, me: Uint8Array, ts: number): boolean {
    const newest = (this.#prepare('SELECT max(ts) AS ts FROM messages WHERE conv = ? AND author != ?').get(id, me) as { ts: number | null }).ts;
    if (newest === null) return false;
    const mark = Math.min(Math.floor(ts), Number(newest));
    return Number(this.#prepare('UPDATE conversations SET read_ts = ? WHERE id = ? AND read_ts < ?').run(mark, id, mark).changes) > 0;
  }

  /** Raises the delivered mark to `seq`; the mark before, or null when it was already there. */
  raiseDelivered(id: string, seq: number): number | null {
    const before = this.conversation(id)?.deliveredSeq;
    if (before === undefined || seq <= before) return null;
    this.#prepare('UPDATE conversations SET delivered_seq = ? WHERE id = ?').run(seq, id);
    return before;
  }

  /** The highest seq stored for that author (0 for none). */
  head(conv: string, author: Uint8Array): number {
    return Number((this.#prepare('SELECT coalesce(max(seq), 0) AS seq FROM entries WHERE conv = ? AND author = ?').get(conv, author) as { seq: number }).seq);
  }

  /** Every author with entries in that conversation, and their highest seq. */
  heads(conv: string): { author: Uint8Array; seq: number }[] {
    const rows = this.#prepare('SELECT author, max(seq) AS seq FROM entries WHERE conv = ? GROUP BY author ORDER BY author').all(conv) as unknown as { author: Uint8Array; seq: number }[];
    return rows.map((r) => ({ author: r.author, seq: Number(r.seq) }));
  }

  /** That author's entries from `from` to `to` (both included), in seq order. */
  entries(conv: string, author: Uint8Array, from: number, to: number): StoredEntry[] {
    const rows = this.#prepare('SELECT * FROM entries WHERE conv = ? AND author = ? AND seq BETWEEN ? AND ? ORDER BY seq').all(conv, author, from, to);
    return (rows as unknown as EntrySqlRow[]).map(toEntry);
  }

  /**
   * Appends the entry and applies what its body says, in one transaction. Returns the message it
   * made or changed; null when the body changes nothing (unreadable, someone else's message, a
   * message already deleted, an id already taken), in which case the entry is still kept: it is
   * part of its author's log. Throws, leaving nothing behind, when the entry is already there.
   */
  append(entry: StoredEntry, body: EntryBody | null): MessageRow | null {
    return this.#transaction(() => {
      this.#prepare('INSERT INTO entries (conv, author, seq, ts, kind, body, sig) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        entry.conv, entry.author, entry.seq, entry.ts, entry.kind, entry.body, entry.sig,
      );
      if (!body || !this.#apply(entry, body)) return null;
      return this.message(entry.conv, body.id) ?? null;
    });
  }

  message(conv: string, id: string): MessageRow | undefined {
    const row = this.#prepare('SELECT * FROM messages WHERE conv = ? AND id = ?').get(conv, id) as MessageSqlRow | undefined;
    return row && toMessage(row);
  }

  /**
   * Up to `limit` messages with ts before `before` (null: the newest), oldest first. A page never
   * ends between two messages of the same ts, so it can hold a few more than `limit`, and the next
   * page, asked with the oldest ts shown, misses nothing.
   */
  history(conv: string, before: number | null, limit: number): MessageRow[] {
    const page = (this.#prepare(`SELECT * FROM messages WHERE conv = ? AND ts < ? ${NEWEST_FIRST} LIMIT ?`).all(conv, before ?? Number.MAX_SAFE_INTEGER, limit) as unknown as MessageSqlRow[]).map(toMessage);
    const oldest = page.at(-1);
    if (oldest && page.length === limit) {
      const shown = new Set(page.map((m) => m.id));
      const sameTs = (this.#prepare('SELECT * FROM messages WHERE conv = ? AND ts = ?').all(conv, oldest.ts) as unknown as MessageSqlRow[]).map(toMessage);
      page.push(...sameTs.filter((m) => !shown.has(m.id)));
    }
    return page.sort(byTime);
  }

  /** The newest message, for the sidebar. */
  last(conv: string): MessageRow | undefined {
    const row = this.#prepare(`SELECT * FROM messages WHERE conv = ? ${NEWEST_FIRST} LIMIT 1`).get(conv) as MessageSqlRow | undefined;
    return row && toMessage(row);
  }

  /** The other people's messages after the read mark (deleted ones do not count). */
  unread(conv: string, me: Uint8Array): number {
    const row = this.#prepare(
      'SELECT count(*) AS n FROM messages WHERE conv = ? AND author != ? AND deleted = 0 AND ts > (SELECT read_ts FROM conversations WHERE id = ?)',
    ).get(conv, me, conv) as { n: number };
    return Number(row.n);
  }

  /** That author's messages whose msg entry has a seq in (after, upTo]. */
  ownMessages(conv: string, author: Uint8Array, after: number, upTo: number): MessageRow[] {
    const rows = this.#prepare('SELECT * FROM messages WHERE conv = ? AND author = ? AND seq > ? AND seq <= ? ORDER BY seq').all(conv, author, after, upTo);
    return (rows as unknown as MessageSqlRow[]).map(toMessage);
  }

  /** The files of a message, in order ([] once it is deleted). */
  attachments(conv: string, message: string): DmFileInfo[] {
    const rows = this.#prepare('SELECT hash, name, size, kind, mime, width, height FROM attachments WHERE conv = ? AND message = ? ORDER BY position').all(conv, message);
    return (rows as unknown as AttachmentSqlRow[]).map(toFile);
  }

  /** That file as some message of the conversation (not deleted) describes it; undefined when none does. */
  file(conv: string, hash: string): DmFileInfo | undefined {
    const row = this.#prepare('SELECT hash, name, size, kind, mime, width, height FROM attachments WHERE hash = ? AND conv = ? LIMIT 1').get(hash, conv) as AttachmentSqlRow | undefined;
    return row && toFile(row);
  }

  /** Every file of the conversation's messages, once per hash, the newest message first. */
  files(conv: string): DmFileInfo[] {
    const rows = this.#prepare(
      `SELECT a.hash, a.name, a.size, a.kind, a.mime, a.width, a.height FROM attachments a JOIN messages m ON m.conv = a.conv AND m.id = a.message
       WHERE a.conv = ? ORDER BY m.ts DESC, a.position`,
    ).all(conv) as unknown as AttachmentSqlRow[];
    const seen = new Set<string>();
    return rows.filter((r) => !seen.has(r.hash) && seen.add(r.hash)).map(toFile);
  }

  /** How many messages, in every conversation, still carry that file. */
  fileRefs(hash: string): number {
    return Number((this.#prepare('SELECT count(*) AS n FROM attachments WHERE hash = ?').get(hash) as { n: number }).n);
  }

  /** Edit and delete touch only the author's own message, and never one already deleted. */
  #apply(entry: StoredEntry, body: EntryBody): boolean {
    switch (body.kind) {
      case 'msg': {
        const added = Number(
          this.#prepare('INSERT INTO messages (conv, id, author, seq, ts, text, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (conv, id) DO NOTHING')
            .run(entry.conv, body.id, entry.author, entry.seq, entry.ts, body.text, body.replyTo).changes,
        ) > 0;
        if (added) {
          body.attachments.forEach((f, position) => {
            this.#prepare('INSERT INTO attachments (conv, message, position, hash, name, size, kind, mime, width, height) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
              .run(entry.conv, body.id, position, f.hash, f.name, f.size, f.kind, f.mime, f.width ?? null, f.height ?? null);
          });
        }
        return added;
      }
      case 'edit':
        return Number(
          this.#prepare('UPDATE messages SET text = ?, edited_at = ? WHERE conv = ? AND id = ? AND author = ? AND deleted = 0')
            .run(body.text, entry.ts, entry.conv, body.id, entry.author).changes,
        ) > 0;
      case 'delete': {
        const deleted = Number(
          this.#prepare("UPDATE messages SET text = '', deleted = 1 WHERE conv = ? AND id = ? AND author = ? AND deleted = 0")
            .run(entry.conv, body.id, entry.author).changes,
        ) > 0;
        // Its files go with it (attachments spec §1); dm.ts removes the bytes nothing else uses.
        if (deleted) this.#prepare('DELETE FROM attachments WHERE conv = ? AND message = ?').run(entry.conv, body.id);
        return deleted;
      }
    }
  }

  #transaction<T>(fn: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (e) {
      this.#db.exec('ROLLBACK');
      throw e;
    }
  }
}

export class FriendsStore {
  readonly #db: DatabaseSync;
  /** Prepared once: the firewall asks get() for every knock on the friend key. */
  readonly #statements = new Map<string, StatementSync>();
  #me: Me;
  /** The conversations (phase 2), in the same database. */
  readonly dm: DmStore;

  private constructor(db: DatabaseSync, me: Me) {
    this.#db = db;
    this.#me = me;
    this.dm = new DmStore(db, (sql) => this.#prepare(sql));
  }

  /**
   * Opens the database of that friend key. A file that belongs to another identity becomes
   * friends.db.bak-<date> (the way identity.bin is kept when it is replaced), and an unreadable
   * one friends.db.corrupt-<date>; both start over with an empty list. Nothing is ever deleted.
   */
  static open(userDataDir: string, friendKey: Uint8Array, opts: { now?: () => Date } = {}): FriendsStore {
    const path = join(userDataDir, FRIENDS_DB_FILE);
    const stamp = () => fileTimestamp((opts.now ?? (() => new Date()))());
    let db: DatabaseSync;
    try {
      db = openDb(path);
    } catch (e) {
      if (!isCorrupt(e) || !existsSync(path)) throw e;
      setAside(path, `corrupt-${stamp()}`);
      db = openDb(path);
    }
    let me = db.prepare('SELECT friend_key, invite_secret, inbox_enabled, available FROM me WHERE id = 1').get() as MeSqlRow | undefined;
    if (me && !sameKey(me.friend_key, friendKey)) {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.close();
      setAside(path, `bak-${stamp()}`);
      db = openDb(path);
      me = undefined;
    }
    if (!me) {
      me = { friend_key: friendKey, invite_secret: randomBytes(INVITE_SECRET_BYTES), inbox_enabled: 1, available: 1 };
      db.prepare('INSERT INTO me (id, friend_key, invite_secret) VALUES (1, ?, ?)').run(me.friend_key, me.invite_secret);
    }
    return new FriendsStore(db, { inviteSecret: me.invite_secret, inboxEnabled: me.inbox_enabled === 1, available: me.available === 1 });
  }

  get me(): Me {
    return { ...this.#me };
  }

  setInviteSecret(inviteSecret: Uint8Array): void {
    this.#prepare('UPDATE me SET invite_secret = ? WHERE id = 1').run(inviteSecret);
    this.#me = { ...this.#me, inviteSecret };
  }

  setInboxEnabled(inboxEnabled: boolean): void {
    this.#prepare('UPDATE me SET inbox_enabled = ? WHERE id = 1').run(inboxEnabled ? 1 : 0);
    this.#me = { ...this.#me, inboxEnabled };
  }

  setAvailable(available: boolean): void {
    this.#prepare('UPDATE me SET available = ? WHERE id = 1').run(available ? 1 : 0);
    this.#me = { ...this.#me, available };
  }

  get(key: Uint8Array): FriendRow | undefined {
    const row = this.#prepare('SELECT * FROM friends WHERE key = ?').get(key) as FriendSqlRow | undefined;
    return row && toRow(row);
  }

  list(): FriendRow[] {
    return (this.#prepare('SELECT * FROM friends ORDER BY key').all() as unknown as FriendSqlRow[]).map(toRow);
  }

  /** Inserts the row, or replaces the one with the same key. */
  put(row: FriendRow): void {
    this.#prepare(
      `INSERT INTO friends (key, nickname, local_name, state, since, invite_secret) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET nickname = excluded.nickname, local_name = excluded.local_name,
         state = excluded.state, since = excluded.since, invite_secret = excluded.invite_secret`,
    ).run(row.key, row.nickname, row.localName, row.state, row.since, row.inviteSecret);
  }

  remove(key: Uint8Array): boolean {
    return Number(this.#prepare('DELETE FROM friends WHERE key = ?').run(key).changes) > 0;
  }

  count(...states: FriendState[]): number {
    const marks = states.map(() => '?').join(', ');
    return Number((this.#prepare(`SELECT count(*) AS n FROM friends WHERE state IN (${marks})`).get(...states) as { n: number }).n);
  }

  /** The row that has been in that state the longest. */
  oldest(state: FriendState): FriendRow | undefined {
    const row = this.#prepare('SELECT * FROM friends WHERE state = ? ORDER BY since, key LIMIT 1').get(state) as FriendSqlRow | undefined;
    return row && toRow(row);
  }

  close(): void {
    this.#statements.clear();
    if (this.#db.isOpen) this.#db.close();
  }

  #prepare(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.#db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }
}
