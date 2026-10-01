// avatarHttp against a local HTTPS fake with a self-signed certificate and its pin: the
// signed GET /avatars/<hash> and upload.begin → POST /upload (spec 2026-10-01 §4, main spec §7).
// avatarIntegration.test.ts runs the same code against a real server.
import { createHmac, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AVATAR_LIMITS, FILE_URL_MAX_AHEAD_S, ProtocolError, avatarTarget, fileSignatureInput, fileUrlExpiry } from '@ghostlink/shared';
import { generateCertificate } from '../../../server/src/tls/certificate.js';
import { serverKeyIdFromCertificate } from '../../src/main/pinning.js';
import {
  avatarSignature,
  clearAvatar,
  downloadAvatar,
  signedAvatarPath,
  uploadAvatar,
  type AvatarServer,
} from '../../src/main/avatars/avatarHttp.js';
import { png, sha256Hex, webp } from './avatarFixtures.js';

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Buffer;
}

type Answer = (seen: Seen, res: ServerResponse) => void;

interface Fake {
  port: number;
  pin: string;
  seen: Seen[];
  /** Request heads parsed, counted before any body arrives. */
  heads: number;
  answer: Answer;
  close(): Promise<void>;
}

const fakes: Fake[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.close()));
});

const cert = generateCertificate();

/** An HTTPS server that records every request and answers with `fake.answer`. */
async function fake(answer: Answer = (_s, res) => res.writeHead(404).end()): Promise<Fake> {
  const { certPem, keyPem } = await cert;
  const seen: Seen[] = [];
  const server: Server = createServer({ cert: certPem, key: keyPem });
  const f: Fake = {
    port: 0,
    pin: serverKeyIdFromCertificate(certPem),
    seen,
    heads: 0,
    answer,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    f.heads++;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'https://fake');
      const s: Seen = { method: req.method ?? '', path: url.pathname, query: url.searchParams, body: Buffer.concat(chunks) };
      seen.push(s);
      f.answer(s, res);
    });
  });
  server.on('tlsClientError', () => {});
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  f.port = (server.address() as AddressInfo).port;
  fakes.push(f);
  return f;
}

const FILE_TOKEN = randomBytes(32).toString('base64url');
const SESSION_ID = randomBytes(16).toString('base64url');

function session(f: Fake, over: Partial<AvatarServer> = {}): AvatarServer & { requests: Array<{ t: string; d: unknown }> } {
  const requests: Array<{ t: string; d: unknown }> = [];
  return {
    address: `127.0.0.1:${f.port}`,
    serverKeyId: f.pin,
    welcome: { sessionId: SESSION_ID, fileToken: FILE_TOKEN },
    clockOffsetMs: 0,
    requests,
    request: async <T>(t: string, d?: unknown) => {
      requests.push({ t, d });
      return (t === 'upload.begin' ? { uploadToken: 'tok_123' } : {}) as T;
    },
    ...over,
  };
}

/** What the server checks (main spec §7), written out independently of avatarHttp. */
function validSignature(q: URLSearchParams, hash: string): boolean {
  const sid = q.get('sid') ?? '';
  const e = Number(q.get('e'));
  const expected = createHmac('sha256', FILE_TOKEN).update(fileSignatureInput(avatarTarget(hash), sid, e)).digest('base64url');
  return sid === SESSION_ID && q.get('s') === expected;
}

async function failure(p: Promise<unknown>): Promise<Error & { code: string }> {
  try {
    await p;
  } catch (e) {
    return e as Error & { code: string };
  }
  throw new Error('expected a failure');
}

const quick = { timeoutMs: 300 };

