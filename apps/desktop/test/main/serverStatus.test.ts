// GET /health and the signed GET /owner/status (spec 2026-10-01 §2, §3) against a local HTTPS
// fake with a self-signed certificate and its pin, the way avatarHttp.test.ts does it. The fake
// checks the signature on its own (Ed25519 over the exact text), not with the code under test.
import { createPublicKey, randomBytes, verify } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { buildOwnerStatusMessage, ed25519SpkiDer, fromBase64Url } from '@ghostlink/shared';
import { generateCertificate } from '../../../server/src/tls/certificate.js';
import { serverKeyFromSeed } from '../../src/main/identity.js';
import { serverKeyIdFromCertificate } from '../../src/main/pinning.js';
import { fetchHealth, fetchOwnerStatus } from '../../src/main/railway/serverStatus.js';

interface Seen {
  path: string;
  query: URLSearchParams;
}

interface Fake {
  port: number;
  pin: string;
  seen: Seen[];
  heads: number;
  answer: (seen: Seen, res: ServerResponse) => void;
  close(): Promise<void>;
}

const fakes: Fake[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.close()));
});

const cert = generateCertificate();

async function fake(answer: Fake['answer']): Promise<Fake> {
  const { certPem, keyPem } = await cert;
  const server: Server = createServer({ cert: certPem, key: keyPem });
  const f: Fake = {
    port: 0,
    pin: serverKeyIdFromCertificate(certPem),
    seen: [],
    heads: 0,
    answer,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    f.heads++;
    const url = new URL(req.url ?? '/', 'https://fake');
    const seen = { path: url.pathname, query: url.searchParams };
    f.seen.push(seen);
    f.answer(seen, res);
  });
  server.on('tlsClientError', () => {});
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  f.port = (server.address() as AddressInfo).port;
  fakes.push(f);
  return f;
}

const owner = serverKeyFromSeed(randomBytes(32));
const stranger = serverKeyFromSeed(randomBytes(32));
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0, 750);
const NOW_S = Math.floor(NOW / 1000);

