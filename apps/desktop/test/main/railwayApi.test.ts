import { formatWithOptions } from 'node:util';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RAILWAY_API_URL, RailwayClient, RailwayError, parseRetryAfter, type FetchInit, type FetchResponse, type Operation } from '../../src/main/railway/api.js';

const TOKEN = '6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const QUERY: Operation = { name: 'Deployment', retry: 'query', doc: 'query Deployment($id: String!) { deployment(id: $id) { id status } }' };
const CREATE: Operation = { name: 'ProjectCreate', retry: 'never', doc: 'mutation ProjectCreate { x }' };
const UPSERT: Operation = { name: 'VariableCollectionUpsert', retry: 'idempotent', doc: 'mutation VariableCollectionUpsert { x }' };
const SCHEMA = z.object({ deployment: z.object({ id: z.string(), status: z.string() }) });
const OK = { data: { deployment: { id: 'd1', status: 'SUCCESS' } } };

type Reply = { status?: number; headers?: Record<string, string>; body?: unknown } | Error;

function captureLog() {
  const lines: string[] = [];
  const write = (level: string) => (message: string, ...details: unknown[]) => void lines.push(`${level} ${formatWithOptions({ colors: false }, message, ...details)}`);
  return { lines, info: write('info'), warn: write('warn'), error: write('error') };
}

/** A fetch that answers with `replies` in order (the last one repeats) and records every request. */
function fakeFetch(...replies: Reply[]) {
  const requests: { url: string; init: FetchInit }[] = [];
  const fetch = async (url: string, init: FetchInit): Promise<FetchResponse> => {
    requests.push({ url, init });
    const reply = replies[Math.min(requests.length - 1, replies.length - 1)]!;
    if (reply instanceof Error) throw reply;
    const headers = new Map(Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status: reply.status ?? 200,
      headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
      text: async () => (typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {})),
    };
  };
  return { fetch, requests };
}

function client(fetch: ReturnType<typeof fakeFetch>['fetch'], extra: { timeoutMs?: number } = {}) {
  const sleeps: number[] = [];
  const log = captureLog();
  const api = new RailwayClient({ token: TOKEN, fetch, sleep: async (ms) => void sleeps.push(ms), now: () => 1_000_000, log, ...extra });
  return { api, sleeps, log };
}

async function failure(p: Promise<unknown>): Promise<RailwayError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(RailwayError);
  return e as RailwayError;
}

