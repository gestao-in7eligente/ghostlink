import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FEATURE_AVATARS, ProtocolError, type WelcomePayload } from '@ghostlink/shared';
import type { ActiveSession } from '../../src/main/controller.js';
import { AvatarCache } from '../../src/main/avatars/avatarCache.js';
import { AvatarRoute } from '../../src/main/avatars/avatarRoute.js';
import type { MyAvatar } from '../../src/main/avatars/avatarStore.js';
import { avatarUrl } from '../../src/shared/profileTypes.js';
import { useTempDir } from '../helpers/tempDir.js';
import { gif, png, sha256Hex, webp } from './avatarFixtures.js';

const tmp = useTempDir();

function session(features = [FEATURE_AVATARS]): ActiveSession {
  const welcome = { sessionId: 'sid', fileToken: 'token', features, self: { userId: 'a'.repeat(32) } } as WelcomePayload;
  return { serverId: 's1', address: '127.0.0.1:7700', serverKeyId: 'k'.repeat(43), welcome, clockOffsetMs: 0, request: () => Promise.reject(new Error('unused')) };
}

function harness(o: { mine?: MyAvatar | null; session?: ActiveSession | null; serve?: Map<string, Uint8Array> } = {}) {
  let now = 1_000_000;
  let current = o.session === undefined ? session() : o.session;
  const serve = o.serve ?? new Map<string, Uint8Array>();
  const downloads: Array<{ session: ActiveSession; hash: string }> = [];
  const warnings: string[] = [];
  let gate: Promise<void> | null = null;
  const cache = AvatarCache.open(join(tmp.path, 'avatars'));
  const route = new AvatarRoute({
    mine: () => o.mine ?? null,
    cache,
    session: () => current,
    download: async (s, hash) => {
      downloads.push({ session: s, hash });
      if (gate) await gate;
      const bytes = serve.get(hash);
      if (!bytes) throw new ProtocolError('NOT_FOUND');
      return bytes;
    },
    warn: (m) => warnings.push(m),
    now: () => now,
  });
  return {
    route,
    cache,
    downloads,
    warnings,
    serve,
    get: (url: string, method = 'GET') => route.handle(new Request(url, { method })),
    setSession: (s: ActiveSession | null) => {
      current = s;
    },
    advance: (ms: number) => {
      now += ms;
    },
    hold: () => {
      let release!: () => void;
      gate = new Promise<void>((r) => (release = r));
      return () => {
        gate = null;
        release();
      };
    },
  };
}

const bodyOf = async (res: Response) => new Uint8Array(await res.arrayBuffer());

function expectImage(res: Response, mime: string) {
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe(mime);
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('cache-control')).toBe('no-cache');
}

