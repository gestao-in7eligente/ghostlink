// <userData>/friends.db (friends spec §4.4): node:sqlite in WAL mode with numbered migrations,
// like the server's database. Phase 1 holds `me` and `friends`; conversations come with phase 2.
// Not encrypted on disk (spec §1.3): it is protected by the system account, like identity.bin's folder.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FriendState } from '../../shared/friendsTypes.js';
import { fileTimestamp, freePath } from '../files.js';
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
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;');
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

export class FriendsStore {
  readonly #db: DatabaseSync;
  #me: Me;

  private constructor(db: DatabaseSync, me: Me) {
    this.#db = db;
    this.#me = me;
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
    this.#db.prepare('UPDATE me SET invite_secret = ? WHERE id = 1').run(inviteSecret);
    this.#me = { ...this.#me, inviteSecret };
  }

  setInboxEnabled(inboxEnabled: boolean): void {
    this.#db.prepare('UPDATE me SET inbox_enabled = ? WHERE id = 1').run(inboxEnabled ? 1 : 0);
    this.#me = { ...this.#me, inboxEnabled };
  }

  setAvailable(available: boolean): void {
    this.#db.prepare('UPDATE me SET available = ? WHERE id = 1').run(available ? 1 : 0);
    this.#me = { ...this.#me, available };
  }

  get(key: Uint8Array): FriendRow | undefined {
    const row = this.#db.prepare('SELECT * FROM friends WHERE key = ?').get(key) as FriendSqlRow | undefined;
    return row && toRow(row);
  }

  list(): FriendRow[] {
    return (this.#db.prepare('SELECT * FROM friends ORDER BY key').all() as unknown as FriendSqlRow[]).map(toRow);
  }

  /** Inserts the row, or replaces the one with the same key. */
  put(row: FriendRow): void {
    this.#db
      .prepare(
        `INSERT INTO friends (key, nickname, local_name, state, since, invite_secret) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET nickname = excluded.nickname, local_name = excluded.local_name,
           state = excluded.state, since = excluded.since, invite_secret = excluded.invite_secret`,
      )
      .run(row.key, row.nickname, row.localName, row.state, row.since, row.inviteSecret);
  }

  remove(key: Uint8Array): boolean {
    return Number(this.#db.prepare('DELETE FROM friends WHERE key = ?').run(key).changes) > 0;
  }

  count(...states: FriendState[]): number {
    const marks = states.map(() => '?').join(', ');
    return Number((this.#db.prepare(`SELECT count(*) AS n FROM friends WHERE state IN (${marks})`).get(...states) as { n: number }).n);
  }

  /** The row that has been in that state the longest. */
  oldest(state: FriendState): FriendRow | undefined {
    const row = this.#db.prepare('SELECT * FROM friends WHERE state = ? ORDER BY since, key LIMIT 1').get(state) as FriendSqlRow | undefined;
    return row && toRow(row);
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }
}
