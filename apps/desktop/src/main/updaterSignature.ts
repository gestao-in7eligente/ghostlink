// Release-key check of a downloaded Windows update (spec §15). electron-updater alone only compares
// the installer with the SHA-512 in latest.yml, which comes from the same release: whoever can edit
// a release could ship anything. Before an update may install, this module requires, all from the
// `v<version>` release and all signed by the release key (its private half never leaves the
// `release` GitHub Environment):
//   1. the version is a stable release strictly newer than the running app (no downgrade);
//   2. `<installer>.ed25519`, a detached signature over the installer bytes;
//   3. `checksums-sha256.txt` with a valid `checksums-sha256.txt.ed25519`, containing exactly the
//      line `<sha256 of the download>  GhostLink-Setup-<version>.exe`.
// (2) alone does not say WHICH installer was signed: someone who can edit release assets, without
// the key, could put an older installer and its genuine signature under the newest version and
// roll every client back to it. (3) binds the bytes to the file name, and the name to the version.
// (2) stays as a second, independent check of the same key over the installer itself.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  RELEASE_CHECKSUMS_FILE,
  RELEASE_CHECKSUMS_MAX_BYTES,
  RELEASE_PUBLIC_KEY,
  RELEASE_SIGNATURE_BYTES,
  RELEASE_SIGNATURE_SUFFIX,
  compareReleaseVersions,
  ed25519SpkiDer,
  fromBase64Url,
  isReleaseVersion,
  releaseDownloadUrl,
  windowsInstallerName,
} from '@ghostlink/shared';

/** Downloads one small release file, refusing anything larger than `maxBytes`. */
export type ReleaseFileFetcher = (url: string, maxBytes: number) => Promise<Uint8Array>;

export interface InstallerVerifierDeps {
  fetchReleaseFile: ReleaseFileFetcher;
  /** The version of the running app: only a strictly newer release may install. */
  runningVersion: string;
  /** Raw base64url Ed25519 key; RELEASE_PUBLIC_KEY unless a test passes its own. */
  publicKey?: string;
  readFile?: (path: string) => Promise<Uint8Array>;
}

/** Where the signature of a version's installer is published: the same tagged release. */
export function installerSignatureUrl(version: string): string {
  return releaseDownloadUrl(version, `${windowsInstallerName(version)}${RELEASE_SIGNATURE_SUFFIX}`);
}

/** The signed checksums of a version: the same tagged release. */
export function checksumsUrl(version: string): string {
  return releaseDownloadUrl(version, RELEASE_CHECKSUMS_FILE);
}

export function checksumsSignatureUrl(version: string): string {
  return releaseDownloadUrl(version, `${RELEASE_CHECKSUMS_FILE}${RELEASE_SIGNATURE_SUFFIX}`);
}

/** True only for a 64-byte Ed25519 signature of exactly `data` by `publicKey`. Never throws. */
export function verifyDetachedSignature(data: Uint8Array, signature: Uint8Array, publicKey: string): boolean {
  if (!(signature instanceof Uint8Array) || signature.length !== RELEASE_SIGNATURE_BYTES) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(ed25519SpkiDer(fromBase64Url(publicKey))), format: 'der', type: 'spki' });
    return verify(null, data, key, signature);
  } catch {
    return false;
  }
}

const CHECKSUM_LINE = /^([0-9a-f]{64}) {2}([^\r\n]+)$/;

/**
 * checksums-sha256.txt exactly as scripts/checksums.mjs writes it: UTF-8, one
 * "<64 lower-case hex>  <name>" line per file, each ending in \n, no name twice.
 * File name → SHA-256 hex, or null when anything deviates.
 */
export function parseChecksums(bytes: Uint8Array): Map<string, string> | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
  if (!text.endsWith('\n')) return null;
  const sums = new Map<string, string>();
  for (const line of text.slice(0, -1).split('\n')) {
    const match = CHECKSUM_LINE.exec(line);
    if (!match || sums.has(match[2]!)) return null;
    sums.set(match[2]!, match[1]!);
  }
  return sums;
}

class Refused extends Error {}

