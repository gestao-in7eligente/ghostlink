// Building blocks of the release pipeline (spec §15): the tag check, the VPS server package,
// checksums-sha256.txt and the check of a signed release before it is published. Node built-ins
// only, no top-level side effects (scripts/test covers them).
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { SIGNATURE_SUFFIX, publicKeyFromRaw, verifyBytes } from './releaseKey.mjs';
import { rtcNativeFiles } from './rtcNative.mjs';

export const CHECKSUMS_FILE = 'checksums-sha256.txt';
/** Stable versions only (no leading zeros); pre-release tags are not published by release.yml. */
const VERSION = /^(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})$/;
// The bots' package too: its .tgz is named after its own version (release.yml, compat job).
const PACKAGE_JSONS = ['package.json', 'apps/desktop/package.json', 'apps/server/package.json', 'packages/shared/package.json', 'packages/discord-compat/package.json'];

/**
 * The version a release tag publishes. The tag must be `v<X.Y.Z>`, every workspace package.json
 * must carry that version, and release-notes/<X.Y.Z>.md must exist.
 * @param {string} tag e.g. GITHUB_REF_NAME
 * @param {string} repoRoot
 */
export function releaseVersionFromTag(tag, repoRoot) {
  const version = tag.startsWith('v') ? tag.slice(1) : '';
  if (!VERSION.test(version)) throw new Error(`"${tag}" is not a release tag (expected v<major>.<minor>.<patch>)`);
  for (const file of PACKAGE_JSONS) {
    const found = /** @type {{ version?: string }} */ (JSON.parse(readFileSync(join(repoRoot, file), 'utf8'))).version;
    if (found !== version) throw new Error(`${file} has version ${found}, but the tag is ${tag}`);
  }
  if (!existsSync(join(repoRoot, 'release-notes', `${version}.md`))) throw new Error(`release-notes/${version}.md is missing`);
  return version;
}

/** @param {string} path */
export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * `sha256sum` format ("<hex>  <name>"), sorted by name, for every file in `dir` except the
 * checksum file itself, its signatures and the Sigstore bundle (made after it).
 * Verify with `sha256sum --ignore-missing -c checksums-sha256.txt`.
 * @param {string} dir
 * @returns {Promise<string>}
 */
export async function checksumsFor(dir) {
  const names = readdirSync(dir)
    .filter((name) => !name.startsWith(CHECKSUMS_FILE) && statSync(join(dir, name)).isFile())
    .sort();
  if (names.length === 0) throw new Error(`no files to checksum in ${dir}`);
  let out = '';
  for (const name of names) {
    if (/[\r\n\\]/.test(name)) throw new Error(`unsupported file name ${JSON.stringify(name)}`);
    out += `${await sha256File(join(dir, name))}  ${name}\n`;
  }
  return out;
}

/**
 * @param {string} text
 * @returns {Map<string, string>} file name → sha256 hex
 */
export function parseChecksums(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!match) throw new Error(`malformed checksum line: ${line}`);
    map.set(match[2], match[1]);
  }
  return map;
}

/**
 * @param {string} dir
 * @param {string} name
 */
function readReleaseFile(dir, name) {
  try {
    return readFileSync(join(dir, name));
  } catch {
    throw new Error(`${name} is missing`);
  }
}

/**
 * Checks a signed release directory the way clients will, so a release they would refuse is never
 * published (the app refuses any update whose installer is not listed, under its versioned name, in
 * a checksums-sha256.txt signed by the release key; install.sh does the same for the server package):
 *   - checksums-sha256.txt.ed25519 is a valid signature of checksums-sha256.txt by `publicKey`;
 *   - checksums-sha256.txt is byte for byte what checksumsFor(dir) writes (every file, current hashes);
 *   - GhostLink-Setup-<version>.exe and ghostlink-server-<version>.tgz exist, are listed, and carry a
 *     valid <file>.ed25519.
 * @param {string} dir
 * @param {string} version
 * @param {string} publicKey raw base64url (RELEASE_PUBLIC_KEY)
 * @returns {Promise<string[]>} the files clients look up
 */
