import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AVATAR_LIMITS } from '@ghostlink/shared';
import { AvatarStore } from '../../src/main/avatars/avatarStore.js';
import { useTempDir } from '../helpers/tempDir.js';
import { gif, png, sha256Hex, webp } from './avatarFixtures.js';

const tmp = useTempDir();
const profileDir = () => join(tmp.path, 'profile');

async function codeOf(fn: () => unknown): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return (e as { code: string }).code;
  }
  throw new Error('expected a failure');
}

describe('AvatarStore (spec 2026-10-01 §3: my photo)', () => {
  it('starts empty', () => {
    const store = AvatarStore.load(tmp.path);
    expect(store.get()).toBeNull();
    expect(store.current()).toBeNull();
  });

  it('stores a 256×256 WebP as profile/avatar.webp + avatar.json and finds it again after a restart', () => {
    const bytes = webp();
    const info = AvatarStore.load(tmp.path).set(bytes);
    expect(info).toEqual({ hash: sha256Hex(bytes), mime: 'image/webp' });
    expect(readdirSync(profileDir()).sort()).toEqual(['avatar.json', 'avatar.webp']);
    expect(new Uint8Array(readFileSync(join(profileDir(), 'avatar.webp')))).toEqual(bytes);
    expect(JSON.parse(readFileSync(join(profileDir(), 'avatar.json'), 'utf8'))).toEqual({ version: 1, ...info });

    const again = AvatarStore.load(tmp.path);
    expect(again.get()).toEqual(info);
    expect(new Uint8Array(again.current()!.bytes)).toEqual(bytes);
  });

  it('stores an animated-photo GIF and replaces the previous WebP (one photo at a time)', () => {
    const store = AvatarStore.load(tmp.path);
    store.set(webp());
    const bytes = gif(256, 256, { size: 4096 });
    expect(store.set(bytes)).toEqual({ hash: sha256Hex(bytes), mime: 'image/gif' });
    expect(readdirSync(profileDir()).sort()).toEqual(['avatar.gif', 'avatar.json']);
    expect(AvatarStore.load(tmp.path).get()?.mime).toBe('image/gif');
  });

  it('keeps its own copy of the bytes (an IPC view over a bigger buffer is not aliased)', () => {
    const backing = new Uint8Array(200);
    const bytes = webp();
    backing.set(bytes, 50);
    const view = backing.subarray(50, 50 + bytes.length);
    const store = AvatarStore.load(tmp.path);
    store.set(view);
    backing.fill(0);
    expect(new Uint8Array(store.current()!.bytes)).toEqual(bytes);
  });

  it.each([
    ['a PNG', png()],
    ['a WebP with the wrong sides', webp(255, 256)],
    ['a GIF that is not square', gif(256, 128)],
    ['a bigger WebP', webp(512)],
    ['bytes that are no image', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'.padEnd(64))],
    ['nothing', new Uint8Array(0)],
    ['more than 2 MB', webp(256, 256, { size: AVATAR_LIMITS.maxBytes + 1 })],
  ])('refuses %s with BAD_REQUEST and keeps the current photo', async (_label, bytes) => {
    const store = AvatarStore.load(tmp.path);
    const kept = store.set(webp());
    expect(await codeOf(() => store.set(bytes))).toBe('BAD_REQUEST');
    expect(store.get()).toEqual(kept);
    expect(AvatarStore.load(tmp.path).get()).toEqual(kept);
  });

  it('accepts exactly 2 MB', () => {
    const bytes = gif(256, 256, { size: AVATAR_LIMITS.maxBytes });
    expect(AvatarStore.load(tmp.path).set(bytes).hash).toBe(sha256Hex(bytes));
  });

  it('writes atomically: no temp files are left behind', () => {
    const store = AvatarStore.load(tmp.path);
    store.set(webp());
    store.set(gif());
    expect(readdirSync(profileDir()).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('clear() removes the photo and its record', () => {
    const store = AvatarStore.load(tmp.path);
    store.set(webp());
    store.clear();
    expect(store.get()).toBeNull();
    expect(readdirSync(profileDir())).toEqual([]);
    expect(AvatarStore.load(tmp.path).get()).toBeNull();
    store.clear(); // nothing left to remove: still fine
  });

  it('ignores a record whose file is gone', () => {
    AvatarStore.load(tmp.path).set(webp());
    writeFileSync(join(profileDir(), 'avatar.webp'), '');
    expect(AvatarStore.load(tmp.path).get()).toBeNull();
  });

  it('adopts the file when a crash left the record of the previous photo (same type)', () => {
    const store = AvatarStore.load(tmp.path);
    store.set(webp(256, 256, { fill: 1 }));
    const newer = webp(256, 256, { fill: 9 });
    writeFileSync(join(profileDir(), 'avatar.webp'), newer); // the file was replaced, the record was not
    expect(AvatarStore.load(tmp.path).get()).toEqual({ hash: sha256Hex(newer), mime: 'image/webp' });
  });

  it('ignores a file that is not a valid photo, even with a matching record', () => {
    const bad = png();
    AvatarStore.load(tmp.path).set(webp());
    writeFileSync(join(profileDir(), 'avatar.webp'), bad);
    writeFileSync(join(profileDir(), 'avatar.json'), JSON.stringify({ version: 1, hash: sha256Hex(bad), mime: 'image/webp' }));
    expect(AvatarStore.load(tmp.path).get()).toBeNull();
  });

  it('keeps a corrupt record aside and starts empty', () => {
    AvatarStore.load(tmp.path).set(webp());
    writeFileSync(join(profileDir(), 'avatar.json'), '{ not json');
    expect(AvatarStore.load(tmp.path).get()).toBeNull();
    expect(readdirSync(profileDir()).some((f) => f.startsWith('avatar.json.corrupt-'))).toBe(true);
    expect(existsSync(join(profileDir(), 'avatar.json'))).toBe(false);
  });
});
