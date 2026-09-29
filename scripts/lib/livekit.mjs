// Building blocks of scripts/fetch-livekit.mjs (spec §8.1 "Binários", §15 extraResources).
// No top-level side effects, so scripts/test/fetchLivekit.test.ts can exercise every piece.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { crc32, gunzipSync, inflateRawSync } from 'node:zlib';

export const LIVEKIT_VERSION = '1.13.7';
const RELEASE_BASE = `https://github.com/livekit/livekit/releases/download/v${LIVEKIT_VERSION}`;

/**
 * Official release assets, keyed by electron-builder's `${os}-${arch}` folder name
 * (extraResources `resources/livekit/${os}-${arch}`). The SHA-256 values are pinned
 * from the release's checksums.txt: a download must match the pin AND that file.
 * @type {Readonly<Record<string, { asset: string; sha256: string; binary: string; archive: 'zip' | 'tar.gz' }>>}
 */
export const LIVEKIT_TARGETS = Object.freeze({
  'win-x64': {
    asset: `livekit_${LIVEKIT_VERSION}_windows_amd64.zip`,
    sha256: 'e539e7d2f75807b9c9202cd2a0bf2cb3d52fc4c52978a6953e0f47bc339fe77f',
    binary: 'livekit-server.exe',
    archive: 'zip',
  },
  'linux-x64': {
    asset: `livekit_${LIVEKIT_VERSION}_linux_amd64.tar.gz`,
    sha256: '6634aeeb2fb1366b6723708ae4320b9d5408106a4c63457c5e845ae3979c90e2',
    binary: 'livekit-server',
    archive: 'tar.gz',
  },
  'linux-arm64': {
    asset: `livekit_${LIVEKIT_VERSION}_linux_arm64.tar.gz`,
    sha256: '5d167fdf52cf43c0c72972f25325364479f41f854bfef651056eab2504da5de9',
    binary: 'livekit-server',
    archive: 'tar.gz',
  },
});

/** @param {string} target */
export function assetUrl(target) {
  const pin = LIVEKIT_TARGETS[target];
  if (!pin) throw new Error(`unknown LiveKit target ${target}`);
  return `${RELEASE_BASE}/${pin.asset}`;
}

export const CHECKSUMS_URL = `${RELEASE_BASE}/checksums.txt`;

/**
 * The target folder for a Node platform/arch, or null when LiveKit ships no binary
 * for it (macOS is built from source in CI, spec §8.1; not part of v0.1).
 * @param {string} platform
 * @param {string} arch
 */
export function targetFor(platform, arch) {
  const os = platform === 'win32' ? 'win' : platform === 'linux' ? 'linux' : null;
  if (!os) return null;
  const target = `${os}-${arch}`;
  return Object.hasOwn(LIVEKIT_TARGETS, target) ? target : null;
}

/** `sha256  name` / `sha256 *name` lines → Map(name → sha256). @param {string} text */
export function parseChecksums(text) {
  /** @type {Map<string, string>} */
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line.trim());
    if (m?.[1] && m[2]) map.set(m[2], m[1].toLowerCase());
  }
  return map;
}

/** @param {Uint8Array} data */
function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Reads one entry of a zip archive (stored or deflated; no ZIP64, which the LiveKit
 * release never needs). Sizes come from the central directory, so data descriptors
 * are fine. The CRC-32 is always checked. Returns null when the entry is absent.
 * @param {Buffer} zip
 * @param {string} name
 * @returns {Buffer | null}
 */
export function extractZipEntry(zip, name) {
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip archive (no end of central directory)');
  const count = zip.readUInt16LE(end + 10);
  let p = zip.readUInt32LE(end + 16);
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const compressedSize = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLength = zip.readUInt16LE(p + 28);
    const extraLength = zip.readUInt16LE(p + 30);
    const commentLength = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    const entryName = zip.subarray(p + 46, p + 46 + nameLength).toString('utf8');
    p += 46 + nameLength + extraLength + commentLength;
    if (entryName.replace(/^\.\//, '') !== name) continue;
    if (zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('corrupt zip local header');
    const start = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    const body = zip.subarray(start, start + compressedSize);
    let data;
    if (method === 0) data = Buffer.from(body);
    else if (method === 8) data = inflateRawSync(body);
    else throw new Error(`unsupported zip compression method ${method}`);
    if (data.length !== size || crc32(data) !== crc) throw new Error(`CRC mismatch for ${name}`);
    return data;
  }
  return null;
}

/**
 * Reads one regular file of a .tar.gz (ustar, with GNU long names and pax headers skipped).
 * @param {Buffer} tgz
 * @param {string} name
 * @returns {Buffer | null}
 */
export function extractTarGzEntry(tgz, name) {
  const tar = gunzipSync(tgz);
  let p = 0;
  let longName = null;
  while (p + 512 <= tar.length) {
    const header = tar.subarray(p, p + 512);
    if (header.every((b) => b === 0)) break;
    const field = (/** @type {number} */ from, /** @type {number} */ len) => header.subarray(from, from + len).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1) || '0';
    const prefix = field(257, 6).startsWith('ustar') ? field(345, 155) : '';
    let entryName = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = null;
    const dataStart = p + 512;
    p = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = tar.subarray(dataStart, dataStart + size).toString('utf8').replace(/\0.*$/s, '');
      continue;
    }
    entryName = entryName.replace(/^\.\//, '');
    if ((type === '0' || type === '\0') && entryName === name) return Buffer.from(tar.subarray(dataStart, dataStart + size));
  }
  return null;
}

/**
 * GET with retries (flaky networks): network errors and 5xx/429 are retried with a
 * growing delay; any other non-2xx fails at once.
 * @param {(url: string) => Promise<Response>} fetchImpl
 * @param {string} url
 * @param {{ retries: number; retryDelayMs: number; log: (m: string) => void }} opts
 */
async function download(fetchImpl, url, opts) {
  let lastError = null;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    if (attempt > 0) {
      opts.log(`  retrying ${url} (attempt ${attempt + 1} of ${opts.retries + 1})`);
      await sleep(opts.retryDelayMs * attempt);
    }
    try {
      const res = await fetchImpl(url);
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      lastError = new Error(`GET ${url} failed with HTTP ${res.status}`);
      if (res.status !== 429 && res.status < 500) break;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastError ?? new Error(`GET ${url} failed`);
}

/** @param {string} path @param {Buffer | string} data @param {number} mode */
function writeAtomic(path, data, mode) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data, { mode });
  if (process.platform !== 'win32') chmodSync(tmp, mode);
  rmSync(path, { force: true });
  renameSync(tmp, path);
}

