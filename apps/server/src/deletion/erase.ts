import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { dataPaths } from '../config/paths.js';
import type { Db } from '../db/database.js';

/** server_meta.name after the erase (NOT NULL); /health shows it. */
export const ERASED_SERVER_NAME = 'GhostLink';

/** The folders whose content is erased (the folders themselves stay: modules keep their paths). */
const ERASED_DIRS = ['avatars', 'backups'] as const;

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Erases the database in place, keeping the file, its schema and the server_meta row (which
 * keeps `deleting_at` and gets `deleted_at`, so a restart still refuses everyone). Why in place
 * instead of deleting or recreating the file while the server runs:
 *   - every module holds this same open Db (and its cached statements); swapping the file under
 *     them would leave dangling handles, and on Windows an open SQLite file cannot be deleted;
 *   - one transaction empties every table: a crash leaves all the data or none of it, and the
 *     next start (or the next check) runs the erase again;
 *   - `secure_delete = ON` (set by Db) overwrites the deleted content, VACUUM rebuilds the file
 *     without free pages, and the TRUNCATE checkpoints leave an empty WAL, so no old page with
 *     the data survives in ghostlink.db or ghostlink.db-wal.
 * Idempotent and synchronous. Throws when SQLite refuses (the caller retries later).
 */
export function eraseDatabase(db: Db, now: number): void {
  // Every table but server_meta, including ones later migrations add. SQLite's own tables are
  // left alone, except sqlite_sequence (AUTOINCREMENT counters), which is emptied too.
  const tables = db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'server_meta' AND name NOT LIKE 'sqlite!_%' ESCAPE '!'")
    .map((r) => r.name);
  const hasSequence = db.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'") !== undefined;
  db.tx(() => {
    // Checked at COMMIT, when every table is empty: the delete order does not matter.
    db.exec('PRAGMA defer_foreign_keys = ON');
    for (const table of tables) db.exec(`DELETE FROM ${quoteIdentifier(table)}`);
    if (hasSequence) db.exec('DELETE FROM sqlite_sequence');
    db.run(
      `UPDATE server_meta SET name = ?, icon_file_id = NULL, password_hash = NULL, owner_user_id = NULL,
         setup_code_hash = NULL, public_addresses = '[]', deleted_at = COALESCE(deleted_at, ?) WHERE id = 1`,
      ERASED_SERVER_NAME,
      now,
    );
  });
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.exec('VACUUM');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

/**
 * Deletes the files with data: the profile photos (and half-written uploads) in avatars/, the
 * database backups in backups/ (copies of the whole database) and setup-code.txt. The TLS
 * certificate stays, so the pin (serverKeyId) stays the same, and so do the LiveKit keys and
 * status.json, which hold nothing about the members. Returns how many entries could not be
 * deleted (e.g. a file still open); never throws. Paths contain hashes: never log them.
 */
export function eraseFiles(dataDir: string): number {
  let failed = 0;
  const remove = (path: string): void => {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      failed++;
    }
  };
  for (const dir of ERASED_DIRS) {
    let names: string[];
    try {
      names = readdirSync(join(dataDir, dir));
    } catch (e) {
      if ((e as { code?: unknown }).code !== 'ENOENT') failed++;
      continue;
    }
    for (const name of names) remove(join(dataDir, dir, name));
  }
  remove(dataPaths(dataDir).setupCodeFile);
  return failed;
}
