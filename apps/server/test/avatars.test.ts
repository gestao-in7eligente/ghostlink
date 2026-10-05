// Profile photos on a server (spec 2026-10-01-foto-de-perfil-design.md §4, §7): the `avatars`
// flag, upload.begin → POST /upload → member.updated, avatar.clear, the signed
// GET /avatars/<hash>, and the clean-up of files no member uses any more.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import { request } from 'node:https';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AVATAR_LIMITS,
  FEATURE_AVATARS,
  FILE_URL_MAX_AHEAD_S,
  avatarTarget,
  fileSignatureInput,
  fileUrlExpiry,
  type Member,
} from '@ghostlink/shared';
import { createAvatarsModule, type AvatarsModuleOptions } from '../src/avatars/index.js';
import { silentLogger, startServer } from '../src/index.js';
import { createTextModule } from '../src/text/index.js';
import { withDb } from './helpers/db.js';
import { FakeTcpProxy } from './helpers/fakeProxy.js';
import { startTestServer } from './helpers/testClient.js';
import { joinServer, textFixture, type TextClient } from './text/helpers.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

// ---- images: the server reads only the header, so a header plus random bytes is a photo ----

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const le16 = (n: number) => [n & 255, (n >>> 8) & 255];

function png(width = 256, height = 256): Buffer {
  const head = Buffer.alloc(33);
  Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'latin1');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  head[24] = 8;
  head[25] = 6;
  return Buffer.concat([head, randomBytes(300)]);
}

function webp(width = 256, height = 256): Buffer {
  // Lossless (VP8L): width-1 and height-1 in 14 bits each, little-endian bits.
  const v = (width - 1) | ((height - 1) << 14);
  return Buffer.concat([
    Buffer.from('RIFF\0\0\0\0WEBPVP8L\0\0\0\0', 'latin1'),
    Buffer.from([0x2f, v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]),
    randomBytes(300),
  ]);
}

function gif(width = 256, height = 256): Buffer {
  return Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([...le16(width), ...le16(height), 0xf7, 0, 0]), randomBytes(300)]);
}

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256"/></svg>');

// ---- HTTPS ----

interface HttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

function https(port: number, method: string, path: string, body?: Uint8Array, headers: Record<string, string | number> = {}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers, rejectUnauthorized: false, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject); // after a response this is a no-op (the server may close early)
    req.end(body);
  });
}

const json = (r: HttpResponse) => JSON.parse(r.body.toString('utf8')) as Record<string, unknown>;

// ---- fixture ----

async function setup(opts: AvatarsModuleOptions = {}) {
  const f = await textFixture({ extraModules: [createAvatarsModule(opts)] });
  const port = f.t.server.port;
  const dir = join(f.t.dataDir, 'avatars');
  const begin = async (c: TextClient, bytes: Uint8Array, over: Record<string, unknown> = {}) => {
    const r = await c.ok<{ uploadToken: string }>('upload.begin', { purpose: 'avatar', size: bytes.length, sha256: sha(bytes), ...over });
    return r.uploadToken;
  };
  const post = (token: string, body?: Uint8Array, headers?: Record<string, string | number>) => https(port, 'POST', `/upload?u=${token}`, body, headers);
  return {
    ...f,
    port,
    dir,
    begin,
    post,
    upload: async (c: TextClient, bytes: Uint8Array) => post(await begin(c, bytes), bytes),
    files: () => (existsSync(dir) ? readdirSync(dir).sort() : []),
    avatarOf: (userId: string) => withDb(f.t.dataDir, (db) => db.get<{ avatar_file_id: string | null }>('SELECT avatar_file_id FROM users WHERE id = ?', userId)?.avatar_file_id),
    get: (path: string, method = 'GET') => https(port, method, path),
  };
}

const updatedFor = (userId: string) => (d: { member: Member }) => d.member.userId === userId;