/**
 * Puts a verified livekit-server binary (plus its Apache-2.0 LICENSE) in
 * `<outDir>/<target>/`. Skips everything when the installed binary still matches its
 * stamp. A cached archive is used only when its SHA-256 equals the pin; a download
 * must match the pin and the release's checksums.txt, or nothing is installed.
 * @param {{
 *   target: string;
 *   outDir: string;
 *   cacheDir?: string;
 *   pins?: Readonly<Record<string, { asset: string; sha256: string; binary: string; archive: 'zip' | 'tar.gz' }>>;
 *   fetchImpl?: (url: string) => Promise<Response>;
 *   retries?: number;
 *   retryDelayMs?: number;
 *   log?: (message: string) => void;
 * }} opts
 * @returns {Promise<{ path: string; downloaded: boolean }>}
 */
export async function fetchLivekit(opts) {
  const pins = opts.pins ?? LIVEKIT_TARGETS;
  const pin = pins[opts.target];
  if (!pin) throw new Error(`unknown LiveKit target ${opts.target}`);
  const log = opts.log ?? console.log;
  const net = { retries: opts.retries ?? 5, retryDelayMs: opts.retryDelayMs ?? 2_000, log };
  const fetchImpl = opts.fetchImpl ?? ((url) => globalThis.fetch(url, { redirect: 'follow' }));
  const dir = join(opts.outDir, opts.target);
  const binaryPath = join(dir, pin.binary);
  const stampPath = join(dir, 'VERSION.json');

  if (existsSync(binaryPath) && existsSync(stampPath)) {
    try {
      const stamp = JSON.parse(readFileSync(stampPath, 'utf8'));
      if (stamp.version === LIVEKIT_VERSION && stamp.assetSha256 === pin.sha256 && stamp.binarySha256 === sha256(readFileSync(binaryPath))) {
        log(`LiveKit ${LIVEKIT_VERSION} (${opts.target}) is already installed at ${binaryPath}`);
        return { path: binaryPath, downloaded: false };
      }
    } catch {
      // unreadable stamp: reinstall
    }
  }

  let archive = null;
  let downloaded = false;
  if (opts.cacheDir) {
    const cached = join(opts.cacheDir, pin.asset);
    if (existsSync(cached)) {
      const data = readFileSync(cached);
      if (sha256(data) === pin.sha256) {
        log(`Using the cached ${pin.asset} (SHA-256 verified)`);
        archive = data;
      } else {
        log(`Ignoring ${cached}: its SHA-256 does not match the pin`);
      }
    }
  }
  if (!archive) {
    const url = `${RELEASE_BASE}/${pin.asset}`;
    log(`Downloading ${url}`);
    const data = await download(fetchImpl, url, net);
    const got = sha256(data);
    if (got !== pin.sha256) throw new Error(`SHA-256 mismatch for ${pin.asset}: expected ${pin.sha256}, got ${got}`);
    const official = parseChecksums((await download(fetchImpl, CHECKSUMS_URL, net)).toString('utf8'));
    if (official.get(pin.asset) !== pin.sha256) throw new Error(`the release checksums.txt does not list ${pin.asset} with the pinned SHA-256`);
    archive = data;
    downloaded = true;
    if (opts.cacheDir) {
      mkdirSync(opts.cacheDir, { recursive: true });
      writeAtomic(join(opts.cacheDir, pin.asset), data, 0o644);
    }
  }

  const extract = pin.archive === 'zip' ? extractZipEntry : extractTarGzEntry;
  const binary = extract(archive, pin.binary);
  if (!binary) throw new Error(`${pin.asset} does not contain ${pin.binary}`);
  const license = extract(archive, 'LICENSE');
  mkdirSync(dir, { recursive: true });
  writeAtomic(binaryPath, binary, 0o755);
  if (license) writeAtomic(join(dir, 'LICENSE'), license, 0o644);
  writeAtomic(stampPath, `${JSON.stringify({ version: LIVEKIT_VERSION, asset: pin.asset, assetSha256: pin.sha256, binarySha256: sha256(binary) }, null, 2)}\n`, 0o644);
  log(`Installed LiveKit ${LIVEKIT_VERSION} (${opts.target}) at ${binaryPath}`);
  return { path: binaryPath, downloaded };
}