export async function verifyReleaseDir(dir, version, publicKey) {
  if (!VERSION.test(version)) throw new Error(`"${version}" is not a release version`);
  const key = publicKeyFromRaw(publicKey);
  const checksums = readReleaseFile(dir, CHECKSUMS_FILE);
  if (!verifyBytes(checksums, readReleaseFile(dir, `${CHECKSUMS_FILE}${SIGNATURE_SUFFIX}`), key)) {
    throw new Error(`${CHECKSUMS_FILE}${SIGNATURE_SUFFIX} is not a valid signature by the release key`);
  }
  const text = checksums.toString('utf8');
  if (text !== (await checksumsFor(dir))) throw new Error(`${CHECKSUMS_FILE} does not list exactly the files in ${dir} with their current hashes`);
  const required = [`GhostLink-Setup-${version}.exe`, `ghostlink-server-${version}.tgz`];
  for (const name of required) {
    const data = readReleaseFile(dir, name);
    if (!text.split('\n').includes(`${createHash('sha256').update(data).digest('hex')}  ${name}`)) {
      throw new Error(`${CHECKSUMS_FILE} has no line for ${name}`);
    }
    if (!verifyBytes(data, readReleaseFile(dir, `${name}${SIGNATURE_SUFFIX}`), key)) {
      throw new Error(`${name}${SIGNATURE_SUFFIX} is not a valid signature by the release key`);
    }
  }
  return required;
}

/**
 * @typedef {{ name: string; mode: number; data?: Uint8Array }} TarEntry
 * A directory when `data` is absent. Names use '/' and stay under 100 bytes.
 */

/**
 * @param {Buffer} header
 * @param {number} offset
 * @param {number} length
 * @param {number} value
 */
function octal(header, offset, length, value) {
  header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
}

/**
 * A POSIX ustar archive, gzipped. Deterministic: fixed owner (0/root), given mtime, entries
 * in the given order. Written here so the package is identical on every build machine.
 * @param {TarEntry[]} entries
 * @param {number} mtime seconds since the epoch
 */