/** A GET /avatars path signed with this client's session (main spec §7). */
function signed(c: TextClient, hash: string, o: { e?: number; sid?: string; key?: string; target?: string } = {}): string {
  const sid = o.sid ?? String(c.welcome.sessionId);
  const e = o.e ?? fileUrlExpiry(Number(c.welcome.serverTime));
  const s = createHmac('sha256', o.key ?? String(c.welcome.fileToken))
    .update(fileSignatureInput(o.target ?? avatarTarget(hash), sid, e))
    .digest('base64url');
  return `/avatars/${hash}?sid=${encodeURIComponent(sid)}&e=${e}&s=${s}`;
}

describe('the avatars feature', () => {
  it('is announced in every welcome; members start without a photo', async () => {
    const f = await setup();
    const bia = await f.join({ nickname: 'Bia' });
    for (const c of [f.owner, bia]) expect(c.welcome.features).toContain(FEATURE_AVATARS);
    expect(bia.text.members.map((m) => m.avatar)).toEqual([null, null]);
  });
});

describe('upload.begin → POST /upload (spec §4)', () => {
  it('stores the photo, answers { avatar } and announces member.updated to everyone', async () => {
    const f = await setup();
    const bia = await f.join({ nickname: 'Bia' });
    const photo = png();
    const hash = sha(photo);
    const token = await f.begin(bia, photo);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256 bits, base64url

    const res = await f.post(token, photo);
    expect(res.status).toBe(200);
    expect(json(res)).toEqual({ avatar: hash });
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-type']).toMatch(/^application\/json/);

    const seen = await f.owner.event('member.updated', updatedFor(bia.userId));
    expect(seen.member).toMatchObject({ userId: bia.userId, nickname: 'Bia', avatar: hash });
    expect((await bia.event('member.updated', updatedFor(bia.userId))).member.avatar).toBe(hash);
    expect(f.files()).toEqual([`${hash}.png`]);
    expect(f.avatarOf(bia.userId)).toBe(hash);

    // Someone joining later gets it in the welcome.
    const cat = await f.join({ nickname: 'Cat' });
    expect(cat.text.members.find((m) => m.userId === bia.userId)?.avatar).toBe(hash);
  });

  it('takes WebP, GIF and JPEG too, each stored with its own extension', async () => {
    const f = await setup();
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      Buffer.from('JFIF\0', 'latin1'),
      Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0x00, 0x11, 8, 0x00, 0x80, 0x00, 0x80, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
      randomBytes(100),
    ]);
    const photos: Array<[Buffer, string]> = [[webp(), 'webp'], [gif(), 'gif'], [jpeg, 'jpg']];
    for (const [photo, ext] of photos) {
      const c = await f.join();
      const res = await f.upload(c, photo);
      expect(res.status).toBe(200);
      expect(f.files()).toContain(`${sha(photo)}.${ext}`);
    }
  });

  it('two members with the same photo share one file', async () => {
    const f = await setup();
    const bia = await f.join();
    const cat = await f.join();
    const photo = webp();
    expect((await f.upload(bia, photo)).status).toBe(200);
    expect((await f.upload(cat, photo)).status).toBe(200);
    expect(f.files()).toEqual([`${sha(photo)}.webp`]);
    expect(f.avatarOf(cat.userId)).toBe(sha(photo));
  });

  describe('refuses with 400 { code: BAD_REQUEST }, and nothing changes', () => {
    const cases: Array<[string, (photo: Buffer) => { begin?: Record<string, unknown>; body: Buffer; headers?: Record<string, string | number> }]> = [
      ['a hash that does not match', (photo) => ({ begin: { sha256: 'a'.repeat(64) }, body: photo })],
      ['a file that is not one of the four types (an SVG)', () => ({ begin: { size: SVG.length, sha256: sha(SVG) }, body: SVG })],
      ['a side below 16 px', () => {
        const small = png(15, 256);
        return { begin: { size: small.length, sha256: sha(small) }, body: small };
      }],
      ['a side above 512 px', () => {
        const big = webp(256, 513);
        return { begin: { size: big.length, sha256: sha(big) }, body: big };
      }],
      ['a body shorter than the declared size', (photo) => ({ begin: { size: photo.length + 10 }, body: photo })],
      ['a body longer than the declared size (cut on Content-Length)', (photo) => ({ begin: { size: photo.length - 10, sha256: sha(photo.subarray(0, -10)) }, body: photo })],
    ];
    it.each(cases)('%s', async (_name, make) => {
      const f = await setup();
      const bia = await f.join();
      const photo = png();
      const c = make(photo);
      const token = await f.begin(bia, c.body, c.begin);
      const res = await f.post(token, c.body, c.headers);
      expect(res.status).toBe(400);
      expect(json(res)).toEqual({ code: 'BAD_REQUEST' });
      expect(res.headers['access-control-allow-origin']).toBe('*');
      await f.owner.sync();
      expect(f.owner.seen('member.updated')).toEqual([]);
      expect(f.avatarOf(bia.userId)).toBeNull();
      expect(f.files()).toEqual([]);
    });
  });

  it('cuts a chunked body as soon as it passes the declared size', async () => {
    const f = await setup();
    const bia = await f.join();
    const photo = png();
    const token = await f.begin(bia, photo.subarray(0, 100), { size: 100, sha256: sha(photo.subarray(0, 100)) });
    const res = await new Promise<HttpResponse | 'cut'>((resolve) => {
      const req = request({ host: '127.0.0.1', port: f.port, method: 'POST', path: `/upload?u=${token}`, headers: { 'Transfer-Encoding': 'chunked' }, rejectUnauthorized: false, agent: false }, (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => resolve({ status: r.statusCode ?? 0, headers: r.headers, body: Buffer.concat(chunks) }));
        r.on('error', () => resolve('cut'));
      });
      req.on('error', () => resolve('cut'));
      req.end(photo); // 333 bytes for a declared 100
    });
    if (res !== 'cut') expect(res.status).toBe(400);
    expect(f.avatarOf(bia.userId)).toBeNull();
    expect(f.files()).toEqual([]);
  });

  it('cuts an upload that stops making progress', async () => {
    const f = await setup({ uploadIdleMs: 150 });
    const bia = await f.join();
    const photo = png();
    const token = await f.begin(bia, photo);
    const started = Date.now();
    const outcome = await new Promise<string>((resolve) => {
      const req = request({ host: '127.0.0.1', port: f.port, method: 'POST', path: `/upload?u=${token}`, headers: { 'Content-Length': photo.length }, rejectUnauthorized: false, agent: false }, (r) => resolve(`status ${r.statusCode}`));
      req.on('error', () => resolve('cut'));
      req.on('close', () => resolve('cut'));
      req.write(photo.subarray(0, 50)); // and then nothing
    });
    expect(outcome).toBe('cut');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(f.avatarOf(bia.userId)).toBeNull();
  });

  it('upload.begin validates its payload strictly and refuses a photo above 2 MB', async () => {
    const f = await setup();
    const ok = { purpose: 'avatar', size: 100, sha256: 'a'.repeat(64) };
    expect(await f.owner.fail('upload.begin', { ...ok, size: AVATAR_LIMITS.maxBytes + 1 })).toBe('BAD_REQUEST');
    expect(await f.owner.fail('upload.begin', { ...ok, purpose: 'attachment' })).toBe('BAD_REQUEST');
    expect(await f.owner.fail('upload.begin', { ...ok, sha256: 'A'.repeat(64) })).toBe('BAD_REQUEST');
    expect(await f.owner.fail('upload.begin', { ...ok, extra: 1 })).toBe('BAD_REQUEST');
    expect(await f.owner.fail('upload.begin', {})).toBe('BAD_REQUEST');
  });

  describe('the upload token', () => {
    it('is single use: a second POST gets 403, after a success or a failure', async () => {
      const f = await setup();
      const bia = await f.join();
      const photo = png();
      const token = await f.begin(bia, photo);
      expect((await f.post(token, photo)).status).toBe(200);
      const again = await f.post(token, photo);
      expect(again.status).toBe(403);
      expect(json(again)).toEqual({ code: 'FORBIDDEN' });

      const bad = await f.begin(bia, photo, { sha256: 'b'.repeat(64) });
      expect((await f.post(bad, photo)).status).toBe(400);
      expect((await f.post(bad, photo)).status).toBe(403);
    });

    it('expires after 60 s', async () => {
      const f = await setup();
      const bia = await f.join();
      const photo = png();
      const token = await f.begin(bia, photo);
      f.clock.now += 60_001;
      expect((await f.post(token, photo)).status).toBe(403);
      expect(f.files()).toEqual([]);
    });

    it('unknown, missing or repeated: 403', async () => {
      const f = await setup();
      const photo = png();
      expect((await f.post('x'.repeat(43), photo)).status).toBe(403);
      expect((await https(f.port, 'POST', '/upload', photo)).status).toBe(403);
      const token = await f.begin(f.owner, photo);
      expect((await https(f.port, 'POST', `/upload?u=${token}&u=${token}`, photo)).status).toBe(403);
    });

    it('is bound to its session: refused once that session was replaced or its member kicked', async () => {
      const f = await setup();
      const bia = await f.join({ nickname: 'Bia' });
      const photo = png();
      const token = await f.begin(bia, photo);
      await f.join({ seed: bia.seed, nickname: 'Bia' }); // same identity, new session
      expect((await f.post(token, photo)).status).toBe(403);

      const cat = await f.join();
      const catToken = await f.begin(cat, photo);
      await f.owner.ok('member.kick', { userId: cat.userId });
      expect((await f.post(catToken, photo)).status).toBe(403);
      expect(f.files()).toEqual([]);
    });

    it('at most 3 open per session (RATE_LIMITED)', async () => {
      const f = await setup();
      const bia = await f.join();
      const photos = [png(), png(), png(), png()];
      const tokens: string[] = [];
      for (const p of photos.slice(0, 3)) tokens.push(await f.begin(bia, p));
      expect(await bia.fail('upload.begin', { purpose: 'avatar', size: photos[3]!.length, sha256: sha(photos[3]!) })).toBe('RATE_LIMITED');
      expect((await f.post(tokens[0]!, photos[0])).status).toBe(200);
      expect(await f.begin(bia, photos[3]!)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });
  });

  it('5 photo changes per minute per person, upload.begin and avatar.clear together', async () => {
    const f = await setup();
    const bia = await f.join();
    await f.begin(bia, png());
    await f.begin(bia, png());
    for (let i = 0; i < 3; i++) await bia.ok('avatar.clear', {});
    expect(await bia.fail('upload.begin', { purpose: 'avatar', size: 10, sha256: 'a'.repeat(64) })).toBe('RATE_LIMITED');
    expect(await bia.fail('avatar.clear', {})).toBe('RATE_LIMITED');
    expect(await f.owner.ok('avatar.clear', {})).toEqual({}); // per person
    f.clock.now += 60_000;
    expect(await bia.ok('avatar.clear', {})).toEqual({});
  });

  it('answers the CORS preflight and refuses other methods', async () => {
    const f = await setup();
    const pre = await f.get('/upload?u=x', 'OPTIONS');
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('*');
    expect(String(pre.headers['access-control-allow-methods'])).toContain('POST');
    expect((await f.get('/upload?u=x')).status).toBe(405);
  });
});

