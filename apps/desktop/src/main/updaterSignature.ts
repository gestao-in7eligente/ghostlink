// Ed25519 check of a downloaded Windows update (spec §15). electron-updater alone only compares
// the installer with the SHA-512 in latest.yml, which comes from the same release: whoever can
// publish a release could ship anything. This check also requires the detached signature
// `<installer>.ed25519` made by the release key, whose private half never leaves the `release`
// GitHub Environment, so a compromised account or CI run without that key cannot push an update.
import { createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  RELEASE_PUBLIC_KEY,
  RELEASE_SIGNATURE_BYTES,
  RELEASE_SIGNATURE_SUFFIX,
  ed25519SpkiDer,
  fromBase64Url,
  isReleaseVersion,
  releaseDownloadUrl,
  windowsInstallerName,
} from '@ghostlink/shared';

export type SignatureFetcher = (url: string) => Promise<Uint8Array>;

export interface InstallerVerifierDeps {
  fetchSignature: SignatureFetcher;
  /** Raw base64url Ed25519 key; RELEASE_PUBLIC_KEY unless a test passes its own. */
  publicKey?: string;
  readFile?: (path: string) => Promise<Uint8Array>;
}

/** Where the signature of a version's installer is published: the same tagged release. */
export function installerSignatureUrl(version: string): string {
  return releaseDownloadUrl(version, `${windowsInstallerName(version)}${RELEASE_SIGNATURE_SUFFIX}`);
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

/**
 * Checks the downloaded installer of `version`. Resolves null when the release key signed it,
 * otherwise a short reason (electron-updater's verifyUpdateCodeSignature contract: it then
 * deletes the file, emits ERR_UPDATER_INVALID_SIGNATURE and installs nothing). Never throws.
 */
export async function verifyInstaller(path: string, version: string | null, deps: InstallerVerifierDeps): Promise<string | null> {
  if (!isReleaseVersion(version)) return 'refused: unknown or non-stable update version';
  let signature: Uint8Array;
  try {
    signature = await deps.fetchSignature(installerSignatureUrl(version));
  } catch (e) {
    return `Ed25519 signature unavailable: ${e instanceof Error ? e.message : 'download failed'}`;
  }
  let data: Uint8Array;
  try {
    data = await (deps.readFile ?? readFile)(path);
  } catch {
    return 'the downloaded installer could not be read';
  }
  return verifyDetachedSignature(data, signature, deps.publicKey ?? RELEASE_PUBLIC_KEY)
    ? null
    : 'Ed25519 signature does not match the GhostLink release key';
}

/**
 * The function for `autoUpdater.verifyUpdateCodeSignature`. Authenticode publisher names are
 * ignored (the installers are not code-signed); the version comes from the `update-available`
 * event, so a download that was never announced fails closed.
 */
export function createInstallerVerifier(
  currentVersion: () => string | null,
  deps: InstallerVerifierDeps,
): (publisherNames: string[], path: string) => Promise<string | null> {
  return (_publisherNames, path) => verifyInstaller(path, currentVersion(), deps);
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Downloads a detached signature: HTTPS only (redirects included), at most a few bytes read,
 * bounded in time. `fetchImpl` is Electron's net.fetch in the app (system proxy settings).
 */
export function createSignatureFetcher(fetchImpl: FetchLike, timeoutMs = 30_000): SignatureFetcher {
  return async (url) => {
    if (!url.startsWith('https://')) throw new Error('signatures are only fetched over https');
    const response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
    if (response.url !== '' && !response.url.startsWith('https://')) throw new Error('signature redirected away from https');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('empty response');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > RELEASE_SIGNATURE_BYTES) {
        await reader.cancel();
        throw new Error('signature file too large');
      }
      chunks.push(value);
    }
    const signature = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      signature.set(chunk, offset);
      offset += chunk.length;
    }
    return signature;
  };
}