describe('RailwayClient (research §1)', () => {
  it('POSTs the operation with a Bearer token and returns the checked data', async () => {
    const f = fakeFetch({ body: OK });
    const { api } = client(f.fetch);
    expect(await api.request(QUERY, { id: 'd1' }, SCHEMA)).toEqual(OK.data);
    expect(f.requests).toHaveLength(1);
    const { url, init } = f.requests[0]!;
    expect(url).toBe(RAILWAY_API_URL);
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ query: QUERY.doc, variables: { id: 'd1' }, operationName: 'Deployment' });
  });

  it('maps "Not Authorized" on HTTP 200 to RAILWAY_TOKEN_INVALID, without retrying', async () => {
    const f = fakeFetch({ body: { data: null, errors: [{ message: 'Not Authorized', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] } });
    const e = await failure(client(f.fetch).api.request(QUERY, { id: 'd1' }, SCHEMA));
    expect(e.code).toBe('RAILWAY_TOKEN_INVALID');
    expect(e.messages).toEqual(['Not Authorized']);
    expect(f.requests).toHaveLength(1);
  });

  it('maps an HTTP 401 without a body to RAILWAY_TOKEN_INVALID', async () => {
    const e = await failure(client(fakeFetch({ status: 401, body: '' }).fetch).api.request(QUERY, {}, SCHEMA));
    expect(e.code).toBe('RAILWAY_TOKEN_INVALID');
  });

  it('always inspects errors: other GraphQL errors (even with partial data) are RAILWAY_API_ERROR', async () => {
    const f = fakeFetch({ body: { data: OK.data, errors: [{ message: 'Project not found' }] } });
    const e = await failure(client(f.fetch).api.request(QUERY, {}, SCHEMA));
    expect(e.code).toBe('RAILWAY_API_ERROR');
    expect(e.notFound).toBe(true);
    expect(f.requests).toHaveLength(1);
    const bad = await failure(client(fakeFetch({ status: 400, body: { errors: [{ message: 'Cannot query field "x"' }] } }).fetch).api.request(QUERY, {}, SCHEMA));
    expect(bad.code).toBe('RAILWAY_API_ERROR');
  });

  it('refuses an answer of the wrong shape or without data', async () => {
    expect((await failure(client(fakeFetch({ body: { data: { deployment: { id: 1 } } } }).fetch).api.request(QUERY, {}, SCHEMA))).code).toBe('RAILWAY_API_ERROR');
    expect((await failure(client(fakeFetch({ body: 'not json' }).fetch).api.request(CREATE, {}, SCHEMA))).code).toBe('RAILWAY_API_ERROR');
  });

  it('honours a bounded Retry-After on a 429 for queries', async () => {
    const f = fakeFetch({ status: 429, headers: { 'Retry-After': '2' } }, { body: OK });
    const { api, sleeps } = client(f.fetch);
    expect(await api.request(QUERY, {}, SCHEMA)).toEqual(OK.data);
    expect(sleeps).toEqual([2_000]);
    expect(f.requests).toHaveLength(2);
  });

  it('fails with RAILWAY_RATE_LIMITED on a 429 without Retry-After, with a long one, or once the attempts are spent', async () => {
    for (const headers of [{}, { 'Retry-After': '3600' }] as Record<string, string>[]) {
      const f = fakeFetch({ status: 429, headers });
      const { api, sleeps } = client(f.fetch);
      expect((await failure(api.request(QUERY, {}, SCHEMA))).code).toBe('RAILWAY_RATE_LIMITED');
      expect(f.requests).toHaveLength(1);
      expect(sleeps).toEqual([]);
    }
    const f = fakeFetch({ status: 429, headers: { 'Retry-After': '1' } });
    const { api, sleeps } = client(f.fetch);
    expect((await failure(api.request(QUERY, {}, SCHEMA))).code).toBe('RAILWAY_RATE_LIMITED');
    expect(f.requests).toHaveLength(3);
    expect(sleeps).toEqual([1_000, 1_000]);
  });

  it('never retries a mutation on a 429', async () => {
    for (const op of [CREATE, UPSERT]) {
      const f = fakeFetch({ status: 429, headers: { 'Retry-After': '1' } });
      expect((await failure(client(f.fetch).api.request(op, {}, SCHEMA))).code).toBe('RAILWAY_RATE_LIMITED');
      expect(f.requests).toHaveLength(1);
    }
  });

  it('retries queries on network errors with backoff, then fails with RAILWAY_API_ERROR', async () => {
    const f = fakeFetch(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }));
    const { api, sleeps, log } = client(f.fetch);
    const e = await failure(api.request(QUERY, {}, SCHEMA));
    expect(e.code).toBe('RAILWAY_API_ERROR');
    expect(f.requests).toHaveLength(3);
    expect(sleeps).toEqual([1_000, 2_000]);
    expect(log.lines.join('\n')).toContain('ENOTFOUND');
  });

  it('retries a query after a 5xx but never a mutation that got an answer', async () => {
    const q = fakeFetch({ status: 502, body: '' }, { body: OK });
    expect(await client(q.fetch).api.request(QUERY, {}, SCHEMA)).toEqual(OK.data);
    expect(q.requests).toHaveLength(2);
    for (const op of [CREATE, UPSERT]) {
      const m = fakeFetch({ status: 503, body: '' });
      expect((await failure(client(m.fetch).api.request(op, {}, SCHEMA))).code).toBe('RAILWAY_API_ERROR');
      expect(m.requests).toHaveLength(1);
    }
  });

  it('repeats an idempotent mutation when no answer arrived, never a creation', async () => {
    const lost = new TypeError('fetch failed');
    const idem = fakeFetch(lost, { body: { data: { variableCollectionUpsert: true } } });
    expect(await client(idem.fetch).api.request(UPSERT, {}, z.object({ variableCollectionUpsert: z.boolean() }))).toEqual({ variableCollectionUpsert: true });
    expect(idem.requests).toHaveLength(2);
    const create = fakeFetch(lost);
    expect((await failure(client(create.fetch).api.request(CREATE, {}, SCHEMA))).code).toBe('RAILWAY_API_ERROR');
    expect(create.requests).toHaveLength(1);
  });

  it('gives up on a request after its timeout', async () => {
    const fetch = (_url: string, init: FetchInit) =>
      new Promise<FetchResponse>((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const { api, log } = client(fetch, { timeoutMs: 5 });
    expect((await failure(api.request(CREATE, {}, SCHEMA))).code).toBe('RAILWAY_API_ERROR');
    expect(log.lines.join('\n')).toContain('timed out');
  });

  it('never puts the token in an error or a log line', async () => {
    const echo = fakeFetch({ body: { errors: [{ message: `Invalid token ${TOKEN}` }] } });
    const { api: a, log: logA } = client(echo.fetch);
    const e1 = await failure(a.request(QUERY, {}, SCHEMA));
    const leaky = fakeFetch(new TypeError(`Headers.append: "Bearer ${TOKEN}" is an invalid header value.`));
    const { api: b, log: logB } = client(leaky.fetch);
    const e2 = await failure(b.request(QUERY, {}, SCHEMA));
    for (const text of [e1.message, ...e1.messages, e2.message, ...e2.messages, String(e1.stack), String(e2.stack), ...logA.lines, ...logB.lines]) {
      expect(text).not.toContain(TOKEN);
    }
    expect(logB.lines.join('\n')).toContain('[token]');
  });

  it('reads Retry-After as seconds or as an HTTP date', () => {
    const now = Date.parse('2026-09-29T12:00:00Z');
    expect(parseRetryAfter('5', now)).toBe(5_000);
    expect(parseRetryAfter('Tue, 29 Sep 2026 12:00:10 GMT', now)).toBe(10_000);
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter('soon', now)).toBeNull();
    expect(parseRetryAfter('-1', now)).toBeNull();
  });
});
