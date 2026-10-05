import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { GHOST_DJ_LIMITS } from '@ghostlink/shared';
import type { Logger } from '../logger.js';
import { videoIdOf, type PlayTarget } from './youtube.js';

/**
 * yt-dlp for the Ghost DJ (spec §2): the official standalone binary from the project's GitHub
 * releases, checked against the SHA2-256SUMS of the same release before it is ever run, kept in
 * `<data>/ghost-dj/` with a manifest of its hash (checked again at every start), and updated once
 * a day without touching what plays. `<data>/ghost-dj/cookies.txt`, when the owner puts one there,
 * goes to every run (YouTube blocks many cloud IPs without it). Its content never reaches the log.
 */
export const YTDLP_RELEASES = 'https://github.com/yt-dlp/yt-dlp';
export const COOKIES_FILE = 'cookies.txt';
const SUMS_FILE = 'SHA2-256SUMS';
const MANIFEST_FILE = 'yt-dlp.json';
const MAX_BINARY_BYTES = 200 * 1024 * 1024;
const MAX_SUMS_BYTES = 256 * 1024;
const TAG = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DAY_MS = 24 * 3_600_000;
/** After a failed first download, the next try (also when someone uses /play). */
const RETRY_MS = 10 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const RESOLVE_TIMEOUT_MS = 90_000;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

/** The release asset for this machine, or null when yt-dlp publishes none. */
export function ytdlpAsset(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  if (platform === 'linux') return arch === 'x64' ? 'yt-dlp_linux' : arch === 'arm64' ? 'yt-dlp_linux_aarch64' : null;
  if (platform === 'darwin') return 'yt-dlp_macos';
  if (platform === 'win32') return arch === 'x64' ? 'yt-dlp.exe' : null;
  return null;
}

/** The hash on the single `<sha256>  <name>` line for `name`; null when there is none or more than one. */
export function checksumFor(sums: string, name: string): string | null {
  const found: string[] = [];
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
    if (m && m[2] === name) found.push(m[1]!.toLowerCase());
  }
  return found.length === 1 ? found[0]! : null;
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

interface Manifest {
  tag: string;
  asset: string;
  sha256: string;
}

export interface YtDlpBinaryOptions {
  /** `<data>/ghost-dj` */
  dir: string;
  logger: Logger;
  /** The GitHub project (tests: a local HTTP server). */
  releases?: string;
  /** Default: ytdlpAsset() of this machine. */
  asset?: string | null;
  fetch?: typeof fetch;
  updateIntervalMs?: number;
}

export type RefreshResult = 'installed' | 'current' | 'failed';

/** The verified yt-dlp binary: installed on first use, updated once a day. */
export class YtDlpBinary {
  readonly #dir: string;
  readonly #logger: Logger;
  readonly #releases: string;
  readonly #asset: string | null;
  readonly #fetch: typeof fetch;
  readonly #interval: number;
  #ready: { path: string; tag: string } | null = null;
  #loading: Promise<void> | null = null;
  #busy: Promise<RefreshResult> | null = null;
  #lastAttempt = Number.NEGATIVE_INFINITY;
  #timer: NodeJS.Timeout | null = null;
  #first: NodeJS.Timeout | null = null;

  constructor(o: YtDlpBinaryOptions) {
    this.#dir = o.dir;
    this.#logger = o.logger;
    this.#releases = (o.releases ?? YTDLP_RELEASES).replace(/\/+$/, '');
    this.#asset = o.asset === undefined ? ytdlpAsset() : o.asset;
    this.#fetch = o.fetch ?? fetch;
    this.#interval = o.updateIntervalMs ?? DAY_MS;
  }

  get asset(): string | null {
    return this.#asset;
  }

  /** The binary to run, once verified; null until then. */
  get path(): string | null {
    return this.#ready?.path ?? null;
  }

  get version(): string | null {
    return this.#ready?.tag ?? null;
  }

