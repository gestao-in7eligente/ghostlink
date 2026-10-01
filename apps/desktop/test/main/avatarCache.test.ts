import { existsSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AVATAR_LIMITS } from '@ghostlink/shared';
import { AVATAR_CACHE_MAX_BYTES, AvatarCache } from '../../src/main/avatars/avatarCache.js';
import { verifiedAvatar } from '../../src/main/avatars/avatarBytes.js';
import { useTempDir } from '../helpers/tempDir.js';
import { gif, png, sha256Hex, webp } from './avatarFixtures.js';

const tmp = useTempDir();
const dir = () => join(tmp.path, 'avatars');

async function codeOf(fn: () => unknown): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return (e as { code: string }).code;
  }
  throw new Error('expected a failure');
}

/** Distinct 1000-byte photos. */
const photo = (n: number) => png(64, 64, { size: 1000, fill: n });

describe('verifiedAvatar (spec 2026-10-01 §3, §7)', () => {
  it('accepts the four image types when the bytes hash to the name', () => {
    for (const bytes of [png(), gif(), webp(), png(16, 512)]) expect(verifiedAvatar(sha256Hex(bytes), bytes)).not.toBeNull();
    expect(verifiedAvatar(sha256Hex(webp()), webp())).toEqual({ mime: 'image/webp', width: 256, height: 256 });
  });

  it.each([
    ['another photo’s hash', () => ({ hash: sha256Hex(png(64, 64, { fill: 1 })), bytes: png(64, 64, { fill: 2 }) })],
    ['an upper-case hash', () => ({ hash: sha256Hex(png()).toUpperCase(), bytes: png() })],
    ['no image (SVG)', () => {
      const bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"/>');
      return { hash: sha256Hex(bytes), bytes };
    }],
    ['a side below 16', () => ({ hash: sha256Hex(png(15, 64)), bytes: png(15, 64) })],
    ['a side above 512 (a decompression bomb header)', () => ({ hash: sha256Hex(png(60000, 60000)), bytes: png(60000, 60000) })],
    ['more than 2 MB', () => {
      const bytes = png(64, 64, { size: AVATAR_LIMITS.maxBytes + 1 });
      return { hash: sha256Hex(bytes), bytes };
    }],
  ])('refuses %s', (_label, make) => {
    const { hash, bytes } = make();
    expect(verifiedAvatar(hash, bytes)).toBeNull();
  });
});

describe('AvatarCache (others’ photos, 100 MB, least recently read goes first)', () => {
  it('keeps 100 MB by default', () => {
    expect(AVATAR_CACHE_MAX_BYTES).toBe(100 * 1024 * 1024);
  });

  it('stores a verified photo as avatars/<hash> and reads it back, also after a restart', () => {
    const bytes = photo(1);
    const hash = sha256Hex(bytes);
    const cache = AvatarCache.open(dir());
    expect(cache.get(hash)).toBeNull();
    expect(cache.put(hash, bytes)).toEqual({ mime: 'image/png', width: 64, height: 64 });
    expect(readdirSync(dir())).toEqual([hash]);
    const again = AvatarCache.open(dir()).get(hash);
    expect(again?.info.mime).toBe('image/png');
    expect(new Uint8Array(again!.bytes)).toEqual(bytes);
  });

  it('refuses bytes whose SHA-256 is not the hash, and keeps nothing', async () => {
    const cache = AvatarCache.open(dir());
    expect(await codeOf(() => cache.put(sha256Hex(photo(1)), photo(2)))).toBe('BAD_REQUEST');
    expect(existsSync(dir()) ? readdirSync(dir()) : []).toEqual([]);
    expect(cache.totalBytes).toBe(0);
  });

  it('refuses bytes that are no image, even with the right hash', async () => {
    const bytes = new TextEncoder().encode('<html><script>alert(1)</script></html>');
    expect(await codeOf(() => AvatarCache.open(dir()).put(sha256Hex(bytes), bytes))).toBe('BAD_REQUEST');
  });

  it('drops a file that no longer matches its name when it is read', () => {
    const bytes = photo(1);
    const hash = sha256Hex(bytes);
    const cache = AvatarCache.open(dir());
    cache.put(hash, bytes);
    writeFileSync(join(dir(), hash), photo(2));
    expect(cache.get(hash)).toBeNull();
    expect(existsSync(join(dir(), hash))).toBe(false);
    expect(cache.totalBytes).toBe(0);
  });

  it('evicts the least recently read photos to stay under the limit', () => {
    const cache = AvatarCache.open(dir(), { maxBytes: 3000 });
    const hashes = [1, 2, 3].map((n) => {
      const hash = sha256Hex(photo(n));
      cache.put(hash, photo(n));
      return hash;
    });
    expect(cache.totalBytes).toBe(3000);
    cache.get(hashes[0]!); // 1 was read: 2 is now the oldest
    const fourth = sha256Hex(photo(4));
    cache.put(fourth, photo(4));
    expect(cache.totalBytes).toBe(3000);
    expect(readdirSync(dir()).sort()).toEqual([hashes[0], hashes[2], fourth].sort());
    expect(cache.get(hashes[1]!)).toBeNull();
  });

  it('remembers the reading order across restarts (file times)', () => {
    const first = AvatarCache.open(dir(), { maxBytes: 3000 });
    const hashes = [1, 2, 3].map((n, i) => {
      const hash = sha256Hex(photo(n));
      first.put(hash, photo(n));
      const t = new Date(Date.UTC(2026, 0, 1, 0, 0, i));
      utimesSync(join(dir(), hash), t, t);
      return hash;
    });
    const t = new Date(Date.UTC(2026, 0, 1, 0, 1, 0));
    utimesSync(join(dir(), hashes[0]!), t, t); // read last, in a previous run
    const cache = AvatarCache.open(dir(), { maxBytes: 3000 });
    expect(cache.totalBytes).toBe(3000);
    cache.put(sha256Hex(photo(4)), photo(4));
    expect(existsSync(join(dir(), hashes[1]!))).toBe(false);
    expect(existsSync(join(dir(), hashes[0]!))).toBe(true);
  });

  it('a put of a photo it already has changes nothing but its place in the order', () => {
    const cache = AvatarCache.open(dir(), { maxBytes: 2000 });
    const a = sha256Hex(photo(1));
    const b = sha256Hex(photo(2));
    cache.put(a, photo(1));
    cache.put(b, photo(2));
    cache.put(a, photo(1));
    expect(cache.totalBytes).toBe(2000);
    cache.put(sha256Hex(photo(3)), photo(3));
    expect(existsSync(join(dir(), a))).toBe(true);
    expect(existsSync(join(dir(), b))).toBe(false);
  });

  it('ignores files that are not photos and removes leftovers of an interrupted write', () => {
    const hash = sha256Hex(photo(1));
    AvatarCache.open(dir()).put(hash, photo(1));
    writeFileSync(join(dir(), `${hash}.tmp-1234`), 'half');
    writeFileSync(join(dir(), 'notes.txt'), 'not ours to judge');
    const cache = AvatarCache.open(dir());
    expect(cache.totalBytes).toBe(1000);
    expect(readdirSync(dir()).sort()).toEqual([hash, 'notes.txt'].sort());
  });
});
