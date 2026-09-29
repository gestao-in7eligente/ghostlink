import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Db, DatabaseTooNewError, loadMigrations, type Migration } from '../src/db/database.js';

let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghostlink-db-'));
  dbPath = join(dir, 'ghostlink.db');
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const m = (version: number, sql: string): Migration => ({ version, name: `m${version}`, sql });

describe('Db basics', () => {
  it('opens in WAL mode with foreign keys, busy timeout and secure_delete', () => {
    const db = new Db(dbPath);
    expect(db.get('PRAGMA journal_mode')).toEqual({ journal_mode: 'wal' });
    expect(db.get('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });
    expect(db.get('PRAGMA busy_timeout')).toEqual({ timeout: 5000 });
    expect(db.get('PRAGMA secure_delete')).toEqual({ secure_delete: 1 });
    db.close();
  });

  it('returns BLOBs as Uint8Array and reports changes', () => {
    const db = new Db(dbPath);
    db.exec('CREATE TABLE t (k BLOB, v INTEGER)');
    expect(db.run('INSERT INTO t VALUES (?, ?)', new Uint8Array([1, 2, 3]), 7)).toEqual({ changes: 1, lastInsertRowid: 1 });
    const row = db.get<{ k: Uint8Array; v: number }>('SELECT * FROM t WHERE k = ?', new Uint8Array([1, 2, 3]));
    expect(row?.k).toBeInstanceOf(Uint8Array);
    expect(Array.from(row!.k)).toEqual([1, 2, 3]);
    expect(db.all('SELECT v FROM t')).toEqual([{ v: 7 }]);
    db.close();
  });
});

describe('Db.tx', () => {
  it('commits on success and rolls back on throw', () => {
    const db = new Db(dbPath);
    db.exec('CREATE TABLE t (v INTEGER)');
    db.tx(() => db.run('INSERT INTO t VALUES (1)'));
    expect(() => db.tx(() => {
      db.run('INSERT INTO t VALUES (2)');
      throw new Error('boom');
    })).toThrow('boom');
    expect(db.all('SELECT v FROM t')).toEqual([{ v: 1 }]);
    expect(db.inTransaction).toBe(false);
    db.close();
  });

  it('refuses an async callback and rolls back its synchronous part', () => {
    const db = new Db(dbPath);
    db.exec('CREATE TABLE t (v INTEGER)');
    expect(() => db.tx(async () => {
      db.run('INSERT INTO t VALUES (1)');
    })).toThrow(/must be synchronous/);
    expect(db.all('SELECT v FROM t')).toEqual([]);
    db.close();
  });

  it('refuses nesting', () => {
    const db = new Db(dbPath);
    expect(() => db.tx(() => db.tx(() => 1))).toThrow(/nested/);
    expect(db.inTransaction).toBe(false);
    db.close();
  });

  it('is exclusive against a second connection (BEGIN IMMEDIATE)', () => {
    const a = new Db(dbPath);
    const b = new Db(dbPath);
    a.exec('CREATE TABLE t (v INTEGER)');
    b.exec('PRAGMA busy_timeout = 0');
    a.tx(() => {
      a.run('INSERT INTO t VALUES (1)');
      expect(() => b.tx(() => b.run('INSERT INTO t VALUES (2)'))).toThrow(/locked|busy/i);
    });
    expect(a.all('SELECT v FROM t')).toEqual([{ v: 1 }]);
    a.close();
    b.close();
  });
});

describe('migrations', () => {
  it('the real migration set starts at 001 and creates the M1 tables', () => {
    const migrations = loadMigrations();
    expect(migrations[0]).toMatchObject({ version: 1, name: 'init' });
    const db = new Db(dbPath);
    db.migrate();
    expect(db.userVersion).toBe(migrations.length);
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['bans', 'invites', 'server_meta', 'users']));
    db.close();
  });

  it('enforces the spec §7 constraints', () => {
    const db = new Db(dbPath);
    db.migrate();
    db.run("INSERT INTO server_meta (id, name, created_at) VALUES (1, 'S', 0)");
    expect(() => db.run("INSERT INTO server_meta (id, name, created_at) VALUES (2, 'S', 0)")).toThrow();
    expect(() => db.run("UPDATE server_meta SET join_mode = 'closed'")).toThrow();
    expect(db.get('SELECT join_mode, max_members FROM server_meta')).toEqual({ join_mode: 'invite', max_members: 100 });
    db.run("INSERT INTO users (id, public_key, nickname, nickname_norm, joined_at) VALUES ('a', x'01', 'A', 'a', 0)");
    expect(() => db.run("INSERT INTO users (id, public_key, nickname, nickname_norm, joined_at) VALUES ('b', x'01', 'B', 'b', 0)")).toThrow(/UNIQUE/);
    expect(() => db.run("INSERT INTO users (id, public_key, nickname, nickname_norm, joined_at) VALUES ('c', x'02', 'A', 'a', 0)")).toThrow(/UNIQUE/);
    expect(() => db.run("INSERT INTO invites (code, created_at, max_uses) VALUES ('X', 0, 0)")).toThrow();
    db.close();
  });

  it('is idempotent and does not back up a fresh database', () => {
    const db = new Db(dbPath);
    db.migrate();
    db.migrate();
    expect(existsSync(join(dir, 'backups'))).toBe(false);
    db.close();
  });

  it('backs up with VACUUM INTO before upgrading an existing database', () => {
    const db = new Db(dbPath);
    db.migrate([m(1, 'CREATE TABLE t (v INTEGER);')]);
    db.run('INSERT INTO t VALUES (42)');
    db.migrate([m(1, 'CREATE TABLE t (v INTEGER);'), m(2, 'ALTER TABLE t ADD COLUMN w INTEGER;')]);
    expect(db.userVersion).toBe(2);
    db.close();
    const backup = new Db(join(dir, 'backups', 'ghostlink-v1.db'));
    expect(backup.userVersion).toBe(1);
    expect(backup.all('SELECT * FROM t')).toEqual([{ v: 42 }]);
    backup.close();
  });

  it('keeps only the 3 most recent backups', () => {
    const db = new Db(dbPath);
    const all = [1, 2, 3, 4, 5].map((v) => m(v, `CREATE TABLE t${v} (v INTEGER);`));
    db.migrate(all.slice(0, 1));
    for (let n = 2; n <= 5; n++) db.migrate(all.slice(0, n));
    db.close();
    expect(readdirSync(join(dir, 'backups')).sort()).toEqual(['ghostlink-v2.db', 'ghostlink-v3.db', 'ghostlink-v4.db']);
  });

  it('rolls back a failing migration completely, including user_version', () => {
    const db = new Db(dbPath);
    db.migrate([m(1, 'CREATE TABLE t (v INTEGER);')]);
    expect(() => db.migrate([m(1, 'CREATE TABLE t (v INTEGER);'), m(2, 'CREATE TABLE u (v INTEGER); THIS IS NOT SQL;')])).toThrow();
    expect(db.userVersion).toBe(1);
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'u'")).toBeUndefined();
    db.close();
  });

  it('refuses a database written by a newer server', () => {
    const db = new Db(dbPath);
    db.exec('PRAGMA user_version = 99');
    expect(() => db.migrate()).toThrow(DatabaseTooNewError);
    try {
      db.migrate();
    } catch (e) {
      expect((e as DatabaseTooNewError).found).toBe(99);
      expect((e as Error).message).toMatch(/newer GhostLink/);
    }
    expect(db.userVersion).toBe(99);
    db.close();
  });

  it('rejects gaps in migration numbering', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ghostlink-mig-'));
    try {
      writeFileSync(join(tmp, '001_a.sql'), 'SELECT 1;');
      writeFileSync(join(tmp, '003_c.sql'), 'SELECT 1;');
      expect(() => loadMigrations(pathToFileURL(`${tmp}/`))).toThrow(/without gaps/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