describe('avatar.clear', () => {
  it('goes back to initials for everyone and deletes the file no one uses any more', async () => {
    const f = await setup();
    const bia = await f.join();
    const photo = gif();
    await f.upload(bia, photo);
    await f.owner.event('member.updated', updatedFor(bia.userId));
    f.owner.clear();
    expect(await bia.ok('avatar.clear', {})).toEqual({});
    expect((await f.owner.event('member.updated', updatedFor(bia.userId))).member.avatar).toBeNull();
    expect(f.avatarOf(bia.userId)).toBeNull();
    expect(f.files()).toEqual([]);
    expect(await bia.fail('avatar.clear', { avatar: null })).toBe('BAD_REQUEST');
  });
});

describe('GET /avatars/<hash> (signed URL, main spec §7)', () => {
  async function withPhoto() {
    const f = await setup();
    const bia = await f.join({ nickname: 'Bia' });
    const photo = png();
    expect((await f.upload(bia, photo)).status).toBe(200);
    return { f, bia, photo, hash: sha(photo), nowS: Math.floor(f.clock.now / 1000) };
  }

  it('serves the bytes to any session of the server, with the right type and cache rules', async () => {
    const { f, bia, photo, hash } = await withPhoto();
    for (const c of [bia, f.owner]) {
      const res = await f.get(signed(c, hash));
      expect(res.status).toBe(200);
      expect(res.body.equals(photo)).toBe(true);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['content-length']).toBe(String(photo.length));
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toBe('private, max-age=86400');
      expect(res.headers['access-control-allow-origin']).toBe('*');
    }
    const head = await f.get(signed(f.owner, hash), 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body.length).toBe(0);
  });

  it('accepts an expiry up to 20 minutes ahead, not one second more', async () => {
    const { f, hash, nowS } = await withPhoto();
    expect((await f.get(signed(f.owner, hash, { e: nowS + FILE_URL_MAX_AHEAD_S }))).status).toBe(200);
    expect((await f.get(signed(f.owner, hash, { e: nowS + FILE_URL_MAX_AHEAD_S + 1 }))).status).toBe(403);
  });

  it('403 without a signature, expired, tampered, for another photo, or signed with another key', async () => {
    const { f, bia, hash, nowS } = await withPhoto();
    const good = signed(f.owner, hash);
    const s = new URLSearchParams(good.split('?')[1]).get('s')!;
    const flipped = `${s.slice(0, 10)}${s[10] === 'A' ? 'B' : 'A'}${s.slice(11)}`;
    const refused = [
      `/avatars/${hash}`,
      good.replace(/&s=.*/, ''),
      good.replace(`s=${s}`, `s=${flipped}`),
      good.replace(`s=${s}`, `s=${s}${s}`),
      signed(f.owner, hash, { e: nowS - 1 }),
      signed(f.owner, hash, { target: avatarTarget('b'.repeat(64)) }),
      signed(f.owner, hash, { key: String(bia.welcome.fileToken) }), // the owner's sid with Bia's key
      signed(f.owner, hash, { sid: 'no-such-session' }),
      `${good}&e=1`,
    ];
    for (const path of refused) {
      const res = await f.get(path);
      expect(res.status, path.replace(/s=[^&]*/, 's=…')).toBe(403);
      expect(res.headers['access-control-allow-origin']).toBe('*');
    }
  });

  it("a session's URLs stop working when it ends", async () => {
    const { f, bia, hash } = await withPhoto();
    const path = signed(bia, hash);
    expect((await f.get(path)).status).toBe(200);
    bia.close();
    await f.owner.event('presence', (d: { userId: string; online: boolean }) => d.userId === bia.userId && !d.online);
    expect((await f.get(path)).status).toBe(403);
  });

  it('404 for a malformed hash or a photo no one has', async () => {
    const { f, hash } = await withPhoto();
    const other = 'c'.repeat(64);
    expect((await f.get(signed(f.owner, other))).status).toBe(404);
    expect((await f.get(signed(f.owner, hash).replace(hash, hash.toUpperCase()))).status).toBe(404);
    expect((await f.get(`/avatars/${hash.slice(1)}`)).status).toBe(404);
    expect((await f.get(`/avatars/${hash}/x`)).status).toBe(404);
  });

  it('answers the CORS preflight and refuses writes', async () => {
    const { f, hash } = await withPhoto();
    const pre = await f.get(`/avatars/${hash}`, 'OPTIONS');
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('*');
    expect((await f.get(signed(f.owner, hash), 'DELETE')).status).toBe(405);
  });
});

