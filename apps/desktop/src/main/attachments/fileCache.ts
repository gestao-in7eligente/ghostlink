// Images of server attachments on disk (spec 2026-10-01-anexos §4): <userData>/attachments/<key>,
// at most 200 MB, the least recently read going first. The key is SHA-256(serverKeyId, fileId),
// so neither a server nor a file can be read off the folder, and two servers never share an
// entry. Only images get in, and only bytes that still read as an image come out. The reading
// order lives in the files' modification times, so it survives a restart.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { imageInfo, type ImageInfo } from '@ghostlink/shared';
import { writeFileAtomic } from '../files.js';

export const FILE_CACHE_MAX_BYTES = 200 * 1024 * 1024;
/** An image larger than this is streamed every time instead of kept (a few would fill the cache). */
export const FILE_CACHE_MAX_ENTRY_BYTES = 32 * 1024 * 1024;

const KEY = /^[0-9a-f]{64}$/;
/** What writeFileAtomic leaves behind when the process dies mid-write. */
const LEFTOVER = /^[0-9a-f]{64}\.tmp-\d+$/;

export interface CachedFile {
  bytes: Buffer;
  info: ImageInfo;
}

/** The cache entry of a server's file. */
export function fileCacheKey(serverKeyId: string, fileId: string): string {
  return createHash('sha256').update(`ghostlink-file-cache-v1\n${serverKeyId}\n${fileId}`, 'utf8').digest('hex');
}

export class FileCache {
  readonly #dir: string;
  readonly #maxBytes: number;
  /** key → size, least recently read first (a Map keeps insertion order). */
  readonly #entries = new Map<string, number>();
  #total = 0;

  private constructor(dir: string, maxBytes: number) {
    this.#dir = dir;
    this.#maxBytes = maxBytes;
  }

  static open(dir: string, opts: { maxBytes?: number } = {}): FileCache {
    const cache = new FileCache(dir, opts.maxBytes ?? FILE_CACHE_MAX_BYTES);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      names = []; // not created yet
    }
    const found: Array<{ key: string; size: number; mtimeMs: number }> = [];
    for (const name of names) {
      const path = join(dir, name);
      if (LEFTOVER.test(name)) {
        rmSync(path, { force: true });
        continue;
      }
      if (!KEY.test(name)) continue;
      try {
        const st = statSync(path);
        if (st.isFile()) found.push({ key: name, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // vanished meanwhile
      }
    }
    found.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const f of found) cache.#add(f.key, f.size);
    cache.#evict(null);
    return cache;
  }

  get totalBytes(): number {
    return this.#total;
  }

  /** The image and its type, or null. A file that no longer reads as an image is removed. */
  get(key: string): CachedFile | null {
    if (!this.#entries.has(key)) return null;
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(this.#dir, key));
    } catch {
      this.#remove(key);
      return null;
    }
    const info = imageInfo(bytes);
    if (info === null) {
      this.#remove(key);
      return null;
    }
    this.#touch(key, bytes.byteLength);
    return { bytes, info };
  }

  /** Keeps an image; false (nothing kept) when the bytes are not one, or too large to keep. */
  put(key: string, bytes: Buffer): boolean {
    if (!KEY.test(key) || bytes.byteLength === 0 || bytes.byteLength > Math.min(FILE_CACHE_MAX_ENTRY_BYTES, this.#maxBytes)) return false;
    if (imageInfo(bytes) === null) return false;
    if (this.#entries.has(key)) {
      this.#touch(key, bytes.byteLength);
      return true;
    }
    mkdirSync(this.#dir, { recursive: true });
    writeFileAtomic(join(this.#dir, key), bytes);
    this.#add(key, bytes.byteLength);
    this.#evict(key);
    return true;
  }

  #add(key: string, size: number): void {
    this.#entries.set(key, size);
    this.#total += size;
  }

  #touch(key: string, size: number): void {
    this.#total += size - (this.#entries.get(key) ?? 0);
    this.#entries.delete(key);
    this.#entries.set(key, size);
    const now = new Date();
    try {
      utimesSync(join(this.#dir, key), now, now);
    } catch {
      // the order on disk is a hint only
    }
  }

  #remove(key: string): void {
    this.#total -= this.#entries.get(key) ?? 0;
    this.#entries.delete(key);
    rmSync(join(this.#dir, key), { force: true });
  }

  #evict(keep: string | null): void {
    for (const key of [...this.#entries.keys()]) {
      if (this.#total <= this.#maxBytes) return;
      if (key !== keep) this.#remove(key);
    }
  }
}
