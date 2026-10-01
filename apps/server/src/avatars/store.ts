import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AVATAR_HASH, type ImageMime } from '@ghostlink/shared';

const EXTENSION: Readonly<Record<ImageMime, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
const BY_EXTENSION: ReadonlyArray<readonly [string, ImageMime]> = Object.entries(EXTENSION).map(([mime, ext]) => [ext, mime as ImageMime] as const);
/** A stored photo: `<sha256>.<ext>`. */
const STORED = /^([0-9a-f]{64})\.(?:png|jpg|webp|gif)$/;
/** An upload being written (or left half-written by a crash). */
const STAGED = /^upload-[0-9a-f]+\.tmp$/;

export interface StoredAvatar {
  path: string;
  mime: ImageMime;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The photos of a server: `<dataDir>/avatars/<hash>.<ext>`, one file per SHA-256, shared by
 * every member who uses it. An upload is written to a temp file first (stage, async) and
 * then renamed into place (commit, synchronous): the caller points the database at it in
 * the same tick, so a sweep never sees a stored photo that nobody references yet.
 * Paths contain hashes: never log them.
 */
export class AvatarStore {
  constructor(readonly dir: string) {}

  /** Creates the folder and deletes uploads a crash left half-written. */
  open(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(this.dir)) {
      if (STAGED.test(name)) rmSync(join(this.dir, name), { force: true });
    }
  }

  find(hash: string): StoredAvatar | null {
    if (!AVATAR_HASH.test(hash)) return null;
    for (const [ext, mime] of BY_EXTENSION) {
      const path = join(this.dir, `${hash}.${ext}`);
      if (isFile(path)) return { path, mime };
    }
    return null;
  }

  /** Writes the bytes to a new temp file and returns its path, for commit() or discard(). */
  async stage(bytes: Uint8Array): Promise<string> {
    const path = join(this.dir, `upload-${randomBytes(8).toString('hex')}.tmp`);
    try {
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    } catch (e) {
      rmSync(path, { force: true });
      throw e;
    }
    return path;
  }

  /** Moves a staged upload into place; an existing file with that hash is reused. Synchronous on purpose (see the class). */
  commit(staged: string, hash: string, mime: ImageMime): void {
    if (this.find(hash)) {
      rmSync(staged, { force: true });
      return;
    }
    renameSync(staged, join(this.dir, `${hash}.${EXTENSION[mime]}`));
  }

  discard(staged: string): void {
    rmSync(staged, { force: true });
  }

  /** Every stored photo's hash. Unknown files are left alone. */
  hashes(): Set<string> {
    const out = new Set<string>();
    for (const name of readdirSync(this.dir)) {
      const m = STORED.exec(name);
      if (m) out.add(m[1]!);
    }
    return out;
  }

  /** Deletes the stored photos whose hash is not in `keep`; returns how many could not be deleted. */
  sweep(keep: ReadonlySet<string>): number {
    let failed = 0;
    for (const name of readdirSync(this.dir)) {
      const m = STORED.exec(name);
      if (!m || keep.has(m[1]!)) continue;
      try {
        rmSync(join(this.dir, name));
      } catch {
        failed++;
      }
    }
    return failed;
  }
}
