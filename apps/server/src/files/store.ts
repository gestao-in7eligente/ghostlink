import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { STAGED_NAME } from '../uploads/http.js';

/** A stored attachment: 128 random bits in hex, nothing taken from the file or its name. */
const STORED = /^[0-9a-f]{32}$/;

/**
 * The bytes of a server's attachments: `<dataDir>/files/<disk_name>` (main spec §7). An upload
 * is written to a temp file by the upload hub and renamed into place by commit(), which is
 * synchronous: the caller inserts the row in the same tick, so a sweep never sees a stored
 * file that no row references yet. Names are random, but never log paths anyway.
 */
export class FileStore {
  constructor(readonly dir: string) {}

  /** Creates the folder and deletes uploads a crash left half-written. */
  open(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(this.dir)) {
      if (STAGED_NAME.test(name)) rmSync(join(this.dir, name), { force: true });
    }
  }

  path(diskName: string): string {
    if (!STORED.test(diskName)) throw new Error('not a stored file name');
    return join(this.dir, diskName);
  }

  /** Moves a staged upload into place under a new random name, and returns that name. */
  commit(staged: string): string {
    const diskName = randomBytes(16).toString('hex');
    renameSync(staged, join(this.dir, diskName));
    return diskName;
  }

  remove(diskName: string): void {
    rmSync(this.path(diskName), { force: true });
  }

  /** Every stored file's name. Unknown files are left alone. */
  names(): Set<string> {
    return new Set(readdirSync(this.dir).filter((name) => STORED.test(name)));
  }

  /** Deletes the stored files whose name is not in `keep`; returns how many could not be deleted. */
  sweep(keep: ReadonlySet<string>): number {
    let failed = 0;
    for (const name of this.names()) {
      if (keep.has(name)) continue;
      try {
        rmSync(join(this.dir, name));
      } catch {
        failed++;
      }
    }
    return failed;
  }
}
