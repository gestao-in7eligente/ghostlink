import { describe, expect, it, vi } from 'vitest';
import {
  RELEASE_NOTES_CACHED_VERSIONS,
  RELEASE_NOTES_MAX_BYTES,
  RELEASE_NOTES_TIMEOUT_MS,
  ReleaseNotes,
  fetchReleaseNotes,
  isAllowedNotesUrl,
  releaseNotesUrl,
} from '../../src/main/releaseNotes.js';
import type { UpdateState } from '../../src/shared/updates.js';

const API = 'https://api.github.com/repos/gestao-in7eligente/ghostlink/releases/tags';
const BODY = '## Português\n\n### O que mudou\n\n- **Novo:** algo.\n';
const encode = (text: string) => new TextEncoder().encode(text);
const release = (version: string, body: string | null = BODY) => JSON.stringify({ tag_name: `v${version}`, name: `GhostLink v${version}`, body, assets: [] });

/** A Response whose body arrives in `chunks`; `stall` keeps it open forever after them. */
function streamed(chunks: Uint8Array[], opts: { stall?: boolean; headers?: Record<string, string> } = {}) {
  let next = 0;
  const seen = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      seen.pulled++;
      if (next < chunks.length) controller.enqueue(chunks[next++]!);
      else if (opts.stall) return new Promise<void>(() => {});
      else controller.close();
      return undefined;
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { response: new Response(body, { status: 200, headers: opts.headers }), seen };
}

function answering(text: string, init: ResponseInit = {}) {
  return vi.fn(async (_url: string, _init?: RequestInit) => new Response(text, { status: 200, ...init }));
}

describe('the release API URL and its allow-list', () => {
  it('asks api.github.com for the release of exactly that tag', () => {
    expect(releaseNotesUrl('0.2.3')).toBe(`${API}/v0.2.3`);
    expect(isAllowedNotesUrl(releaseNotesUrl('0.2.3'))).toBe(true);
  });

  it('refuses versions that are not stable releases, so nothing else can be put in the path', () => {
    for (const version of ['0.2.3-rc.1', '../../users/x', '0.2', 'v0.2.3', '']) expect(() => releaseNotesUrl(version), version).toThrow();
  });

  it.each([
    ['plain http', 'http://api.github.com/repos/x'],
    ['github.com itself', 'https://github.com/gestao-in7eligente/ghostlink/releases'],
    ['a look-alike host', 'https://api.github.com.evil.example/repos/x'],
    ['another host with the name in the path', 'https://evil.example/api.github.com/repos/x'],
    ['credentials', 'https://user:pass@api.github.com/repos/x'],
    ['another port', 'https://api.github.com:8443/repos/x'],
    ['not a URL', 'api.github.com/repos/x'],
  ])('refuses %s', (_label, url) => {
    expect(isAllowedNotesUrl(url)).toBe(false);
  });
});