export function tarGz(entries, mtime) {
  /** @type {Buffer[]} */
  const blocks = [];
  for (const entry of entries) {
    const directory = entry.data === undefined;
    const name = directory && !entry.name.endsWith('/') ? `${entry.name}/` : entry.name;
    if (Buffer.byteLength(name) > 100 || name.startsWith('/') || name.split('/').includes('..')) {
      throw new Error(`unsupported tar entry name ${name}`);
    }
    const size = directory ? 0 : /** @type {Uint8Array} */ (entry.data).length;
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    octal(header, 100, 8, entry.mode);
    octal(header, 108, 8, 0);
    octal(header, 116, 8, 0);
    octal(header, 124, 12, size);
    octal(header, 136, 12, mtime);
    header.fill(' ', 148, 156);
    header.write(directory ? '5' : '0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    header.write('root', 265, 32, 'ascii');
    header.write('root', 297, 32, 'ascii');
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(header);
    if (!directory) {
      const data = Buffer.from(/** @type {Uint8Array} */ (entry.data));
      blocks.push(data, Buffer.alloc((512 - (size % 512)) % 512));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

const OPTIONAL_BUNDLE_EXTERNALS = new Set(['bufferutil', 'utf-8-validate']); // ws probes them inside try/catch
// rtc-node's napi loader probes every platform's package inside try/catch; the package ships the Linux ones (rtcNative.mjs).
const NATIVE_BUNDLE_EXTERNAL = /^@livekit\/rtc-ffi-bindings-[a-z0-9-]+(?:\/package\.json)?$/;

/**
 * Bare modules the bundled CLI loads that the package would have to ship. The VPS package has
 * no node_modules, so anything but Node built-ins and ws's optional add-ons is an error.
 * @param {string} bundle source of dist/cli.js
 */
export function unshippedImports(bundle) {
  const builtins = new Set(builtinModules);
  const found = new Set();
  const patterns = [
    /^\s*(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']/gm, // static import/export … from "x" (one line, as esbuild writes them)
    /^\s*import\s*["']([^"']+)["']/gm, // import "x"
    /(?<![\w$.])import\s*\(\s*["']([^"']+)["']\s*\)/g, // import("x")
    /(?<![\w$.])(?:__)?require\s*\(\s*["']([^"']+)["']\s*\)/g, // require("x") / esbuild's __require("x")
  ];
  for (const pattern of patterns) {
    for (const match of bundle.matchAll(pattern)) {
      const specifier = /** @type {string} */ (match[1]);
      if (specifier.startsWith('node:') || specifier.startsWith('.') || builtins.has(specifier)) continue;
      if (!OPTIONAL_BUNDLE_EXTERNALS.has(specifier) && !NATIVE_BUNDLE_EXTERNAL.test(specifier)) found.add(specifier);
    }
  }
  return [...found].sort();
}

/**
 * Entries of ghostlink-server-<version>.tgz (spec §10, §15), extracted as-is into /opt/ghostlink:
 * dist/cli.js (single esbuild bundle), dist/migrations/, the Linux x64 and arm64 native add-ons of
 * @livekit/rtc-node in dist/node_modules/ (the Ghost DJ's voice; rtcNative.mjs), package.json,
 * install.sh and LICENSE. Nothing else needs installing, so package.json lists no dependencies.
 * @param {{ repoRoot: string; installSh?: string }} opts `installSh` defaults to scripts/install.sh
 * @returns {{ version: string; entries: TarEntry[] }}
 */
export function serverPackageEntries({ repoRoot, installSh = join(repoRoot, 'scripts', 'install.sh') }) {
  const serverDir = join(repoRoot, 'apps', 'server');
  const serverPkg = /** @type {{ version: string; license: string; engines?: Record<string, string> }} */ (
    JSON.parse(readFileSync(join(serverDir, 'package.json'), 'utf8'))
  );
  const cli = join(serverDir, 'dist', 'cli.js');
  if (!existsSync(cli)) throw new Error('apps/server/dist/cli.js is missing: run "npm run build -w @ghostlink/server" first');
  const bundle = readFileSync(cli);
  const unshipped = unshippedImports(bundle.toString('utf8'));
  if (unshipped.length > 0) throw new Error(`dist/cli.js loads packages the server package does not ship: ${unshipped.join(', ')}`);
  if (!existsSync(installSh)) throw new Error(`${installSh} is missing`);
  const rootPkg = /** @type {{ engines?: Record<string, string> }} */ (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')));

  const manifest = {
    name: 'ghostlink-server',
    version: serverPkg.version,
    description: 'GhostLink server (self-hosted, VPS). Installed by install.sh.',
    license: serverPkg.license,
    private: true,
    type: 'module',
    bin: { 'ghostlink-server': 'dist/cli.js' },
    engines: { node: rootPkg.engines?.node ?? '>=24.14' },
    dependencies: {},
  };
  const native = rtcNativeFiles(repoRoot);
  /** @type {TarEntry[]} */
  const nativeEntries = [{ name: 'dist/node_modules', mode: 0o755 }, { name: 'dist/node_modules/@livekit', mode: 0o755 }];
  for (const file of native) {
    const dir = file.name.slice(0, file.name.lastIndexOf('/'));
    if (!nativeEntries.some((e) => e.name === dir)) nativeEntries.push({ name: dir, mode: 0o755 });
    nativeEntries.push({ name: file.name, mode: 0o644, data: readFileSync(file.path) });
  }
  const migrationsDir = join(serverDir, 'dist', 'migrations');
  const migrations = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
  if (migrations.length === 0) throw new Error('apps/server/dist/migrations has no .sql file');
  /** @type {TarEntry[]} */
  const entries = [
    { name: 'dist', mode: 0o755 },
    { name: 'dist/cli.js', mode: 0o755, data: bundle },
    { name: 'dist/migrations', mode: 0o755 },
    ...migrations.map((name) => ({ name: `dist/migrations/${name}`, mode: 0o644, data: readFileSync(join(migrationsDir, name)) })),
    ...nativeEntries,
    { name: 'package.json', mode: 0o644, data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
    { name: 'install.sh', mode: 0o755, data: readFileSync(installSh) },
    { name: 'LICENSE', mode: 0o644, data: readFileSync(join(repoRoot, 'LICENSE')) },
  ];
  return { version: serverPkg.version, entries };
}