/** What the server checks (spec §2), written out independently of serverStatus.ts. */
function signedByOwner(q: URLSearchParams, serverKeyId: string): boolean {
  const ts = q.get('ts') ?? '';
  const sig = q.get('sig') ?? '';
  if (!/^\d+$/.test(ts) || !/^[A-Za-z0-9_-]+$/.test(sig)) return false;
  const text = Buffer.from(`ghostlink-owner-status-v1\n${serverKeyId}\n${ts}`, 'utf8');
  const publicKey = createPublicKey({ key: Buffer.from(ed25519SpkiDer(owner.publicKeyRaw)), format: 'der', type: 'spki' });
  return verify(null, text, publicKey, Buffer.from(fromBase64Url(sig))) && Math.abs(Number(ts) - NOW_S) <= 60;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

function statusServer(voiceActive: boolean) {
  return fake((s, res) => {
    if (s.path === '/health') return json(res, 200, { ok: true, name: 'Casa', version: '0.2.1', protocol: { min: 1, max: 1 } });
    if (s.path === '/owner/status' && signedByOwner(s.query, f.pin)) return json(res, 200, { version: '0.2.1', voiceActive });
    res.writeHead(403, { 'Content-Type': 'application/json' }).end('{"code":"FORBIDDEN"}');
  });
}
let f: Fake;

async function failure(p: Promise<unknown>): Promise<Error & { code: string }> {
  try {
    await p;
  } catch (e) {
    return e as Error & { code: string };
  }
  throw new Error('expected a failure');
}

const target = (x: Fake, pin = x.pin) => ({ address: `127.0.0.1:${x.port}`, serverKeyId: pin });

describe('the owner-status text (spec §2, built by @ghostlink/shared)', () => {
  it('is exactly "ghostlink-owner-status-v1\\n<serverKeyId>\\n<ts>" in UTF-8', () => {
    const keyId = Buffer.alloc(32, 7).toString('base64url');
    expect(Buffer.from(buildOwnerStatusMessage(keyId, 1_790_000_000)).toString('utf8')).toBe(`ghostlink-owner-status-v1\n${keyId}\n1790000000`);
  });
});

describe('fetchHealth', () => {
  it('reads the version over the pinned connection', async () => {
    f = await statusServer(false);
    expect(await fetchHealth(target(f))).toEqual({ version: '0.2.1' });
    expect(f.seen.map((s) => s.path)).toEqual(['/health']);
  });

  it('refuses a server with another key before sending a single HTTP byte', async () => {
    f = await statusServer(false);
    const err = await failure(fetchHealth(target(f, Buffer.alloc(32, 9).toString('base64url'))));
    expect(err.code).toBe('PIN_MISMATCH');
    await new Promise((r) => setTimeout(r, 100));
    expect(f.heads).toBe(0);
  });

  it('turns an answer without a version into BAD_REQUEST', async () => {
    f = await fake((_s, res) => json(res, 200, { ok: true }));
    expect((await failure(fetchHealth(target(f)))).code).toBe('BAD_REQUEST');
  });
});

describe('fetchOwnerStatus', () => {
  it('signs ts with my key for this server and reads voiceActive', async () => {
    f = await statusServer(true);
    expect(await fetchOwnerStatus(target(f), owner, { now: () => NOW })).toEqual({ version: '0.2.1', voiceActive: true });
    const [seen] = f.seen;
    expect(seen!.path).toBe('/owner/status');
    expect(seen!.query.get('ts')).toBe(String(NOW_S)); // whole seconds, rounded down
    expect([...seen!.query.keys()].sort()).toEqual(['sig', 'ts']);
    expect(seen!.query.get('sig')).toMatch(/^[A-Za-z0-9_-]{86}$/); // 64 bytes, base64url without padding
  });

  it('answers idle too', async () => {
    f = await statusServer(false);
    expect((await fetchOwnerStatus(target(f), owner, { now: () => NOW })).voiceActive).toBe(false);
  });

  it('turns a refusal (another identity) into FORBIDDEN, with no signature in the error', async () => {
    f = await statusServer(false);
    const err = await failure(fetchOwnerStatus(target(f), stranger, { now: () => NOW }));
    expect(err.code).toBe('FORBIDDEN');
    const sig = f.seen[0]!.query.get('sig')!;
    expect(`${err.message} ${err.stack}`).not.toContain(sig);
    expect(`${err.message} ${err.stack}`).not.toContain('/owner/status');
  });

  it('a clock more than 60 s off is refused like any bad signature', async () => {
    f = await statusServer(false);
    expect((await failure(fetchOwnerStatus(target(f), owner, { now: () => NOW + 61_000 }))).code).toBe('FORBIDDEN');
  });

  it('sends nothing to a server with another key', async () => {
    f = await statusServer(false);
    const err = await failure(fetchOwnerStatus(target(f, Buffer.alloc(32, 9).toString('base64url')), owner, { now: () => NOW }));
    expect(err.code).toBe('PIN_MISMATCH');
    await new Promise((r) => setTimeout(r, 100));
    expect(f.heads).toBe(0);
  });

  it.each([
    [404, 'NOT_FOUND'],
    [429, 'RATE_LIMITED'],
    [500, 'UNREACHABLE'],
  ])('turns a %i into %s', async (status, code) => {
    f = await fake((_s, res) => res.writeHead(status).end());
    expect((await failure(fetchOwnerStatus(target(f), owner, { now: () => NOW }))).code).toBe(code);
  });

  it('turns a malformed answer into BAD_REQUEST', async () => {
    f = await fake((_s, res) => json(res, 200, { version: '0.2.1', voiceActive: 'no' }));
    expect((await failure(fetchOwnerStatus(target(f), owner, { now: () => NOW }))).code).toBe('BAD_REQUEST');
  });
});