describe('fetchReleaseNotes', () => {
  it('reads the body of the release, never following a redirect or sending cookies', async () => {
    const fetch = answering(release('0.2.3'));
    await expect(fetchReleaseNotes('0.2.3', fetch)).resolves.toBe(BODY);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${API}/v0.2.3`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store' });
    expect(init?.headers).toMatchObject({ accept: 'application/vnd.github+json' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('gives an empty text for a release without notes', async () => {
    await expect(fetchReleaseNotes('0.2.3', answering(release('0.2.3', null)))).resolves.toBe('');
  });

  it('never asks anything for a version that is not a stable release', async () => {
    const fetch = answering(release('0.2.3'));
    await expect(fetchReleaseNotes('0.2.3-rc.1', fetch)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['an HTTP error', () => answering('{"message":"Not Found"}', { status: 404 })],
    ['another release', () => answering(release('0.2.4'))],
    ['something that is not JSON', () => answering('<html>rate limited</html>')],
    ['invalid UTF-8', () => vi.fn(async () => new Response(new Uint8Array([0x7b, 0xff, 0x7d]), { status: 200 }))],
  ])('rejects %s', async (_label, make) => {
    await expect(fetchReleaseNotes('0.2.3', make())).rejects.toThrow();
  });

  it('rejects an answer that came from another host', async () => {
    const response = new Response(release('0.2.3'), { status: 200 });
    Object.defineProperty(response, 'url', { value: 'https://evil.example/release.json' });
    await expect(fetchReleaseNotes('0.2.3', async () => response)).rejects.toThrow(/another host/);
  });

  it('caps the size at 64 KB: a declared length over it fails before reading a byte', async () => {
    expect(RELEASE_NOTES_MAX_BYTES).toBe(64 * 1024);
    const { response, seen } = streamed([encode(release('0.2.3'))], { headers: { 'content-length': String(RELEASE_NOTES_MAX_BYTES + 1) } });
    await expect(fetchReleaseNotes('0.2.3', async () => response)).rejects.toThrow(/too large/);
    expect(seen.cancelled).toBe(true);
  });

  it('caps the size at 64 KB while streaming, without a declared length', async () => {
    const chunk = new Uint8Array(16 * 1024).fill(0x20);
    const { response, seen } = streamed([chunk, chunk, chunk, chunk, chunk, chunk]);
    await expect(fetchReleaseNotes('0.2.3', async () => response)).rejects.toThrow(/too large/);
    expect(seen.cancelled).toBe(true);
  });

  it('accepts a release right at the cap', async () => {
    const json = release('0.2.3', 'x');
    const padded = json + ' '.repeat(RELEASE_NOTES_MAX_BYTES - json.length);
    await expect(fetchReleaseNotes('0.2.3', answering(padded))).resolves.toBe('x');
  });

  it('gives up after the timeout when no answer comes, aborting the request', async () => {
    expect(RELEASE_NOTES_TIMEOUT_MS).toBe(15_000);
    let signal: AbortSignal | undefined;
    const fetch = vi.fn((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    await expect(fetchReleaseNotes('0.2.3', fetch, { timeoutMs: 20 })).rejects.toThrow(/timed out/);
    expect(signal?.aborted).toBe(true);
  });

  it('gives up after the timeout when the body stalls half-way', async () => {
    const { response } = streamed([encode('{"tag_name":')], { stall: true });
    await expect(fetchReleaseNotes('0.2.3', async () => response, { timeoutMs: 20 })).rejects.toThrow(/timed out/);
  });
});

describe('ReleaseNotes (the cache behind the Updates page)', () => {
  const state = (patch: Partial<UpdateState>): UpdateState => ({
    status: 'idle',
    autoCheck: true,
    currentVersion: '0.2.2',
    version: null,
    percent: null,
    lastCheckedAt: null,
    ...patch,
  });
  const make = (fetch: (url: string, init?: RequestInit) => Promise<Response>) => new ReleaseNotes({ fetch, log: () => {} });

  it('fetches the notes when the updater finds a version, once for that version', async () => {
    const fetch = answering(release('0.2.3'));
    const notes = make(fetch);
    notes.follow(state({ status: 'downloading', version: '0.2.3', percent: 0 }));
    notes.follow(state({ status: 'downloading', version: '0.2.3', percent: 42 }));
    notes.follow(state({ status: 'downloaded', version: '0.2.3' }));
    await expect(notes.get('0.2.3')).resolves.toEqual({ version: '0.2.3', status: 'ready', markdown: BODY });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('asks for nothing unless a version was found', async () => {
    const fetch = answering(release('0.2.3'));
    const notes = make(fetch);
    for (const status of ['unsupported', 'disabled', 'idle', 'checking', 'rejected'] as const) notes.follow(state({ status, version: '0.2.3' }));
    notes.follow(state({ status: 'downloading', version: null }));
    await expect(notes.get('0.2.3')).resolves.toEqual({ version: '0.2.3', status: 'unavailable' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('answers the page while the request is still running', async () => {
    let answer: (r: Response) => void = () => {};
    const fetch = vi.fn(() => new Promise<Response>((resolve) => (answer = resolve)));
    const notes = make(fetch);
    notes.follow(state({ status: 'downloading', version: '0.2.3', percent: 0 }));
    const pending = notes.get('0.2.3');
    answer(new Response(release('0.2.3'), { status: 200 }));
    await expect(pending).resolves.toMatchObject({ status: 'ready', markdown: BODY });
  });

  it('turns a failure into "unavailable" and asks again only after "Procurar atualizações"', async () => {
    const log = vi.fn();
    const fetch = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => {
      throw new Error('net::ERR_INTERNET_DISCONNECTED');
    });
    const notes = new ReleaseNotes({ fetch, log });
    const found = state({ status: 'downloaded', version: '0.2.3' });
    notes.follow(found);
    await expect(notes.get('0.2.3')).resolves.toEqual({ version: '0.2.3', status: 'unavailable' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('0.2.3'));
    notes.follow(found); // a later state of the same version: no new request
    expect(fetch).toHaveBeenCalledOnce();

    fetch.mockImplementationOnce(async () => new Response(release('0.2.3'), { status: 200 }));
    notes.forgetFailures();
    notes.follow(found);
    await expect(notes.get('0.2.3')).resolves.toMatchObject({ status: 'ready' });
    expect(fetch).toHaveBeenCalledTimes(2);
    notes.forgetFailures(); // notes that loaded stay
    notes.follow(found);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps a bounded number of versions', async () => {
    const fetch = vi.fn(async (url: string) => new Response(release(url.slice(url.lastIndexOf('/v') + 2)), { status: 200 }));
    const notes = make(fetch);
    for (let minor = 0; minor <= RELEASE_NOTES_CACHED_VERSIONS; minor++) notes.follow(state({ status: 'downloading', version: `1.${minor}.0` }));
    await expect(notes.get('1.0.0')).resolves.toMatchObject({ status: 'unavailable' });
    await expect(notes.get(`1.${RELEASE_NOTES_CACHED_VERSIONS}.0`)).resolves.toMatchObject({ status: 'ready' });
  });
});
