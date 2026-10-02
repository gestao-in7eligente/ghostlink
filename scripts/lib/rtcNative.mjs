// The native add-on of @livekit/rtc-node (the Ghost DJ's voice) for the VPS package (spec §10):
// apps/server/scripts/build.mjs bundles rtc-node's JavaScript and copies the platform packages npm
// installed into apps/server/dist/node_modules/@livekit/; the package must carry the Linux x64 and
// arm64 ones, so the ones the build machine lacks are fetched from the npm registry here, checked
// against the `integrity` (SHA-512) package-lock.json pins. Node built-ins only.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

/** The platforms install.sh supports (x86_64 and arm64 Linux, glibc). */
export const RTC_NATIVE_TARGETS = ['linux-x64-gnu', 'linux-arm64-gnu'];

/** @param {string} target */
export const rtcNativePackage = (target) => `@livekit/rtc-ffi-bindings-${target}`;

/** @param {string} repoRoot */
export const rtcNativeDir = (repoRoot) => join(repoRoot, 'apps', 'server', 'dist', 'node_modules', '@livekit');

/**
 * What package-lock.json pins for a package: its version, tarball URL and SHA-512 integrity.
 * @param {string} repoRoot
 * @param {string} name
 * @returns {{ version: string; resolved: string; integrity: string }}
 */
export function lockedPackage(repoRoot, name) {
  const lock = /** @type {{ packages?: Record<string, { version?: string; resolved?: string; integrity?: string }> }} */ (
    JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'))
  );
  const entry = lock.packages?.[`node_modules/${name}`];
  if (!entry?.version || !entry.resolved || !entry.integrity) throw new Error(`package-lock.json does not pin ${name}`);
  if (!entry.resolved.startsWith('https://registry.npmjs.org/')) throw new Error(`${name} does not come from the npm registry`);
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity)) throw new Error(`${name} has no SHA-512 integrity`);
  return { version: entry.version, resolved: entry.resolved, integrity: entry.integrity };
}

/**
 * The regular files of a tar archive (ustar / GNU, as npm packs them), by name.
 * @param {Buffer} tar
 * @returns {Map<string, Buffer>}
 */
export function untar(tar) {
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    /** @param {number} start @param {number} length */
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const prefix = field(345, 155);
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1);
    if (!Number.isFinite(size) || size < 0) throw new Error('corrupt tar header');
    const body = tar.subarray(offset + 512, offset + 512 + size);
    if (type === '0' || type === '') files.set(name, Buffer.from(body));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/**
 * Makes sure dist/node_modules/@livekit/ has every RTC_NATIVE_TARGETS package, fetching the
 * missing ones (only package.json and the .node file are kept). Returns the targets fetched.
 * @param {{ repoRoot: string; fetch?: typeof fetch; log?: (line: string) => void }} opts
 */
export async function ensureRtcNative({ repoRoot, fetch: get = globalThis.fetch, log = () => {} }) {
  const fetched = [];
  for (const target of RTC_NATIVE_TARGETS) {
    const name = rtcNativePackage(target);
    const dir = join(rtcNativeDir(repoRoot), name.slice('@livekit/'.length));
    const nodeFile = `rtc-node.${target}.node`;
    const locked = lockedPackage(repoRoot, name);
    if (existsSync(join(dir, nodeFile)) && existsSync(join(dir, 'package.json'))) {
      const have = /** @type {{ version?: string }} */ (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))).version;
      if (have === locked.version) continue;
    }
    log(`fetching ${name}@${locked.version}`);
    const res = await get(locked.resolved);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${name}`);
    const tgz = Buffer.from(await res.arrayBuffer());
    const digest = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;
    if (digest !== locked.integrity) throw new Error(`${name}: the download does not match package-lock.json's integrity`);
    const files = untar(gunzipSync(tgz));
    const manifest = files.get('package/package.json');
    const binary = files.get(`package/${nodeFile}`);
    if (!manifest || !binary) throw new Error(`${name} has no ${nodeFile}`);
    if (/** @type {{ version?: string }} */ (JSON.parse(manifest.toString('utf8'))).version !== locked.version) throw new Error(`${name} is not version ${locked.version}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), manifest);
    writeFileSync(join(dir, nodeFile), binary);
    fetched.push(target);
  }
  return fetched;
}

/**
 * The files of the shipped native packages, for the server package: `dist/node_modules/@livekit/<pkg>/…`.
 * Throws when one of RTC_NATIVE_TARGETS is missing.
 * @param {string} repoRoot
 * @returns {{ name: string; path: string }[]}
 */
export function rtcNativeFiles(repoRoot) {
  const out = [];
  for (const target of RTC_NATIVE_TARGETS) {
    const pkg = rtcNativePackage(target).slice('@livekit/'.length);
    const dir = join(rtcNativeDir(repoRoot), pkg);
    const nodeFile = `rtc-node.${target}.node`;
    const present = existsSync(dir) ? readdirSync(dir) : [];
    if (!present.includes('package.json') || !present.includes(nodeFile)) {
      throw new Error(`apps/server/dist/node_modules/@livekit/${pkg} is missing: run "node scripts/pack-server.mjs", which fetches it`);
    }
    for (const file of ['package.json', nodeFile]) out.push({ name: `dist/node_modules/@livekit/${pkg}/${file}`, path: join(dir, file) });
  }
  return out;
}
