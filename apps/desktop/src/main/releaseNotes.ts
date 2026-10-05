// "O que muda na <versão>" on the Updates page (v0.2.3): the notes of a new version are the body of
// its GitHub release. No new third party (GitHub, plus the friends network while it is on): the
// request goes to https://api.github.com alone, never along a redirect, reads at most 64 KB, gives up after 15 s,
// and is made only when the updater finds a version (or the person clicks "Procurar
// atualizações"), once per version. The page reads what was fetched; it never triggers a request.
import { z } from 'zod';
import { RELEASE_REPO, isReleaseVersion } from '@ghostlink/shared';
import type { ReleaseNotesResult, UpdateState } from '../shared/updates.js';

export const RELEASE_NOTES_HOST = 'api.github.com';
export const RELEASE_NOTES_MAX_BYTES = 64 * 1024;
export const RELEASE_NOTES_TIMEOUT_MS = 15_000;
/** Versions remembered at once: in practice one new version per session. */
export const RELEASE_NOTES_CACHED_VERSIONS = 8;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface FetchReleaseNotesOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

/** `https://api.github.com/repos/<owner>/<repo>/releases/tags/v<version>`, for a stable version only. */
export function releaseNotesUrl(version: string): string {
  if (!isReleaseVersion(version)) throw new Error('not a stable release version');
  return `https://${RELEASE_NOTES_HOST}/repos/${RELEASE_REPO.owner}/${RELEASE_REPO.repo}/releases/tags/v${version}`;
}

/** The allow-list: https://api.github.com on the default port, without credentials. Never throws. */
export function isAllowedNotesUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.hostname === RELEASE_NOTES_HOST && url.port === '' && url.username === '' && url.password === '';
}

/**
 * Reads the response body, cancelling it once it passes `maxBytes`. A declared Content-Length over
 * the cap fails before a byte is read.
 */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error('release notes too large');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('empty response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('release notes too large');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

async function download(version: string, url: string, fetchImpl: FetchLike, signal: AbortSignal, maxBytes: number): Promise<string> {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    // The allow-list holds for the whole exchange: a redirect fails instead of being followed.
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store',
    signal,
  });
  if (response.url !== '' && !isAllowedNotesUrl(response.url)) throw new Error('release notes answered from another host');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = await readCapped(response, maxBytes);
  const release = z
    .object({ tag_name: z.literal(`v${version}`), body: z.string().nullable().optional() })
    .safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  if (!release.success) throw new Error('not the release of this version');
  return release.data.body ?? '';
}

/**
 * The Markdown body of the GitHub release `v<version>` (empty when it has none). Rejects on
 * anything else: another host, a redirect, an HTTP error, more than `maxBytes`, more than
 * `timeoutMs` in all (headers and body), or JSON that is not that release.
 */
export async function fetchReleaseNotes(version: string, fetchImpl: FetchLike, opts: FetchReleaseNotesOptions = {}): Promise<string> {
  const { timeoutMs = RELEASE_NOTES_TIMEOUT_MS, maxBytes = RELEASE_NOTES_MAX_BYTES } = opts;
  const url = releaseNotesUrl(version);
  if (!isAllowedNotesUrl(url)) throw new Error(`release notes are only fetched from https://${RELEASE_NOTES_HOST}`);
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new Error('release notes timed out'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([download(version, url, fetchImpl, abort.signal, maxBytes), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface ReleaseNotesDeps {
  /** Electron's net.fetch in the app (system proxy settings), a fake in tests. */
  fetch: FetchLike;
  log?: (message: string) => void;
  timeoutMs?: number;
  maxBytes?: number;
}

/** The new versions' notes, fetched once per version and kept for the session. */
export class ReleaseNotes {
  readonly #deps: ReleaseNotesDeps;
  readonly #cache = new Map<string, Promise<ReleaseNotesResult>>();
  readonly #failed = new Set<string>();

  constructor(deps: ReleaseNotesDeps) {
    this.#deps = deps;
  }

  /**
   * Follows the updater's state: a version it found (downloading or downloaded) gets its notes
   * fetched, once. Every other state asks for nothing.
   */
  follow(state: UpdateState): void {
    if ((state.status === 'downloading' || state.status === 'downloaded') && state.version !== null) void this.#load(state.version);
  }

  /** What the page shows: the notes fetched (or being fetched) for `version`. Never a request of its own. */
  get(version: string): Promise<ReleaseNotesResult> {
    return this.#cache.get(version) ?? Promise.resolve({ version, status: 'unavailable' });
  }

  /** "Procurar atualizações": notes that failed are fetched again the next time their version is found. */
  forgetFailures(): void {
    for (const version of this.#failed) this.#cache.delete(version);
    this.#failed.clear();
  }

  #load(version: string): Promise<ReleaseNotesResult> {
    const cached = this.#cache.get(version);
    if (cached) return cached;
    if (this.#cache.size >= RELEASE_NOTES_CACHED_VERSIONS) {
      const oldest = this.#cache.keys().next().value!;
      this.#cache.delete(oldest);
      this.#failed.delete(oldest);
    }
    const result = fetchReleaseNotes(version, this.#deps.fetch, { timeoutMs: this.#deps.timeoutMs, maxBytes: this.#deps.maxBytes }).then(
      (markdown): ReleaseNotesResult => ({ version, status: 'ready', markdown }),
      (e: unknown): ReleaseNotesResult => {
        if (this.#cache.get(version) === result) this.#failed.add(version);
        (this.#deps.log ?? console.warn)(`[updates] the notes of ${version} are unavailable: ${e instanceof Error ? e.message : 'unknown error'}`);
        return { version, status: 'unavailable' };
      },
    );
    this.#cache.set(version, result);
    return result;
  }
}