describe('app://ghostlink/_avatar/<hash> (spec 2026-10-01 §3)', () => {
  it.each([
    ['an upper-case hash', `app://ghostlink/_avatar/${'A'.repeat(64)}`],
    ['a short hash', `app://ghostlink/_avatar/${'a'.repeat(63)}`],
    ['a long hash', `app://ghostlink/_avatar/${'a'.repeat(65)}`],
    ['no hash', 'app://ghostlink/_avatar/'],
    ['the bare prefix', 'app://ghostlink/_avatar'],
    ['a path after the hash', `app://ghostlink/_avatar/${'a'.repeat(64)}/x`],
    ['an escape attempt', 'app://ghostlink/_avatar/..%2f..%2fprofile%2favatar.webp'],
    ['another host', `app://evil/_avatar/${'a'.repeat(64)}`],
  ])('answers 404 to %s without downloading', async (_label, url) => {
    const h = harness();
    const res = await h.get(url);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBeNull();
    expect(h.downloads).toEqual([]);
  });

  it('refuses anything but GET and HEAD', async () => {
    const h = harness();
    expect((await h.get(avatarUrl(sha256Hex(webp())), 'POST')).status).toBe(405);
  });

  it('serves my photo from the store', async () => {
    const bytes = gif(256, 256, { size: 500 });
    const h = harness({ mine: { info: { hash: sha256Hex(bytes), mime: 'image/gif' }, bytes } });
    const res = await h.get(avatarUrl(sha256Hex(bytes)));
    expectImage(res, 'image/gif');
    expect(await bodyOf(res)).toEqual(bytes);
    expect(h.downloads).toEqual([]);
  });

  it('serves a cached photo with the type read from its bytes', async () => {
    const bytes = png(64, 64);
    const h = harness();
    h.cache.put(sha256Hex(bytes), bytes);
    const res = await h.get(avatarUrl(sha256Hex(bytes)));
    expectImage(res, 'image/png');
    expect(await bodyOf(res)).toEqual(bytes);
    expect(h.downloads).toEqual([]);
  });

  it('answers HEAD without a body', async () => {
    const bytes = png(64, 64);
    const h = harness();
    h.cache.put(sha256Hex(bytes), bytes);
    const res = await h.get(avatarUrl(sha256Hex(bytes)), 'HEAD');
    expectImage(res, 'image/png');
    expect((await bodyOf(res)).length).toBe(0);
  });

  it('downloads a missing photo from the connected server, keeps it and serves it', async () => {
    const bytes = webp(256, 256, { size: 900 });
    const hash = sha256Hex(bytes);
    const h = harness({ serve: new Map([[hash, bytes]]) });
    const res = await h.get(avatarUrl(hash));
    expectImage(res, 'image/webp');
    expect(await bodyOf(res)).toEqual(bytes);
    expect(h.downloads.map((d) => d.hash)).toEqual([hash]);
    expect(h.cache.get(hash)).not.toBeNull();
    expect((await h.get(avatarUrl(hash))).status).toBe(200);
    expect(h.downloads).toHaveLength(1); // the second time from the cache
  });

  it('shares one download between concurrent requests for the same photo', async () => {
    const bytes = png(64, 64);
    const hash = sha256Hex(bytes);
    const h = harness({ serve: new Map([[hash, bytes]]) });
    const release = h.hold();
    const pending = [h.get(avatarUrl(hash)), h.get(avatarUrl(hash)), h.get(avatarUrl(hash))];
    await new Promise((r) => setTimeout(r, 10));
    release();
    const responses = await Promise.all(pending);
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    for (const r of responses) expect(await bodyOf(r)).toEqual(bytes);
    expect(h.downloads).toHaveLength(1);
  });

  it('refuses bytes that are not the photo asked for, and keeps nothing', async () => {
    const asked = sha256Hex(png(64, 64, { fill: 1 }));
    const h = harness({ serve: new Map([[asked, png(64, 64, { fill: 2 })]]) });
    expect((await h.get(avatarUrl(asked))).status).toBe(404);
    expect(h.cache.totalBytes).toBe(0);
  });

  it('refuses a server’s HTML even when its hash is right', async () => {
    const html = new TextEncoder().encode('<!doctype html><script>alert(1)</script>');
    const hash = sha256Hex(html);
    const h = harness({ serve: new Map([[hash, html]]) });
    const res = await h.get(avatarUrl(hash));
    expect(res.status).toBe(404);
    expect((await bodyOf(res)).length).toBe(0);
  });

  it('answers 404 without trying when not connected, or connected to a server without photos', async () => {
    const bytes = png(64, 64);
    const hash = sha256Hex(bytes);
    for (const s of [null, session(['voice'])]) {
      const h = harness({ session: s, serve: new Map([[hash, bytes]]) });
      expect((await h.get(avatarUrl(hash))).status).toBe(404);
      expect(h.downloads).toEqual([]);
    }
  });

  it('does not ask the same session again for 30 s after a failure; a new session asks again', async () => {
    const bytes = png(64, 64);
    const hash = sha256Hex(bytes);
    const h = harness();
    expect((await h.get(avatarUrl(hash))).status).toBe(404); // the server has no such file
    expect((await h.get(avatarUrl(hash))).status).toBe(404);
    expect(h.downloads).toHaveLength(1);
    h.serve.set(hash, bytes);
    h.advance(30_001);
    expect((await h.get(avatarUrl(hash))).status).toBe(200);
    expect(h.downloads).toHaveLength(2);

    const other = sha256Hex(png(64, 64, { fill: 9 }));
    expect((await h.get(avatarUrl(other))).status).toBe(404);
    h.setSession(session()); // a reconnect
    expect((await h.get(avatarUrl(other))).status).toBe(404);
    expect(h.downloads.filter((d) => d.hash === other)).toHaveLength(2);
  });

  it('logs failures other than a missing file with their code only', async () => {
    const hash = sha256Hex(png(64, 64));
    const h = harness();
    expect((await h.get(avatarUrl(hash))).status).toBe(404);
    expect(h.warnings).toEqual([]); // NOT_FOUND is not news
    const route = new AvatarRoute({
      mine: () => null,
      cache: h.cache,
      session: () => session(),
      download: () => Promise.reject(new ProtocolError('FORBIDDEN', `sid=x&s=y ${hash}`)),
      warn: (m) => h.warnings.push(m),
    });
    expect((await route.handle(new Request(avatarUrl(hash)))).status).toBe(404);
    expect(h.warnings).toEqual(['[avatars] download failed: FORBIDDEN']);
  });
});
