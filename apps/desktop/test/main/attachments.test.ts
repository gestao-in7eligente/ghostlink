// Attachments in main (spec 2026-10-01-anexos §2, §4) against a local HTTPS fake with a
// self-signed certificate and its pin: upload.begin → POST /upload with progress, the signed
// GET /files/<id> behind app://ghostlink/_file (Range, the image cache, the download type), and
// "Baixar" writing through that route without ever opening anything.
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_ATTACHMENTS, fileSignatureInput } from '@ghostlink/shared';
import { generateCertificate } from '../../../server/src/tls/certificate.js';
import { fileSignature, openFile, signedFilePath, uploadAttachment } from '../../src/main/attachments/attachmentHttp.js';
import { saveAttachment } from '../../src/main/attachments/download.js';
import { FileCache, fileCacheKey } from '../../src/main/attachments/fileCache.js';
import { FileRoute, parseFileUrl, servedType, type FileSession } from '../../src/main/attachments/fileRoute.js';
import { serverKeyIdFromCertificate } from '../../src/main/pinning.js';
import { serverFileUrl } from '../../src/shared/attachmentTypes.js';
import { useTempDir } from '../helpers/tempDir.js';
import { png, sha256Hex } from './avatarFixtures.js';

// appProtocol imports electron's `protocol`; only its pure request handler is used here.
vi.mock('electron', () => ({ protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() } }));

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  range: string | undefined;
  body: Buffer;
}

interface StoredFile {
  bytes: Buffer;
  type: string;
}

interface Fake {
  port: number;
  pin: string;
  seen: Seen[];
  files: Map<string, StoredFile>;
  /** Overrides the answer to POST /upload. */
  onUpload: ((seen: Seen, res: ServerResponse) => void) | null;
  close(): Promise<void>;
}

const FILE_TOKEN = randomBytes(32).toString('base64url');
const SESSION_ID = randomBytes(16).toString('base64url');
const CHANNEL = 'C'.repeat(26);
const FILE_ID = 'F'.repeat(26);
const cert = generateCertificate();
const fakes: Fake[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.close()));
});

/** What the server checks (main spec §7), written out independently of attachmentHttp. */
function validSignature(q: URLSearchParams, fileId: string): boolean {
  const sid = q.get('sid') ?? '';
  const e = Number(q.get('e'));
  const expected = createHmac('sha256', FILE_TOKEN).update(fileSignatureInput(fileId, sid, e)).digest('base64url');
  return sid === SESSION_ID && q.get('s') === expected;
}

