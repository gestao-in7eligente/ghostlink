// Release channel (spec §15): where releases live and the key that signs them. Pure data and
// string helpers, so the main process, the renderer and the build scripts share one definition.
import { fromBase64Url } from './encoding.js';

/** The public repository whose GitHub Releases feed the updater, the site and install.sh. */
export const RELEASE_REPO = { owner: 'gestao-in7eligente', repo: 'ghostlink' } as const;

/**
 * Raw 32-byte Ed25519 release public key, base64url (spec §15). Every installer and server
 * package is signed by its private half, which exists only in the `release` GitHub Environment
 * (required reviewer, v* tags only). The Windows updater refuses any installer it did not sign.
 * Rotating it: scripts/gen-release-key.mjs, then update this constant and scripts/install.sh.
 */
export const RELEASE_PUBLIC_KEY = 'Hhib591tl4P4Nf9us1fB5FCXXbGOZDBHwvWIu-2FWnc';

/** A detached signature `<file>.ed25519` is the raw 64-byte Ed25519 signature over the file's bytes. */
export const RELEASE_SIGNATURE_SUFFIX = '.ed25519';
export const RELEASE_SIGNATURE_BYTES = 64;

/**
 * `sha256sum` lines ("<hex>  <name>\n") for every file of a release, signed like any file
 * (`checksums-sha256.txt.ed25519`). A detached signature only proves that the release key signed
 * some bytes; the signed checksums bind those bytes to a file name, and the names carry the version.
 */
export const RELEASE_CHECKSUMS_FILE = 'checksums-sha256.txt';
/** Download bound for it: a release lists about a dozen files, one short line each. */
export const RELEASE_CHECKSUMS_MAX_BYTES = 64 * 1024;

const GITHUB = `https://github.com/${RELEASE_REPO.owner}/${RELEASE_REPO.repo}`;
export const RELEASES_PAGE_URL = `${GITHUB}/releases`;
export const LATEST_RELEASE_API_URL = `https://api.github.com/repos/${RELEASE_REPO.owner}/${RELEASE_REPO.repo}/releases/latest`;
/** The VitePress site (GitHub Pages project site, spec §16). */
export const SITE_URL = `https://${RELEASE_REPO.owner}.github.io/${RELEASE_REPO.repo}/`;

// Stable versions only: the updater runs with allowPrerelease = false, so a suffixed tag
// (v0.3.0-rc.1) must never be accepted as an update either. Bounded, no leading zeros.
const RELEASE_VERSION = /^(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})$/;
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isReleaseVersion(v: unknown): v is string {
  return typeof v === 'string' && RELEASE_VERSION.test(v);
}

function checkVersion(version: string): string {
  if (!isReleaseVersion(version)) throw new Error('not a stable release version');
  return version;
}

/** Numeric order of two stable release versions: negative when a is older, 0 when equal, positive when newer. */
export function compareReleaseVersions(a: string, b: string): number {
  const x = checkVersion(a).split('.').map(Number);
  const y = checkVersion(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = x[i]! - y[i]!;
    if (d !== 0) return d;
  }
  return 0;
}

/** The NSIS installer electron-builder produces (`nsis.artifactName`). */
export function windowsInstallerName(version: string): string {
  return `GhostLink-Setup-${checkVersion(version)}.exe`;
}

/** The VPS package release.yml produces. */
export function serverPackageName(version: string): string {
  return `ghostlink-server-${checkVersion(version)}.tgz`;
}

/** `https://github.com/<owner>/<repo>/releases/download/v<version>/<file>`: one asset of one tagged release. */
export function releaseDownloadUrl(version: string, fileName: string): string {
  if (!ASSET_NAME.test(fileName) || fileName.includes('..')) throw new Error('invalid release asset name');
  return `${GITHUB}/releases/download/v${checkVersion(version)}/${fileName}`;
}

/** The release page of one version (where macOS/manual installs and release notes live). */
export function releaseTagUrl(version: string): string {
  return `${GITHUB}/releases/tag/v${checkVersion(version)}`;
}

/** RFC 8410 SubjectPublicKeyInfo header for Ed25519; the raw 32-byte key follows it. */
const ED25519_SPKI_PREFIX = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];

/** SPKI DER of a raw Ed25519 public key, e.g. for `createPublicKey({ format: 'der', type: 'spki' })`. */
export function ed25519SpkiDer(raw: Uint8Array): Uint8Array {
  if (raw.length !== 32) throw new Error('an Ed25519 public key is 32 bytes');
  const der = new Uint8Array(ED25519_SPKI_PREFIX.length + 32);
  der.set(ED25519_SPKI_PREFIX);
  der.set(raw, ED25519_SPKI_PREFIX.length);
  return der;
}

/** RELEASE_PUBLIC_KEY decoded (strict base64url, exactly 32 bytes). */
export function releasePublicKeyBytes(): Uint8Array {
  const raw = fromBase64Url(RELEASE_PUBLIC_KEY);
  if (raw.length !== 32) throw new Error('RELEASE_PUBLIC_KEY must be 32 bytes');
  return raw;
}