async function download(deps: InstallerVerifierDeps, url: string, maxBytes: number, what: string): Promise<Uint8Array> {
  let body: unknown;
  try {
    body = await deps.fetchReleaseFile(url, maxBytes);
  } catch (e) {
    throw new Refused(`${what} unavailable: ${e instanceof Error ? e.message : 'download failed'}`);
  }
  if (!(body instanceof Uint8Array)) throw new Refused(`${what} unavailable: not a file`);
  return body;
}

async function check(path: string, version: string | null, deps: InstallerVerifierDeps): Promise<void> {
  if (!isReleaseVersion(version)) throw new Refused('refused: unknown or non-stable update version');
  if (!isReleaseVersion(deps.runningVersion)) throw new Refused('refused: the running app has no stable release version');
  if (compareReleaseVersions(version, deps.runningVersion) <= 0) {
    throw new Refused(`refused: ${version} is not newer than the running version ${deps.runningVersion}`);
  }
  const name = windowsInstallerName(version);
  const [signature, checksums, checksumsSignature] = await Promise.all([
    download(deps, installerSignatureUrl(version), RELEASE_SIGNATURE_BYTES, 'Ed25519 signature of the installer'),
    download(deps, checksumsUrl(version), RELEASE_CHECKSUMS_MAX_BYTES, RELEASE_CHECKSUMS_FILE),
    download(deps, checksumsSignatureUrl(version), RELEASE_SIGNATURE_BYTES, `Ed25519 signature of ${RELEASE_CHECKSUMS_FILE}`),
  ]);
  let data: Uint8Array;
  try {
    data = await (deps.readFile ?? readFile)(path);
  } catch {
    throw new Refused('the downloaded installer could not be read');
  }
  const publicKey = deps.publicKey ?? RELEASE_PUBLIC_KEY;
  if (!verifyDetachedSignature(data, signature, publicKey)) {
    throw new Refused('Ed25519 signature does not match the GhostLink release key');
  }
  if (!verifyDetachedSignature(checksums, checksumsSignature, publicKey)) {
    throw new Refused(`${RELEASE_CHECKSUMS_FILE}: its Ed25519 signature does not match the GhostLink release key`);
  }
  const expected = parseChecksums(checksums);
  if (expected === null) throw new Refused(`${RELEASE_CHECKSUMS_FILE} is malformed`);
  const sha256 = expected.get(name);
  if (sha256 === undefined) throw new Refused(`${RELEASE_CHECKSUMS_FILE} does not list ${name}`);
  if (createHash('sha256').update(data).digest('hex') !== sha256) {
    throw new Refused(`${name} does not match its SHA-256 in ${RELEASE_CHECKSUMS_FILE}`);
  }
}

/**
 * Checks the downloaded installer of `version` (see the top of this file). Resolves null when it
 * may install, otherwise a short reason (electron-updater's verifyUpdateCodeSignature contract:
 * it then deletes the file, emits ERR_UPDATER_INVALID_SIGNATURE and installs nothing). Never throws.
 */
export async function verifyInstaller(path: string, version: string | null, deps: InstallerVerifierDeps): Promise<string | null> {
  try {
    await check(path, version, deps);
    return null;
  } catch (e) {
    return e instanceof Refused ? e.message : 'the update could not be verified';
  }
}

/**
 * The function for `autoUpdater.verifyUpdateCodeSignature`. Authenticode publisher names are
 * ignored (the installers are not code-signed); the version comes from the `update-available`
 * event, so a download that was never announced fails closed.
 */
export function createInstallerVerifier(
  pendingVersion: () => string | null,
  deps: InstallerVerifierDeps,
): (publisherNames: string[], path: string) => Promise<string | null> {
  return (_publisherNames, path) => verifyInstaller(path, pendingVersion(), deps);
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Downloads a small release file (a signature or the checksums): HTTPS only (redirects included),
 * at most `maxBytes` read, bounded in time. `fetchImpl` is Electron's net.fetch in the app
 * (system proxy settings).
 */
export function createReleaseFileFetcher(fetchImpl: FetchLike, timeoutMs = 30_000): ReleaseFileFetcher {
  return async (url, maxBytes) => {
    if (!url.startsWith('https://')) throw new Error('release files are only fetched over https');
    const response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
    if (response.url !== '' && !response.url.startsWith('https://')) throw new Error('release file redirected away from https');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('empty response');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error('release file too large');
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
  };
}