/** An HTTPS fake of the server's /upload and /files routes. */
async function fake(): Promise<Fake> {
  const { certPem, keyPem } = await cert;
  const server: Server = createServer({ cert: certPem, key: keyPem });
  const f: Fake = {
    port: 0,
    pin: serverKeyIdFromCertificate(certPem),
    seen: [],
    files: new Map(),
    onUpload: null,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'https://fake');
      const s: Seen = { method: req.method ?? '', path: url.pathname, query: url.searchParams, range: req.headers.range, body: Buffer.concat(chunks) };
      f.seen.push(s);
      if (s.method === 'POST' && s.path === '/upload') {
        if (f.onUpload) return f.onUpload(s, res);
        if (s.query.get('u') !== 'tok_1') return res.writeHead(403, { 'Content-Type': 'application/json' }).end('{"code":"FORBIDDEN"}');
        f.files.set(FILE_ID, { bytes: s.body, type: 'application/octet-stream' });
        return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ fileId: FILE_ID }));
      }
      const id = s.path.startsWith('/files/') ? s.path.slice('/files/'.length) : '';
      const file = f.files.get(id);
      if (!file || !validSignature(s.query, id)) return res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"code":"NOT_FOUND"}');
      const m = /^bytes=(\d+)-(\d*)$/.exec(s.range ?? '');
      if (m) {
        const start = Number(m[1]);
        const end = m[2] ? Number(m[2]) : file.bytes.length - 1;
        res.writeHead(206, { 'Content-Type': file.type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${file.bytes.length}`, 'Accept-Ranges': 'bytes' });
        return res.end(s.method === 'HEAD' ? undefined : file.bytes.subarray(start, end + 1));
      }
      res.writeHead(200, { 'Content-Type': file.type, 'Content-Length': file.bytes.length, 'Accept-Ranges': 'bytes' });
      res.end(s.method === 'HEAD' ? undefined : file.bytes);
    });
  });
  server.on('tlsClientError', () => {});
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  f.port = (server.address() as AddressInfo).port;
  fakes.push(f);
  return f;
}

function session(f: Fake, over: Partial<FileSession> = {}): FileSession & { requests: Array<{ t: string; d: unknown }> } {
  const requests: Array<{ t: string; d: unknown }> = [];
  return {
    serverId: 'srv-1',
    address: `127.0.0.1:${f.port}`,
    serverKeyId: f.pin,
    welcome: { sessionId: SESSION_ID, fileToken: FILE_TOKEN, features: [FEATURE_ATTACHMENTS] },
    clockOffsetMs: 0,
    requests,
    request: async <T>(t: string, d?: unknown) => {
      requests.push({ t, d });
      return (t === 'upload.begin' ? { uploadToken: 'tok_1', fileId: FILE_ID } : {}) as T;
    },
    ...over,
  };
}

async function failure(p: Promise<unknown>): Promise<Error & { code: string }> {
  try {
    await p;
  } catch (e) {
    return e as Error & { code: string };
  }
  throw new Error('expected a failure');
}

const quick = { idleMs: 2_000 };

describe('signed file URLs (main spec §7)', () => {
  it('signs the fileId itself with the fileToken text', () => {
    const path = signedFilePath({ welcome: { sessionId: SESSION_ID, fileToken: FILE_TOKEN }, clockOffsetMs: 0 }, FILE_ID, 1_800_000_000_000);
    const url = new URL(path, 'https://x');
    expect(url.pathname).toBe(`/files/${FILE_ID}`);
    expect(validSignature(url.searchParams, FILE_ID)).toBe(true);
    expect(fileSignature(FILE_TOKEN, FILE_ID, SESSION_ID, 1)).not.toBe(fileSignature(FILE_TOKEN, 'G'.repeat(26), SESSION_ID, 1));
  });
});

describe('uploadAttachment (anexos §2)', () => {
  it('asks upload.begin with the name, size and SHA-256, sends the bytes and reports progress up to the end', async () => {
    const f = await fake();
    const s = session(f);
    const bytes = randomBytes(1024 * 1024 + 123);
    const progress: Array<[number, number]> = [];
    const fileId = await uploadAttachment(s, { channelId: CHANNEL, name: 'relatório.pdf', bytes, onProgress: (sent, total) => progress.push([sent, total]) }, quick);
    expect(fileId).toBe(FILE_ID);
    expect(s.requests).toEqual([{ t: 'upload.begin', d: { purpose: 'attachment', channelId: CHANNEL, name: 'relatório.pdf', size: bytes.length, sha256: sha256Hex(bytes) } }]);
    expect(f.seen.map((x) => [x.method, x.path])).toEqual([['POST', '/upload']]);
    expect(f.seen[0]!.body.equals(bytes)).toBe(true);
    // Several steps (the body leaves in chunks), always growing, ending at the total.
    expect(progress.length).toBeGreaterThan(2);
    expect(progress.every(([sent], i) => i === 0 || sent > progress[i - 1]![0])).toBe(true);
    expect(progress.at(-1)).toEqual([bytes.length, bytes.length]);
  });

  it('keeps the server refusal: FILE_TOO_LARGE from POST /upload, QUOTA_EXCEEDED from upload.begin', async () => {
    const f = await fake();
    f.onUpload = (_s, res) => res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' }).end('{"code":"FILE_TOO_LARGE"}');
    expect((await failure(uploadAttachment(session(f), { channelId: CHANNEL, name: 'a.bin', bytes: randomBytes(10) }, quick))).code).toBe('FILE_TOO_LARGE');

    const full = session(f, {
      request: async () => {
        throw Object.assign(new Error('QUOTA_EXCEEDED'), { code: 'QUOTA_EXCEEDED' });
      },
    });
    const before = f.seen.length;
    expect((await failure(uploadAttachment(full, { channelId: CHANNEL, name: 'a.bin', bytes: randomBytes(10) }, quick))).code).toBe('QUOTA_EXCEEDED');
    expect(f.seen.length).toBe(before);
  });

  it('sends nothing to a server without the attachments feature, nor through another key', async () => {
    const f = await fake();
    const old = session(f, { welcome: { sessionId: SESSION_ID, fileToken: FILE_TOKEN, features: [] } });
    expect((await failure(uploadAttachment(old, { channelId: CHANNEL, name: 'a', bytes: randomBytes(4) }, quick))).code).toBe('SERVER_OUTDATED');
    expect(old.requests).toEqual([]);

    const impostor = session(f, { serverKeyId: 'x'.repeat(43) });
    expect((await failure(uploadAttachment(impostor, { channelId: CHANNEL, name: 'a', bytes: randomBytes(4) }, quick))).code).toBe('PIN_MISMATCH');
    expect(f.seen).toEqual([]);
  });

  it('refuses an upload answer for another file', async () => {
    const f = await fake();
    f.onUpload = (_s, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ fileId: 'G'.repeat(26) }));
    expect((await failure(uploadAttachment(session(f), { channelId: CHANNEL, name: 'a', bytes: randomBytes(4) }, quick))).code).toBe('BAD_REQUEST');
  });
});

describe('app://ghostlink/_file (anexos §4)', () => {
  const tmp = useTempDir();

  function route(f: Fake, s: FileSession | null, cacheMaxBytes?: number) {
    const cache = FileCache.open(join(tmp.path, 'attachments'), { maxBytes: cacheMaxBytes });
    const warnings: string[] = [];
    const r = new FileRoute({ session: () => s, cache, open: (x, id, req) => openFile(x, id, req, quick), warn: (m) => warnings.push(m) });
    return { route: r, cache, warnings };
  }

  it('reads the route URL strictly', () => {
    expect(parseFileUrl(serverFileUrl('srv-1', FILE_ID))).toEqual({ serverId: 'srv-1', fileId: FILE_ID });
    for (const bad of ['app://ghostlink/_file', `app://ghostlink/_file/srv-1`, `app://ghostlink/_file/srv-1/${FILE_ID}/x`, 'app://ghostlink/_file/srv-1/lowercase', `app://other/_file/srv-1/${FILE_ID}`]) {
      expect(parseFileUrl(bad), bad).toBeNull();
    }
  });

  it('serves only the inline types with their own type; anything else as a download', () => {
    expect(servedType('image/png')).toEqual({ type: 'image/png', inline: true });
    expect(servedType('video/webm')).toEqual({ type: 'video/webm', inline: true });
    for (const t of ['application/pdf', 'text/html; charset=utf-8', 'image/svg+xml', undefined]) expect(servedType(t)).toEqual({ type: 'application/octet-stream', inline: false });
  });

  it('downloads an image once with the signed URL, then serves it from the disk cache', async () => {
    const f = await fake();
    const image = Buffer.from(png(64, 48));
    f.files.set(FILE_ID, { bytes: image, type: 'image/png' });
    const { route: r, cache } = route(f, session(f));
    const url = serverFileUrl('srv-1', FILE_ID);
    const [a, b] = await Promise.all([r.handle(new Request(url)), r.handle(new Request(url))]);
    for (const res of [a, b]) {
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(Buffer.from(await res.arrayBuffer()).equals(image)).toBe(true);
    }
    expect(f.seen).toHaveLength(1); // two <img> of one file: one request
    expect(cache.get(fileCacheKey(f.pin, FILE_ID))?.bytes.equals(image)).toBe(true);
    const again = await r.handle(new Request(url));
    expect(Buffer.from(await again.arrayBuffer()).equals(image)).toBe(true);
    expect(f.seen).toHaveLength(1);
    // On disk the entry is named by a hash: no server or file id in the folder.
    expect(readdirSync(join(tmp.path, 'attachments'))).toEqual([fileCacheKey(f.pin, FILE_ID)]);
  });

  it('passes Range through for video and streams the part', async () => {
    const f = await fake();
    const video = randomBytes(300_000);
    f.files.set(FILE_ID, { bytes: video, type: 'video/mp4' });
    const { route: r } = route(f, session(f));
    const res = await r.handle(new Request(serverFileUrl('srv-1', FILE_ID), { headers: { Range: 'bytes=1000-1999' } }));
    expect(res.status).toBe(206);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-range')).toBe(`bytes 1000-1999/${video.length}`);
    expect(Buffer.from(await res.arrayBuffer()).equals(video.subarray(1000, 2000))).toBe(true);
    expect(f.seen[0]!.range).toBe('bytes=1000-1999');
  });

  it('serves a document as a download and never keeps it', async () => {
    const f = await fake();
    const pdf = Buffer.from('%PDF-1.4\n%fake\n');
    f.files.set(FILE_ID, { bytes: pdf, type: 'application/pdf' });
    const { route: r, cache } = route(f, session(f));
    const res = await r.handle(new Request(serverFileUrl('srv-1', FILE_ID)));
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toBe('attachment');
    expect(Buffer.from(await res.arrayBuffer()).equals(pdf)).toBe(true);
    expect(cache.get(fileCacheKey(f.pin, FILE_ID))).toBeNull();
  });

  it('is a 404 for another server, no session, a server refusal or a server without the feature', async () => {
    const f = await fake();
    f.files.set(FILE_ID, { bytes: Buffer.from(png(16, 16)), type: 'image/png' });
    expect((await route(f, session(f)).route.handle(new Request(serverFileUrl('srv-2', FILE_ID)))).status).toBe(404);
    expect((await route(f, null).route.handle(new Request(serverFileUrl('srv-1', FILE_ID)))).status).toBe(404);
    expect((await route(f, session(f)).route.handle(new Request(serverFileUrl('srv-1', 'G'.repeat(26))))).status).toBe(404);
    const old = session(f, { welcome: { sessionId: SESSION_ID, fileToken: FILE_TOKEN, features: [] } });
    expect((await route(f, old).route.handle(new Request(serverFileUrl('srv-1', FILE_ID)))).status).toBe(404);
    expect(f.seen.map((s) => s.path)).toEqual([`/files/${'G'.repeat(26)}`]);
  });

  it('keeps at most the cache size, dropping the least recently read image', async () => {
    const dir = join(tmp.path, 'lru');
    const one = Buffer.from(png(16, 16, { size: 4000 }));
    const cache = FileCache.open(dir, { maxBytes: one.length * 2 });
    expect(cache.put(fileCacheKey('k', 'A'), one)).toBe(true);
    expect(cache.put(fileCacheKey('k', 'B'), one)).toBe(true);
    cache.get(fileCacheKey('k', 'A'));
    expect(cache.put(fileCacheKey('k', 'C'), one)).toBe(true);
    expect(cache.get(fileCacheKey('k', 'B'))).toBeNull();
    expect(cache.get(fileCacheKey('k', 'A'))).not.toBeNull();
    expect(cache.put(fileCacheKey('k', 'D'), Buffer.from('not an image'))).toBe(false);
    expect(FileCache.open(dir, { maxBytes: one.length * 2 }).totalBytes).toBe(one.length * 2);
  });
});