  get #exe(): string {
    return join(this.#dir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  }

  /**
   * Checks what is installed, then installs or updates it in the background: `firstDelayMs` after
   * the server started (a /play before that starts it at once), then every day.
   */
  start(firstDelayMs = 30_000): void {
    this.#first = setTimeout(() => void this.refresh(), firstDelayMs);
    this.#first.unref();
    this.#timer = setInterval(() => void this.refresh(), this.#interval);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#first) clearTimeout(this.#first);
    if (this.#timer) clearInterval(this.#timer);
    this.#first = null;
    this.#timer = null;
  }

  /** No binary yet and the last try is old enough (or none was made): try now (someone wants to play). */
  retrySoon(): void {
    if (this.#ready === null && Date.now() - this.#lastAttempt >= RETRY_MS) void this.refresh();
  }

  /** Loads (and checks) an already installed binary, without going online. Once. */
  load(): Promise<void> {
    this.#loading ??= this.#asset === null ? Promise.resolve() : this.#load().catch(() => undefined);
    return this.#loading;
  }

  /** Installs the latest release when there is none or it is newer. Never throws; one at a time. */
  refresh(): Promise<RefreshResult> {
    this.#busy ??= this.#refresh().finally(() => {
      this.#busy = null;
    });
    return this.#busy;
  }

  async #refresh(): Promise<RefreshResult> {
    this.#lastAttempt = Date.now();
    try {
      if (this.#asset === null) throw new Error(`yt-dlp publishes no binary for ${process.platform}-${process.arch}`);
      mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
      await this.load();
      const tag = await this.#latestTag();
      if (this.#ready?.tag === tag) return 'current';
      await this.#install(tag);
      this.#logger.info(`Ghost DJ: yt-dlp ${tag} installed`);
      return 'installed';
    } catch (e) {
      this.#logger.warn(`Ghost DJ: could not ${this.#ready ? 'update' : 'install'} yt-dlp`, { error: e instanceof Error ? e.message : String(e) });
      return 'failed';
    }
  }

  /** The installed binary, if its bytes still match the hash checked when it was downloaded. */
  async #load(): Promise<void> {
    const manifestPath = join(this.#dir, MANIFEST_FILE);
    if (!existsSync(manifestPath) || !existsSync(this.#exe)) return;
    try {
      const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<Manifest>;
      if (typeof m.tag === 'string' && TAG.test(m.tag) && m.asset === this.#asset && typeof m.sha256 === 'string' && SHA256.test(m.sha256)) {
        if ((await sha256File(this.#exe)) === m.sha256) {
          this.#ready = { path: this.#exe, tag: m.tag };
          return;
        }
      }
    } catch {
      // unreadable: downloaded again below
    }
    this.#logger.warn('Ghost DJ: the installed yt-dlp does not match its checksum; downloading it again');
    rmSync(this.#exe, { force: true });
    rmSync(manifestPath, { force: true });
  }

  /** The tag `releases/latest` redirects to (no API call, so no API rate limit). */
  async #latestTag(): Promise<string> {
    const res = await this.#fetch(`${this.#releases}/releases/latest`, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(30_000) });
    const m = /\/releases\/tag\/([^/?#]+)\/?$/.exec(new URL(res.url).pathname);
    const tag = m ? decodeURIComponent(m[1]!) : '';
    if (!res.ok || !TAG.test(tag)) throw new Error(`could not read the latest yt-dlp release (HTTP ${res.status})`);
    return tag;
  }

  async #install(tag: string): Promise<void> {
    const asset = this.#asset!;
    const base = `${this.#releases}/releases/download/${encodeURIComponent(tag)}`;
    const sums = await this.#download(`${base}/${SUMS_FILE}`, MAX_SUMS_BYTES, null);
    const expected = checksumFor(sums.toString('utf8'), asset);
    if (!expected) throw new Error(`${SUMS_FILE} of ${tag} has no single line for ${asset}`);
    const staged = join(this.#dir, `yt-dlp-${randomBytes(6).toString('hex')}.download`);
    try {
      const actual = await this.#download(`${base}/${asset}`, MAX_BINARY_BYTES, staged);
      if (actual.toString('utf8') !== expected) throw new Error(`checksum mismatch for ${asset} ${tag}: refused`);
      chmodSync(staged, 0o700);
      // A running yt-dlp keeps the old file (Linux); the next track uses the new one.
      renameSync(staged, this.#exe);
    } finally {
      rmSync(staged, { force: true });
    }
    const manifest: Manifest = { tag, asset, sha256: expected };
    const tmp = join(this.#dir, `${MANIFEST_FILE}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
    renameSync(tmp, join(this.#dir, MANIFEST_FILE));
    this.#ready = { path: this.#exe, tag };
  }

  /**
   * GET `url` (redirects followed), at most `max` bytes. Into memory when `file` is null (the
   * bytes), else into `file` (the SHA-256 in hex, as UTF-8 bytes).
   */
  async #download(url: string, max: number, file: string | null): Promise<Buffer> {
    const res = await this.#fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url.slice(url.lastIndexOf('/') + 1)}`);
    const declared = Number(res.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > max) throw new Error('the download is too large');
    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    const fd = file === null ? null : openSync(file, 'wx', 0o600);
    let size = 0;
    try {
      for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
        size += part.length;
        if (size > max) throw new Error('the download is too large');
        if (fd === null) chunks.push(Buffer.from(part));
        else {
          hash.update(part);
          writeSync(fd, part);
        }
      }
    } finally {
      if (fd !== null) closeSync(fd);
    }
    return fd === null ? Buffer.concat(chunks) : Buffer.from(hash.digest('hex'), 'utf8');
  }
}

/** The yt-dlp release installed in `dir` (its manifest; not re-checked), or null. */
export function installedYtdlpVersion(dir: string): string | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8')) as Partial<Manifest>;
    return typeof m.tag === 'string' && TAG.test(m.tag) ? m.tag : null;
  } catch {
    return null;
  }
}

// ---- running it ----

/** Why a track cannot be played (the message each one gets is in commands.ts). */
export type TrackError = 'blocked' | 'unavailable' | 'not_found' | 'live' | 'too_long' | 'failed';

export interface ResolvedTrack {
  id: string;
  title: string;
  url: string;
  durationSec: number | null;
}

export type ResolveResult =
  | { ok: true; tracks: ResolvedTrack[]; playlistTitle: string | null; skipped: number }
  | { ok: false; error: TrackError; blockedWithCookies?: boolean };

/** What yt-dlp's message says went wrong. */
export function classifyYtdlpError(stderr: string): TrackError {
  if (/confirm your age|age[- ]restricted|inappropriate for some users/i.test(stderr)) return 'unavailable';
  if (/not a bot|sign in to confirm|--cookies|HTTP Error 429|too many requests/i.test(stderr)) return 'blocked';
  if (/unavailable|private video|has been removed|not available|members[- ]only|terminated|copyright|does not exist/i.test(stderr)) return 'unavailable';
  return 'failed';
}

/** Only what yt-dlp needs from the server's environment (no secrets passed along). */
function childEnv(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'SystemRoot', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

export type SpawnFn = (command: string, args: readonly string[]) => ChildProcessByStdio<null, Readable, Readable>;

const defaultSpawn: SpawnFn = (command, args) => spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: childEnv() });

export interface YtDlpRunnerOptions {
  /** The verified binary (YtDlpBinary.path); null: not ready. */
  binary: () => string | null;
  /** `<data>/ghost-dj` (cookies.txt and yt-dlp's cache live here). */
  dir: string;
  /** Test seam: how the process starts (an argument array, never a shell). */
  spawn?: SpawnFn;
  /** Node, for YouTube's JavaScript challenges (yt-dlp --js-runtimes); default this process's. */
  nodePath?: string;
}

/**
 * Runs yt-dlp: always an argument array without a shell, `--ignore-config`, and the target last,
 * after `--`. The cookies file is passed when it exists (checked at each run, so adding one needs
 * no restart).
 */
export class YtDlpRunner {
  readonly #o: YtDlpRunnerOptions;
  readonly #spawn: SpawnFn;

  constructor(o: YtDlpRunnerOptions) {
    this.#o = o;
    this.#spawn = o.spawn ?? defaultSpawn;
  }

  get ready(): boolean {
    return this.#o.binary() !== null;
  }

  get hasCookies(): boolean {
    return existsSync(join(this.#o.dir, COOKIES_FILE));
  }

  /** Options every run gets. */
  commonArgs(): string[] {
    const args = [
      '--ignore-config',
      '--no-warnings',
      '--no-progress',
      '--cache-dir',
      join(this.#o.dir, 'cache'),
      '--js-runtimes',
      `node:${this.#o.nodePath ?? process.execPath}`,
    ];
    if (this.hasCookies) args.push('--cookies', join(this.#o.dir, COOKIES_FILE));
    return args;
  }

  /** The arguments that read a video, search or playlist as JSON. */
  resolveArgs(target: PlayTarget): string[] {
    const args = [...this.commonArgs(), '--skip-download', '--dump-single-json', '-f', 'bestaudio/best'];
    if (target.kind === 'video') args.push('--no-playlist');
    // A playlist's items are listed, not opened: each one is read when its turn comes.
    if (target.kind === 'playlist') args.push('--flat-playlist', '--playlist-end', String(GHOST_DJ_LIMITS.maxPlaylistItems));
    args.push('--', target.url);
    return args;
  }

  /** The arguments that stream one video's best audio to stdout (for ffmpeg). */
  audioArgs(videoUrl: string): string[] {
    return [...this.commonArgs(), '--quiet', '--no-playlist', '-f', 'bestaudio/best', '-o', '-', '--', videoUrl];
  }

  /** yt-dlp writing the video's audio to its stdout; null when it is not installed yet. */
  audio(videoUrl: string): ChildProcessByStdio<null, Readable, Readable> | null {
    const binary = this.#o.binary();
    return binary === null ? null : this.#spawn(binary, this.audioArgs(videoUrl));
  }

  async resolve(target: PlayTarget): Promise<ResolveResult> {
    const binary = this.#o.binary();
    if (binary === null) return { ok: false, error: 'failed' };
    const cookies = this.hasCookies;
    const { code, stdout, stderr } = await this.#run(binary, this.resolveArgs(target));
    if (code !== 0) {
      const error = classifyYtdlpError(stderr);
      return error === 'blocked' ? { ok: false, error, blockedWithCookies: cookies } : { ok: false, error };
    }
    let info: unknown;
    try {
      info = JSON.parse(stdout);
    } catch {
      return { ok: false, error: 'failed' };
    }
    return parseResolved(info, target);
  }

  #run(binary: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      let child: ChildProcessByStdio<null, Readable, Readable>;
      try {
        child = this.#spawn(binary, args);
      } catch (e) {
        resolve({ code: -1, stdout: '', stderr: String(e) });
        return;
      }
      const out: Buffer[] = [];
      let outSize = 0;
      let err = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), RESOLVE_TIMEOUT_MS);
      child.stdout.on('data', (c: Buffer) => {
        outSize += c.length;
        if (outSize > MAX_JSON_BYTES) child.kill('SIGKILL');
        else out.push(c);
      });
      child.stderr.on('data', (c: Buffer) => {
        if (err.length < MAX_STDERR_BYTES) err += c.toString('utf8');
      });
      child.on('error', (e) => (err += String(e)));
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: outSize > MAX_JSON_BYTES ? -1 : code, stdout: Buffer.concat(out).toString('utf8'), stderr: err });
      });
    });
  }
}

const UNPLAYABLE_TITLES = new Set(['[Private video]', '[Deleted video]', '[Unavailable video]']);

function entryOf(raw: unknown): { track: ResolvedTrack; live: boolean } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const e = raw as Record<string, unknown>;
  const id = videoIdOf(e.id);
  if (!id) return null;
  const title = typeof e.title === 'string' && e.title.trim() !== '' ? e.title : id;
  if (UNPLAYABLE_TITLES.has(title)) return null;
  const duration = typeof e.duration === 'number' && Number.isFinite(e.duration) && e.duration >= 0 ? e.duration : null;
  const live = e.is_live === true || e.live_status === 'is_live' || e.live_status === 'is_upcoming';
  return { track: { id, title, url: `https://www.youtube.com/watch?v=${id}`, durationSec: duration }, live };
}

/**
 * yt-dlp's JSON as tracks: a single video (or the search's first result) must be playable now
 * (not live, at most 3 h); a playlist keeps its playable items, up to 50, and counts the others.
 */
export function parseResolved(info: unknown, target: PlayTarget): ResolveResult {
  const o = (typeof info === 'object' && info !== null ? info : {}) as Record<string, unknown>;
  const entries = Array.isArray(o.entries) ? o.entries : null;
  if (target.kind === 'playlist') {
    if (!entries) return { ok: false, error: 'not_found' };
    const tracks: ResolvedTrack[] = [];
    let skipped = 0;
    for (const raw of entries.slice(0, GHOST_DJ_LIMITS.maxPlaylistItems)) {
      const entry = entryOf(raw);
      if (!entry || entry.live || (entry.track.durationSec ?? 0) > GHOST_DJ_LIMITS.maxTrackSeconds) skipped++;
      else tracks.push(entry.track);
    }
    if (tracks.length === 0) return { ok: false, error: skipped > 0 ? 'unavailable' : 'not_found' };
    return { ok: true, tracks, playlistTitle: typeof o.title === 'string' ? o.title : null, skipped };
  }
  const first = entries ? entries[0] : info;
  if (first === undefined) return { ok: false, error: 'not_found' };
  const entry = entryOf(first);
  if (!entry) return { ok: false, error: target.kind === 'search' ? 'not_found' : 'unavailable' };
  if (entry.live) return { ok: false, error: 'live' };
  if ((entry.track.durationSec ?? 0) > GHOST_DJ_LIMITS.maxTrackSeconds) return { ok: false, error: 'too_long' };
  return { ok: true, tracks: [entry.track], playlistTitle: null, skipped: 0 };
}
