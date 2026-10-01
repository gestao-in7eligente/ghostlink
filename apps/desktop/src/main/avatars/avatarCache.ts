// Others' photos (spec 2026-10-01 §3): <userData>/avatars/<hash>, at most 100 MB, the least
// recently read going first. Nothing gets in, and nothing comes out, unless its SHA-256 is its
// name and it is an image (avatarBytes.verifiedAvatar). The reading order lives in the files'
// modification times, so it survives a restart.
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { AVATAR_HASH, type ImageInfo } from '@ghostlink/shared';
import { AppError } from '../../shared/appErrors.js';
import { writeFileAtomic } from '../files.js';
import { ownBytes, verifiedAvatar } from './avatarBytes.js';

export const AVATAR_CACHE_MAX_BYTES = 100 * 1024 * 1024;

/** What writeFileAtomic leaves behind when the process dies mid-write. */
const LEFTOVER = /^[0-9a-f]{64}\.tmp-\d+$/;

export interface CachedAvatar {
  bytes: Uint8Array;
  info: ImageInfo;
}

export class AvatarCache {
  readonly #dir: string;
  readonly #maxBytes: number;
  /** hash → size, least recently read first (a Map keeps insertion order). */
  readonly #entries = new Map<string, number>();
  #total = 0;

  private constructor(dir: string, maxBytes: number) {
    this.#dir = dir;
    this.#maxBytes = maxBytes;
  }

  static open(dir: string, opts: { maxBytes?: number } = {}): AvatarCache {
    const cache = new AvatarCache(dir, opts.maxBytes ?? AVATAR_CACHE_MAX_BYTES);
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      names = []; // not created yet
    }
    const found: Array<{ hash: string; size: number; mtimeMs: number }> = [];
    for (const name of names) {
      const path = join(dir, name);
      if (LEFTOVER.test(name)) {
        rmSync(path, { force: true });
        continue;
      }
      if (!AVATAR_HASH.test(name)) continue;
      try {
        const st = statSync(path);
        if (st.isFile()) found.push({ hash: name, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // vanished meanwhile
      }
    }
    found.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const f of found) cache.#add(f.hash, f.size);
    cache.#evict(null);
    return cache;
  }

  get totalBytes(): number {
    return this.#total;
  }

  /** The photo, checked again, or null. A file that no longer matches its name is removed. */
  get(hash: string): CachedAvatar | null {
    if (!this.#entries.has(hash)) return null;
    const path = join(this.#dir, hash);
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      this.#remove(hash);
      return null;
    }
    const info = verifiedAvatar(hash, bytes);
    if (info === null) {
      this.#remove(hash);
      return null;
    }
    this.#touch(hash, bytes.byteLength);
    return { bytes, info };
  }

  /** Keeps a photo; AppError('BAD_REQUEST') when the bytes are not the photo `hash` names. */
  put(hash: string, input: Uint8Array): ImageInfo {
    const bytes = ownBytes(input);
    const info = verifiedAvatar(hash, bytes);
    if (info === null) throw new AppError('BAD_REQUEST', 'not the photo that was asked for');
    if (this.#entries.has(hash)) {
      this.#touch(hash, bytes.byteLength);
      return info;
    }
    mkdirSync(this.#dir, { recursive: true });
    writeFileAtomic(join(this.#dir, hash), bytes);
    this.#add(hash, bytes.byteLength);
    this.#evict(hash);
    return info;
  }

  #add(hash: string, size: number): void {
    this.#entries.set(hash, size);
    this.#total += size;
  }

  /** Moves the photo to the most recently read end, here and on disk. */
  #touch(hash: string, size: number): void {
    this.#total += size - (this.#entries.get(hash) ?? 0);
    this.#entries.delete(hash);
    this.#entries.set(hash, size);
    const now = new Date();
    try {
      utimesSync(join(this.#dir, hash), now, now);
    } catch {
      // the order on disk is a hint only
    }
  }

  #remove(hash: string): void {
    this.#total -= this.#entries.get(hash) ?? 0;
    this.#entries.delete(hash);
    rmSync(join(this.#dir, hash), { force: true });
  }

  #evict(keep: string | null): void {
    for (const hash of [...this.#entries.keys()]) {
      if (this.#total <= this.#maxBytes) return;
      if (hash !== keep) this.#remove(hash);
    }
  }
}