const { createAppRequestHandler } = await import('../../src/main/appProtocol.js');

describe('"Baixar" (anexos §1)', () => {
  const tmp = useTempDir();

  it('writes the file where the dialog says, through the app:// route, under the cleaned name', async () => {
    const f = await fake();
    const pdf = randomBytes(200_000);
    f.files.set(FILE_ID, { bytes: pdf, type: 'application/pdf' });
    const r = new FileRoute({ session: () => session(f), cache: FileCache.open(join(tmp.path, 'c')), open: (x, id, req) => openFile(x, id, req, quick), warn: () => {} });
    const handler = createAppRequestHandler(tmp.path, { file: (req) => r.handle(req) });
    const asked: string[] = [];
    const result = await saveAttachment(
      { fetch: handler, choosePath: async (name) => (asked.push(name), join(tmp.path, name)) },
      serverFileUrl('srv-1', FILE_ID),
      'contas: março?.pdf',
    );
    expect(asked).toEqual(['contas_ março_.pdf']);
    expect(result).toEqual({ saved: true, fileName: 'contas_ março_.pdf' });
    expect(readFileSync(join(tmp.path, 'contas_ março_.pdf')).equals(pdf)).toBe(true);
    expect(readdirSync(tmp.path).filter((n) => n.endsWith('.part'))).toEqual([]);
  });

  it('downloads nothing when the dialog is cancelled, and leaves nothing behind on a failure', async () => {
    const f = await fake();
    let fetched = 0;
    const fetch = (_req: Request) => {
      fetched++;
      return new Response(null, { status: 404 });
    };
    expect(await saveAttachment({ fetch, choosePath: async () => null }, serverFileUrl('srv-1', FILE_ID), 'a.pdf')).toEqual({ saved: false, fileName: null });
    expect(fetched).toBe(0);
    const target = join(tmp.path, 'a.pdf');
    expect((await failure(saveAttachment({ fetch, choosePath: async () => target }, serverFileUrl('srv-1', FILE_ID), 'a.pdf'))).code).toBe('NOT_FOUND');
    expect(existsSync(target)).toBe(false);
    expect((await failure(saveAttachment({ fetch, choosePath: async () => target }, 'app://ghostlink/index.html', 'a.pdf'))).code).toBe('BAD_REQUEST');
    expect(f.seen).toEqual([]);
  });
});