describe('clean-up of photos no member uses', () => {
  it('a change deletes the old file, unless someone else still uses it', async () => {
    const f = await setup();
    const bia = await f.join();
    const cat = await f.join();
    const first = png();
    const second = webp();
    await f.upload(bia, first);
    await f.upload(bia, second);
    expect(f.files()).toEqual([`${sha(second)}.webp`]);

    await f.upload(cat, second);
    await f.upload(bia, first);
    expect(f.files()).toEqual([`${sha(first)}.png`, `${sha(second)}.webp`].sort());
  });

  it.each([
    ['kicked', (f: Awaited<ReturnType<typeof setup>>, c: TextClient) => f.owner.ok('member.kick', { userId: c.userId })],
    ['banned', (f: Awaited<ReturnType<typeof setup>>, c: TextClient) => f.owner.ok('member.ban', { userId: c.userId })],
    ['left', (_f: Awaited<ReturnType<typeof setup>>, c: TextClient) => c.ok('server.leave', {})],
  ])('a member who is %s loses the photo and its file', async (_how, remove) => {
    const f = await setup();
    const bia = await f.join();
    await f.upload(bia, png());
    await remove(f, bia);
    expect(f.files()).toEqual([]);
    expect(f.avatarOf(bia.userId)).toBeNull();
  });

  it('at start: deletes orphans and leftovers, keeps photos in use, forgets photos whose file is gone', async () => {
    const f = await setup();
    const bia = await f.join();
    const cat = await f.join();
    const kept = png();
    const lost = gif();
    await f.upload(bia, kept);
    await f.upload(cat, lost);
    await f.t.server.close();

    writeFileSync(join(f.dir, `${'c'.repeat(64)}.webp`), webp()); // nobody's
    writeFileSync(join(f.dir, 'upload-1a2b3c.tmp'), 'half an upload');
    rmSync(join(f.dir, `${sha(lost)}.gif`));

    const again = await startServer({ dataDir: f.t.dataDir, port: 0, host: '127.0.0.1', logger: silentLogger, modules: [createTextModule(), createAvatarsModule()] });
    try {
      expect(f.files()).toEqual([`${sha(kept)}.png`]);
      expect(f.avatarOf(bia.userId)).toBe(sha(kept));
      expect(f.avatarOf(cat.userId)).toBeNull(); // the app uploads it again at its next welcome
    } finally {
      await again.close();
    }
  });
});

