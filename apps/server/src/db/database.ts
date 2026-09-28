import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue, type SQLOutputValue, type StatementSync } from 'node:sqlite';

export type SqlParam = SQLInputValue;
export type Row = Record<string, SQLOutputValue>;

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export class DatabaseTooNewError extends Error {
  constructor(
    public readonly found: number,
    public readonly supported: number,
  ) {
    super(`The database schema is v${found}, but this GhostLink server only knows up to v${supported}. `
      + 'It was written by a newer GhostLink version: update GhostLink, or restore a backup from the backups/ folder.');
    this.name = 'DatabaseTooNewError';
  }
}

const MIGRATION_FILE = /^(\d{3})_([a-z0-9_]+)\.sql$/;
const BACKUPS_TO_KEEP = 3;

/**
 * Reads NNN_name.sql files next to this module (src/db/migrations in dev,
 * dist/migrations in the esbuild bundle, which copies them).
 */
export function loadMigrations(dir: URL = new URL('./migrations/', import.meta.url)): Migration[] {
  const migrations = readdirSync(dir)
    .map((file) => ({ file, match: MIGRATION_FILE.exec(file) }))
    .filter((x): x is { file: string; match: RegExpExecArray } => x.match !== null)
    .map(({ file, match }) => ({
      version: Number(match[1]),
      name: match[2]!,
      sql: readFileSync(new URL(file, dir), 'utf8'),
    }))
    .sort((a, b) => a.version - b.version);
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`migrations must be numbered 001, 002, … without gaps (found ${m.version})`);
  });
  return migrations;
}

/**
 * Thin wrapper over node:sqlite (spec §7). Rows come back as null-prototype
 * objects and BLOBs as Uint8Array; compare keys in SQL or with Buffer.compare.
 */
export class Db {
  readonly path: string;
  readonly #db: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();

  constructor(path: string) {
    this.path = path;
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;');
  }

  get userVersion(): number {
    return Number(this.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0);
  }

  get inTransaction(): boolean {
    return this.#db.isTransaction;
  }

  /**
   * Applies pending migrations, each in its own transaction. Backs up a non-empty
   * database first (VACUUM INTO backups/ghostlink-v<N>.db, keeping the 3 newest)
   * and refuses a database written by a newer server.
   */
  migrate(migrations: readonly Migration[] = loadMigrations()): void {
    const supported = migrations.at(-1)?.version ?? 0;
    const current = this.userVersion;
    if (current > supported) throw new DatabaseTooNewError(current, supported);
    if (current === supported) return;
    if (current > 0) this.#backup(current);
    for (const m of migrations) {
      if (m.version <= current) continue;
      this.tx(() => {
        this.#db.exec(m.sql);
        this.#db.exec(`PRAGMA user_version = ${m.version}`);
      });
    }
  }

  /**
   * Runs `fn` inside BEGIN IMMEDIATE … COMMIT. `fn` must be synchronous: an
   * `await` inside would let other connections interleave (spec §3.5), so a
   * returned promise rolls the transaction back and throws.
   */
  tx<T>(fn: () => T): T {
    if (this.#db.isTransaction) throw new Error('nested Db.tx is not supported');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      if (result instanceof Promise) {
        result.catch(() => {});
        throw new Error('Db.tx callback must be synchronous');
      }
      this.#db.exec('COMMIT');
      return result;
    } catch (e) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw e;
    }
  }

  get<T extends object = Row>(sql: string, ...params: SqlParam[]): T | undefined {
    return this.#prepare(sql).get(...params) as T | undefined;
  }

  all<T extends object = Row>(sql: string, ...params: SqlParam[]): T[] {
    return this.#prepare(sql).all(...params) as T[];
  }

  run(sql: string, ...params: SqlParam[]): { changes: number; lastInsertRowid: number } {
    const r = this.#prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  close(): void {
    this.#statements.clear();
    if (this.#db.isOpen) this.#db.close();
  }

  #prepare(sql: string): StatementSync {
    let stmt = this.#statements.get(sql);
    if (!stmt) {
      stmt = this.#db.prepare(sql);
      this.#statements.set(sql, stmt);
    }
    return stmt;
  }

  #backup(version: number): void {
    const dir = join(dirname(this.path), 'backups');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, `ghostlink-v${version}.db`);
    rmSync(target, { force: true }); // VACUUM INTO refuses to overwrite
    this.#db.prepare('VACUUM INTO ?').run(target);
    const old = readdirSync(dir)
      .map((f) => ({ f, v: /^ghostlink-v(\d+)\.db$/.exec(f)?.[1] }))
      .filter((x): x is { f: string; v: string } => x.v !== undefined)
      .sort((a, b) => Number(b.v) - Number(a.v))
      .slice(BACKUPS_TO_KEEP);
    for (const { f } of old) rmSync(join(dir, f), { force: true });
  }
}
