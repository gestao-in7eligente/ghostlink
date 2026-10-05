// The neutral per-server update channel the app remembers (plan 2026-10-05-v083-troca-automatica, Task 3):
// each saved server's advertised `updateChannel.url` with when it was last seen, in <userData>/update-channels.json,
// so the most recently seen one can drive a one-time cross-grade. Nothing here mentions an edition.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { UPDATE_CHANNEL_MAX_URL, toBase64Url } from '@ghostlink/shared';
import { SEEN_REFRESH_MS, ServerChannelStore, UPDATE_CHANNELS_FILE } from '../../src/main/updater/serverChannel.js';
import { useTempDir } from '../helpers/tempDir.js';

const dir = useTempDir('ghostlink-server-channel-');
const KEY_A = toBase64Url(new Uint8Array(32).fill(1));
const KEY_B = toBase64Url(new Uint8Array(32).fill(2));
const KEY_C = toBase64Url(new Uint8Array(32).fill(3));
const URL_A = 'https://a.example/updates/QUJDREVGR0hJSktMTU5PUFFSU1RVVldY/';
const URL_B = 'https://b.example/updates/Zm9vYmFyLWRvd25sb2FkLWNvZGUtMDAw/';

let clock: number;
const file = () => join(dir.path, UPDATE_CHANNELS_FILE);
const load = () => ServerChannelStore.load(dir.path, { now: () => clock });
const onDisk = () => JSON.parse(readFileSync(file(), 'utf8')) as { version: number; channels: Record<string, unknown> };

beforeEach(() => {
  clock = 1_000_000;
});

describe('ServerChannelStore', () => {
  it('records a channel with when it was seen and reads it back across restarts', () => {
    const store = load();
    expect(store.latest()).toBeNull();
    expect(store.note(KEY_A, { url: URL_A })).toBe(true); // the first channel: the latest changed
    clock += 5;
    expect(store.note(KEY_B, { url: URL_B })).toBe(true); // a newer one: the latest changed again
    expect(onDisk()).toEqual({
      version: 1,
      channels: {
        [KEY_A]: { url: URL_A, seenAt: 1_000_000 },
        [KEY_B]: { url: URL_B, seenAt: 1_000_005 },
      },
    });
    if (process.platform !== 'win32') expect(statSync(file()).mode & 0o777).toBe(0o600);
    const again = load();
    expect(again.latest()).toEqual({ url: URL_B, seenAt: 1_000_005 });
    // Only the servers the predicate accepts count.
    expect(again.latest((k) => k === KEY_A)).toEqual({ url: URL_A, seenAt: 1_000_000 });
  });

  it('the most recently seen channel wins, and re-seeing an older server flips it', () => {
    const store = load();
    store.note(KEY_A, { url: URL_A });
    clock += 10;
    expect(store.note(KEY_B, { url: URL_B })).toBe(true);
    expect(store.latest()).toEqual({ url: URL_B, seenAt: clock });
    clock += 10;
    // A re-advertisement of A, now the most recent: the latest flips back, note says so, and the disk follows.
    expect(store.note(KEY_A, { url: URL_A })).toBe(true);
    expect(store.latest()).toEqual({ url: URL_A, seenAt: clock });
    expect(onDisk().channels[KEY_A]).toEqual({ url: URL_A, seenAt: clock });
  });

  it('a repeated channel within the refresh window writes nothing; a changed one is written at once', () => {
    const store = load();
    store.note(KEY_A, { url: URL_A });
    const marked = `${readFileSync(file(), 'utf8').trimEnd()} \n`;
    writeFileSync(file(), marked); // a marker: a rewrite would drop it
    for (let i = 0; i < 5; i++) {
      clock += SEEN_REFRESH_MS / 3;
      expect(store.note(KEY_A, { url: URL_A })).toBe(false); // the same channel, still the latest: no write
    }
    expect(readFileSync(file(), 'utf8')).toBe(marked);
    clock += 1;
    expect(store.note(KEY_A, { url: URL_B })).toBe(true); // a new URL: written now
    expect(onDisk().channels[KEY_A]).toMatchObject({ url: URL_B });
  });

  it('ignores a bad or absent url, a bad key, and anything it cannot read', () => {
    const store = load();
    for (const bad of [
      undefined,
      null,
      7,
      {},
      { url: 'http://insecure/' },
      { url: `https://h/${'a'.repeat(UPDATE_CHANNEL_MAX_URL)}` },
      { url: 7 },
      { url: 'not a url' },
    ]) {
      expect(store.note(KEY_A, bad)).toBe(false);
    }
    expect(store.note('not-a-key', { url: URL_A })).toBe(false);
    expect(store.latest()).toBeNull();
    expect(existsSync(file())).toBe(false); // nothing was ever written
  });

  it('keeps the servers the predicate accepts: an unsaved one is ignored, and a write forgets one no longer saved', () => {
    const saved = new Set([KEY_A, KEY_B]);
    const store = ServerChannelStore.load(dir.path, { now: () => clock, saved: (k) => saved.has(k) });
    expect(store.note(KEY_C, { url: URL_A })).toBe(false); // not saved: ignored
    store.note(KEY_A, { url: URL_A });
    clock += 5;
    store.note(KEY_B, { url: URL_B });
    expect(store.latest()).toEqual({ url: URL_B, seenAt: clock });
    // KEY_B leaves the saved list: it stops counting at once, and the next write drops it.
    saved.delete(KEY_B);
    expect(store.latest()).toEqual({ url: URL_A, seenAt: 1_000_000 });
    clock += 5;
    store.note(KEY_A, { url: URL_B });
    expect(Object.keys(onDisk().channels)).toEqual([KEY_A]);
  });

  it('a damaged entry is dropped, but a damaged file starts over', () => {
    const KEY_D = toBase64Url(new Uint8Array(32).fill(9));
    writeFileSync(
      file(),
      JSON.stringify({
        version: 1,
        channels: {
          [KEY_A]: { url: URL_A, seenAt: 1_000_000 },
          [KEY_B]: { url: 'http://insecure/', seenAt: 5 }, // a url the app cannot use
          'short-key': { url: URL_B, seenAt: 5 }, // not a serverKeyId
          [KEY_D]: { seenAt: 5 }, // no url at all
        },
      }),
    );
    const store = load();
    expect(store.latest()).toEqual({ url: URL_A, seenAt: 1_000_000 });
    expect(readdirSync(dir.path).some((f) => f.startsWith(`${UPDATE_CHANNELS_FILE}.corrupt-`))).toBe(false);
    // A file that is not even valid JSON is quarantined and the store starts empty.
    writeFileSync(file(), '{"version":1,"channels":');
    expect(load().latest()).toBeNull();
    expect(readdirSync(dir.path).some((f) => f.startsWith(`${UPDATE_CHANNELS_FILE}.corrupt-`))).toBe(true);
  });
});