describe('signed avatar URLs (main spec §7)', () => {
  it('HMAC-SHA256 keyed with the fileToken text exactly as the welcome carries it, base64url without padding', () => {
    const hash = sha256Hex(webp());
    const sig = avatarSignature(FILE_TOKEN, hash, SESSION_ID, 1_800_000_600);
    const input = `ghostlink-file-v1\navatar:${hash}\n${SESSION_ID}\n1800000600`;
    expect(sig).toBe(createHmac('sha256', Buffer.from(FILE_TOKEN, 'utf8')).update(input, 'utf8').digest('base64url'));
    // Not the 32 decoded bytes: both sides key with the string they hold.
    expect(sig).not.toBe(createHmac('sha256', Buffer.from(FILE_TOKEN, 'base64url')).update(input).digest('base64url'));
    expect(sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('expires at the end of the next 10-minute window of the server clock', async () => {
    const f = await fake();
    const hash = sha256Hex(webp());
    const now = Date.UTC(2026, 9, 1, 12, 3, 0);
    const ahead = session(f, { clockOffsetMs: 3_600_000 }); // the server clock is one hour ahead
    const path = new URL(signedAvatarPath(ahead, hash, now), 'https://x');
    expect(path.pathname).toBe(`/avatars/${hash}`);
    const e = Number(path.searchParams.get('e'));
    expect(e).toBe(fileUrlExpiry(now + 3_600_000));
    expect(path.searchParams.get('sid')).toBe(SESSION_ID);
    expect(path.searchParams.get('s')).toBe(avatarSignature(FILE_TOKEN, hash, SESSION_ID, e));
  });

  it('stays within the server’s 20 minutes even right after a window starts, with the clock a little ahead', () => {
    const windowStart = Date.UTC(2026, 9, 1, 12, 10, 0);
    for (const now of [windowStart, windowStart + 1, windowStart + 999, windowStart + 20_000, windowStart + 599_999]) {
      const e = Number(new URL(signedAvatarPath({ ...session({ port: 1, pin: 'x' } as Fake), clockOffsetMs: 0 }, 'a'.repeat(64), now), 'https://x').searchParams.get('e'));
      const realServerNow = now - 20_000; // our clock runs 20 s ahead of the server's
      expect(e * 1000 - realServerNow, String(now)).toBeLessThanOrEqual(FILE_URL_MAX_AHEAD_S * 1000);
      expect(e * 1000 - now, String(now)).toBeGreaterThan(9 * 60_000); // and still lasts > 9 min
    }
  });
});

describe('downloadAvatar', () => {
  it('fetches the bytes over the pinned connection with a valid signature', async () => {
    const bytes = png(64, 64, { size: 5000 });
    const hash = sha256Hex(bytes);
    const f = await fake((s, res) => {
      if (s.method === 'GET' && s.path === `/avatars/${hash}` && validSignature(s.query, hash)) res.writeHead(200, { 'Content-Type': 'image/png' }).end(bytes);
      else res.writeHead(403).end();
    });
    expect(new Uint8Array(await downloadAvatar(session(f), hash))).toEqual(bytes);
    expect(f.seen).toHaveLength(1);
  });

  it.each([
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [500, 'INTERNAL'],
  ])('turns a %i into %s, with no URL, hash or token in the error', async (status, code) => {
    const f = await fake((_s, res) => res.writeHead(status).end());
    const hash = sha256Hex(webp());
    const err = await failure(downloadAvatar(session(f), hash));
    expect(err.code).toBe(code);
    for (const secret of [hash, SESSION_ID, FILE_TOKEN, 'sid=']) expect(`${err.message} ${err.stack}`).not.toContain(secret);
  });

  it('cuts a response that announces more than 2 MB', async () => {
    const f = await fake((_s, res) => {
      res.writeHead(200, { 'Content-Length': AVATAR_LIMITS.maxBytes + 1 });
      res.write(Buffer.alloc(1024));
    });
    expect((await failure(downloadAvatar(session(f), sha256Hex(webp()), quick))).code).toBe('BAD_REQUEST');
  });

  it('cuts a streamed response as soon as it passes 2 MB', async () => {
    const f = await fake((_s, res) => {
      res.writeHead(200); // chunked, no length
      const chunk = Buffer.alloc(256 * 1024);
      for (let i = 0; i < 9; i++) res.write(chunk);
    });
    expect((await failure(downloadAvatar(session(f), sha256Hex(webp()), quick))).code).toBe('BAD_REQUEST');
  });

  it('gives up after the timeout', async () => {
    const f = await fake(() => {}); // never answers
    const started = Date.now();
    const err = await failure(downloadAvatar(session(f), sha256Hex(webp()), { timeoutMs: 200 }));
    expect(err.code).toBe('TIMEOUT');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('refuses a server with another key before sending a single HTTP byte', async () => {
    const f = await fake((_s, res) => res.writeHead(200).end(webp()));
    const wrongPin = Buffer.alloc(32, 7).toString('base64url');
    const err = await failure(downloadAvatar(session(f, { serverKeyId: wrongPin }), sha256Hex(webp())));
    expect(err.code).toBe('PIN_MISMATCH');
    await new Promise((r) => setTimeout(r, 100));
    expect(f.heads).toBe(0);
  });

  it('reports an address nobody answers as UNREACHABLE', async () => {
    const f = await fake();
    const port = f.port;
    await f.close();
    fakes.splice(fakes.indexOf(f), 1);
    const err = await failure(downloadAvatar(session({ ...f, port }), sha256Hex(webp()), quick));
    expect(err.code).toBe('UNREACHABLE');
  });
});

describe('uploadAvatar (spec §4)', () => {
  it('asks for an upload token over the session, then POSTs the bytes with it', async () => {
    const bytes = webp(256, 256, { size: 3000 });
    const hash = sha256Hex(bytes);
    const f = await fake((s, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ avatar: sha256Hex(s.body) }));
    });
    const s = session(f);
    expect(await uploadAvatar(s, bytes)).toBe(hash);
    expect(s.requests).toEqual([{ t: 'upload.begin', d: { purpose: 'avatar', size: 3000, sha256: hash } }]);
    expect(f.seen).toHaveLength(1);
    expect(f.seen[0]).toMatchObject({ method: 'POST', path: '/upload' });
    expect(f.seen[0]!.query.get('u')).toBe('tok_123');
    expect(new Uint8Array(f.seen[0]!.body)).toEqual(bytes);
  });

  it('never sends the upload token or the bytes to a server with another key', async () => {
    const f = await fake((_s, res) => res.writeHead(200).end(JSON.stringify({ avatar: sha256Hex(webp()) })));
    const wrongPin = Buffer.alloc(32, 7).toString('base64url');
    expect((await failure(uploadAvatar(session(f, { serverKeyId: wrongPin }), webp()))).code).toBe('PIN_MISMATCH');
    await new Promise((r) => setTimeout(r, 100));
    expect(f.heads).toBe(0);
  });

  it('passes the server’s refusal of upload.begin on and never POSTs', async () => {
    const f = await fake();
    const s = session(f, {
      request: async () => {
        throw new ProtocolError('RATE_LIMITED');
      },
    });
    expect((await failure(uploadAvatar(s, webp()))).code).toBe('RATE_LIMITED');
    expect(f.seen).toEqual([]);
  });

  it('refuses a malformed upload.begin answer and never POSTs', async () => {
    const f = await fake();
    const s = session(f, { request: async <T>() => ({ uploadToken: 'has spaces/and?query' }) as T });
    expect((await failure(uploadAvatar(s, webp()))).code).toBe('BAD_REQUEST');
    expect(f.seen).toEqual([]);
  });

  it.each([
    [400, JSON.stringify({ code: 'BAD_REQUEST' }), 'BAD_REQUEST'],
    [400, JSON.stringify({ code: 'IMAGE_TOO_LARGE' }), 'IMAGE_TOO_LARGE'],
    [400, 'not json', 'BAD_REQUEST'],
    [403, '', 'FORBIDDEN'],
    [200, JSON.stringify({ avatar: 'nope' }), 'BAD_REQUEST'],
  ])('turns a %i %s into %s', async (status, body, code) => {
    const f = await fake((_s, res) => res.writeHead(status).end(body));
    expect((await failure(uploadAvatar(session(f), webp()))).code).toBe(code);
  });
});

describe('clearAvatar', () => {
  it('sends avatar.clear {} over the session', async () => {
    const f = await fake();
    const s = session(f);
    await clearAvatar(s);
    expect(s.requests).toEqual([{ t: 'avatar.clear', d: {} }]);
  });
});