describe('behind a TCP proxy (spec §8.6)', () => {
  it('uploads and downloads exactly the same way', async () => {
    const t = await startTestServer({ joinMode: 'open', proxy: { host: 'proxy.example.net', port: 25_889 }, modules: [createTextModule(), createAvatarsModule()] });
    cleanups.push(() => t.cleanup());
    const proxy = await new FakeTcpProxy(t.server.port).listen();
    cleanups.push(() => proxy.close());
    const via = { ...t.server, port: proxy.port };
    const join = async (o: Parameters<typeof joinServer>[1]) => {
      const r = await joinServer(via, o);
      if (!r.client) throw new Error(`refused: ${r.error}`);
      cleanups.push(() => r.client.close());
      return r.client;
    };
    const owner = await join({ nickname: 'Dono', setupCode: t.server.setupCode()! });
    const bia = await join({ nickname: 'Bia' });
    const photo = webp();
    const { uploadToken } = await bia.ok<{ uploadToken: string }>('upload.begin', { purpose: 'avatar', size: photo.length, sha256: sha(photo) });
    const res = await https(proxy.port, 'POST', `/upload?u=${uploadToken}`, photo);
    expect(res.status).toBe(200);
    expect((await owner.event('member.updated', updatedFor(bia.userId))).member.avatar).toBe(sha(photo));
    const got = await https(proxy.port, 'GET', signed(owner, sha(photo)));
    expect(got.status).toBe(200);
    expect(got.body.equals(photo)).toBe(true);
    expect(proxy.tlsConnections.length).toBeGreaterThanOrEqual(4);
  });
});
