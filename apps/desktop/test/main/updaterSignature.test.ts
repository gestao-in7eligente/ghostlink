import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RELEASE_CHECKSUMS_MAX_BYTES, RELEASE_PUBLIC_KEY, RELEASE_SIGNATURE_BYTES } from '@ghostlink/shared';
import {
  checksumsSignatureUrl,
  checksumsUrl,
  createInstallerVerifier,
  createReleaseFileFetcher,
  installerSignatureUrl,
  parseChecksums,
  verifyDetachedSignature,
  verifyInstaller,
  type InstallerVerifierDeps,
  type ReleaseFileFetcher,
} from '../../src/main/updaterSignature.js';
import { useTempDir } from '../helpers/tempDir.js';

const dir = useTempDir('ghostlink-updater-');

function keyPair(): { publicKey: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return { publicKey: der.subarray(12).toString('base64url'), privateKey };
}

const release = keyPair();
/** The app that is running: 0.1.1. The latest release is 0.2.0; 0.1.0 is an older, genuine one. */
const RUNNING = '0.1.1';
const VERSION = '0.2.0';
const OLD = '0.1.0';
const INSTALLER = Buffer.from('MZ… pretend this is GhostLink-Setup-0.2.0.exe');
const OLD_INSTALLER = Buffer.from('MZ… pretend this is GhostLink-Setup-0.1.0.exe, with a known vulnerability');
const DOWNLOAD = 'https://github.com/gestao-in7eligente/ghostlink/releases/download';
const url = (version: string, file: string) => `${DOWNLOAD}/v${version}/${file}`;
const installerName = (version: string) => `GhostLink-Setup-${version}.exe`;
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

type Assets = Map<string, Uint8Array>;

/** The files of one release as release.yml publishes them (only those the verifier reads, plus a neighbour). */
function publishedRelease(version: string, installer: Uint8Array, key: KeyObject = release.privateKey): Assets {
  const exe = installerName(version);
  const tgz = Buffer.from(`pretend this is ghostlink-server-${version}.tgz`);
  const checksums = Buffer.from(
    [`${sha256(installer)}  ${exe}`, `${sha256(sign(null, installer, key))}  ${exe}.ed25519`, `${sha256(tgz)}  ghostlink-server-${version}.tgz`]
      .sort((a, b) => a.slice(66).localeCompare(b.slice(66)))
      .map((line) => `${line}\n`)
      .join(''),
  );
  return new Map([
    [url(version, exe), installer],
    [url(version, `${exe}.ed25519`), sign(null, installer, key)],
    [url(version, 'checksums-sha256.txt'), checksums],
    [url(version, 'checksums-sha256.txt.ed25519'), sign(null, checksums, key)],
  ]);
}

/** Serves the given release assets; anything else is a 404. */
function serving(...releases: Assets[]): ReleaseFileFetcher & ReturnType<typeof vi.fn> {
  const assets: Assets = new Map(releases.flatMap((r) => [...r]));
  return vi.fn(async (asset: string, maxBytes: number) => {
    const body = assets.get(asset);
    if (body === undefined) throw new Error(`HTTP 404 for ${asset}`);
    if (body.length > maxBytes) throw new Error('release file too large');
    return body;
  });
}

/** Replaces some assets of a release, as someone who can edit release assets but lacks the key could. */
function edited(assets: Assets, changes: Record<string, Uint8Array>): Assets {
  const copy = new Map(assets);
  for (const [asset, body] of Object.entries(changes)) copy.set(asset, body);
  return copy;
}

/** A checksums file signed by `key` (the release key unless an attacker's is given). */
function signedChecksums(version: string, text: string, key: KeyObject = release.privateKey): Record<string, Uint8Array> {
  const body = Buffer.from(text);
  return { [url(version, 'checksums-sha256.txt')]: body, [url(version, 'checksums-sha256.txt.ed25519')]: sign(null, body, key) };
}

/** The installer as electron-updater leaves it before verification (a temp name in its cache dir). */
function downloadedInstaller(bytes: Uint8Array = INSTALLER): string {
  const path = join(dir.path, `temp-${installerName(VERSION)}`);
  writeFileSync(path, bytes);
  return path;
}

const latest = publishedRelease(VERSION, INSTALLER);
const older = publishedRelease(OLD, OLD_INSTALLER);

const deps = (fetchReleaseFile: ReleaseFileFetcher, runningVersion = RUNNING): InstallerVerifierDeps => ({
  fetchReleaseFile,
  runningVersion,
  publicKey: release.publicKey,
});

describe('verifyInstaller (spec §15: release-key signatures bound to the version and the file name)', () => {
  it('accepts the installer of a newer release, signed and listed in its signed checksums (null = valid)', async () => {
    const fetchReleaseFile = serving(latest);
    await expect(verifyInstaller(downloadedInstaller(), VERSION, deps(fetchReleaseFile))).resolves.toBeNull();
    expect(fetchReleaseFile).toHaveBeenCalledWith(url(VERSION, 'GhostLink-Setup-0.2.0.exe.ed25519'), RELEASE_SIGNATURE_BYTES);
    expect(fetchReleaseFile).toHaveBeenCalledWith(url(VERSION, 'checksums-sha256.txt'), RELEASE_CHECKSUMS_MAX_BYTES);
    expect(fetchReleaseFile).toHaveBeenCalledWith(url(VERSION, 'checksums-sha256.txt.ed25519'), RELEASE_SIGNATURE_BYTES);
  });

  describe('rollback: an older, genuinely signed installer served as the newer version', () => {
    const swapped = {
      [url(VERSION, 'GhostLink-Setup-0.2.0.exe')]: OLD_INSTALLER,
      [url(VERSION, 'GhostLink-Setup-0.2.0.exe.ed25519')]: older.get(url(OLD, 'GhostLink-Setup-0.1.0.exe.ed25519'))!,
    };

    it('the per-file signature alone would accept it (the attack this check closes)', () => {
      expect(verifyDetachedSignature(OLD_INSTALLER, swapped[url(VERSION, 'GhostLink-Setup-0.2.0.exe.ed25519')]!, release.publicKey)).toBe(true);
    });

    it('is rejected when the release still carries its own signed checksums (hash mismatch)', async () => {
      const fetchReleaseFile = serving(edited(latest, swapped));
      await expect(verifyInstaller(downloadedInstaller(OLD_INSTALLER), VERSION, deps(fetchReleaseFile))).resolves.toMatch(/SHA-256/);
    });

    it('is rejected when the older release\'s signed checksums are copied too (no line for this version)', async () => {
      const fetchReleaseFile = serving(
        edited(latest, {
          ...swapped,
          [url(VERSION, 'checksums-sha256.txt')]: older.get(url(OLD, 'checksums-sha256.txt'))!,
          [url(VERSION, 'checksums-sha256.txt.ed25519')]: older.get(url(OLD, 'checksums-sha256.txt.ed25519'))!,
        }),
      );
      await expect(verifyInstaller(downloadedInstaller(OLD_INSTALLER), VERSION, deps(fetchReleaseFile))).resolves.toMatch(
        /does not list GhostLink-Setup-0\.2\.0\.exe/,
      );
    });

    it('is rejected when the older installer is announced under its own version, without downloading anything', async () => {
      const fetchReleaseFile = serving(older);
      await expect(verifyInstaller(downloadedInstaller(OLD_INSTALLER), OLD, deps(fetchReleaseFile))).resolves.toMatch(/not newer/);
      expect(fetchReleaseFile).not.toHaveBeenCalled();
    });

    it('rejects a reinstall of the running version (not strictly newer)', async () => {
      const fetchReleaseFile = serving(latest);
      await expect(verifyInstaller(downloadedInstaller(), VERSION, deps(fetchReleaseFile, VERSION))).resolves.toMatch(/not newer/);
      expect(fetchReleaseFile).not.toHaveBeenCalled();
    });
  });

  it('rejects a checksums file signed by another key, even with the right line', async () => {
    const attacker = keyPair();
    const forged = signedChecksums(VERSION, `${sha256(OLD_INSTALLER)}  GhostLink-Setup-0.2.0.exe\n`, attacker.privateKey);
    const fetchReleaseFile = serving(
      edited(latest, {
        [url(VERSION, 'GhostLink-Setup-0.2.0.exe.ed25519')]: older.get(url(OLD, 'GhostLink-Setup-0.1.0.exe.ed25519'))!,
        ...forged,
      }),
    );
    await expect(verifyInstaller(downloadedInstaller(OLD_INSTALLER), VERSION, deps(fetchReleaseFile))).resolves.toMatch(
      /checksums-sha256\.txt.*signature/,
    );
  });

  it('rejects a checksums file whose signature covers other bytes', async () => {
    const fetchReleaseFile = serving(
      edited(latest, { [url(VERSION, 'checksums-sha256.txt.ed25519')]: older.get(url(OLD, 'checksums-sha256.txt.ed25519'))! }),
    );
    await expect(verifyInstaller(downloadedInstaller(), VERSION, deps(fetchReleaseFile))).resolves.toMatch(/checksums-sha256\.txt.*signature/);
  });

  it('rejects a signed checksums file with no line for the installer', async () => {
    const fetchReleaseFile = serving(edited(latest, signedChecksums(VERSION, `${sha256(INSTALLER)}  ghostlink-server-0.2.0.tgz\n`)));
    await expect(verifyInstaller(downloadedInstaller(), VERSION, deps(fetchReleaseFile))).resolves.toMatch(/does not list GhostLink-Setup-0\.2\.0\.exe/);
  });

  it('rejects an installer whose SHA-256 differs from its line in the signed checksums', async () => {
    const fetchReleaseFile = serving(edited(latest, signedChecksums(VERSION, `${'ab'.repeat(32)}  GhostLink-Setup-0.2.0.exe\n`)));
    await expect(verifyInstaller(downloadedInstaller(), VERSION, deps(fetchReleaseFile))).resolves.toMatch(/SHA-256/);
  });

  it.each([
    ['the checksums file', 'checksums-sha256.txt'],
    ['its signature', 'checksums-sha256.txt.ed25519'],
    ['the installer signature', 'GhostLink-Setup-0.2.0.exe.ed25519'],
  ])('rejects when %s is missing from the release', async (_label, file) => {
    const assets = new Map(latest);
    assets.delete(url(VERSION, file));
    await expect(verifyInstaller(downloadedInstaller(), VERSION, deps(serving(assets)))).resolves.toMatch(/unavailable/);
  });

  it('rejects a tampered installer (wrong signature for these bytes)', async () => {
    const tampered = Buffer.concat([INSTALLER, Buffer.from('\0evil')]);
    await expect(verifyInstaller(downloadedInstaller(tampered), VERSION, deps(serving(latest)))).resolves.toMatch(/signature/i);
  });

  it('rejects a garbage installer signature of the right length', async () => {
    const fetchReleaseFile = serving(edited(latest, { [url(VERSION, 'GhostLink-Setup-0.2.0.exe.ed25519')]: new Uint8Array(64).fill(1) }));
    await expect(verifyInstaller(downloadedInstaller(), VERSION, deps(fetchReleaseFile))).resolves.toMatch(/signature/i);
  });

  it('rejects an installer signed by another key (wrong key), even when the signed checksums list it', async () => {
    const attacker = keyPair();
    const fetchReleaseFile = serving(edited(latest, { [url(VERSION, 'GhostLink-Setup-0.2.0.exe.ed25519')]: sign(null, INSTALLER, attacker.privateKey) }));
    await expect(verifyInstaller(downloadedInstaller(), VERSION, deps(fetchReleaseFile))).resolves.toMatch(/signature/i);
  });

  it('rejects when the downloaded installer is missing', async () => {
    await expect(verifyInstaller(join(dir.path, 'gone.exe'), VERSION, deps(serving(latest)))).resolves.toMatch(/installer/i);
  });

  it.each([63, 65, 0])('rejects an installer signature of %i bytes', async (length) => {
    const good = latest.get(url(VERSION, 'GhostLink-Setup-0.2.0.exe.ed25519'))!;
    const signature = Buffer.alloc(length);
    Buffer.from(good).copy(signature, 0, 0, Math.min(length, 64));
    const fetchReleaseFile = vi.fn(async (asset: string) => (asset.endsWith('.exe.ed25519') ? signature : latest.get(asset)!));
    await expect(verifyInstaller(downloadedInstaller(), VERSION, deps(fetchReleaseFile))).resolves.toMatch(/signature/i);
  });

  it.each([null, '', '0.2.0-rc.1', '../../0.2.0', 'v0.2.0', '0.2.0/x'])('refuses the version %j without downloading anything', async (version) => {
    const fetchReleaseFile = serving(latest);
    await expect(verifyInstaller(downloadedInstaller(), version, deps(fetchReleaseFile))).resolves.toMatch(/version/i);
    expect(fetchReleaseFile).not.toHaveBeenCalled();
  });

  it.each(['', '0.1.1-dev', 'unknown'])('fails closed when the running version %j is not a release version', async (running) => {
    const fetchReleaseFile = serving(latest);
    await expect(verifyInstaller(downloadedInstaller(), VERSION, deps(fetchReleaseFile, running))).resolves.toMatch(/version/i);
    expect(fetchReleaseFile).not.toHaveBeenCalled();
  });

  it('never throws, even when the fetcher does something odd', async () => {
    const fetchReleaseFile = vi.fn(async () => 'not bytes' as unknown as Uint8Array);
    await expect(verifyInstaller(downloadedInstaller(), VERSION, deps(fetchReleaseFile))).resolves.toEqual(expect.any(String));
  });

  it('trusts RELEASE_PUBLIC_KEY by default, not whatever key signed the files', async () => {
    expect(release.publicKey).not.toBe(RELEASE_PUBLIC_KEY);
    await expect(verifyInstaller(downloadedInstaller(), VERSION, { fetchReleaseFile: serving(latest), runningVersion: RUNNING })).resolves.toMatch(
      /signature/i,
    );
  });
});

describe('parseChecksums (checksums-sha256.txt as release.yml writes it)', () => {
  const HASH = 'a'.repeat(64);
  const parse = (text: string) => parseChecksums(Buffer.from(text));

  it('maps every file name to its SHA-256', () => {
    expect(parse(`${HASH}  GhostLink-Setup-0.2.0.exe\n${'b'.repeat(64)}  latest.yml\n`)).toEqual(
      new Map([
        ['GhostLink-Setup-0.2.0.exe', HASH],
        ['latest.yml', 'b'.repeat(64)],
      ]),
    );
  });

  it.each([
    ['no final newline', `${HASH}  a.exe`],
    ['an empty file', ''],
    ['a blank line', `${HASH}  a.exe\n\n`],
    ['Windows line endings', `${HASH}  a.exe\r\n`],
    ['binary-mode lines', `${HASH} *a.exe\n`],
    ['one space', `${HASH} a.exe\n`],
    ['upper-case hex', `${'A'.repeat(64)}  a.exe\n`],
    ['a short hash', `${'a'.repeat(63)}  a.exe\n`],
    ['a name listed twice', `${HASH}  a.exe\n${'b'.repeat(64)}  a.exe\n`],
    ['a comment', `# checksums\n${HASH}  a.exe\n`],
  ])('refuses %s', (_label, text) => {
    expect(parse(text)).toBeNull();
  });

  it('refuses bytes that are not UTF-8', () => {
    expect(parseChecksums(Buffer.concat([Buffer.from(`${HASH}  `), Buffer.from([0xff, 0xfe]), Buffer.from('\n')]))).toBeNull();
  });
});

describe('verifyDetachedSignature', () => {
  it('checks raw bytes against a raw base64url key and fails closed on a bad key', () => {
    const signature = sign(null, INSTALLER, release.privateKey);
    expect(verifyDetachedSignature(INSTALLER, signature, release.publicKey)).toBe(true);
    expect(verifyDetachedSignature(INSTALLER, signature, keyPair().publicKey)).toBe(false);
    expect(verifyDetachedSignature(INSTALLER, signature, 'not-a-key')).toBe(false);
    expect(verifyDetachedSignature(INSTALLER, signature, `${release.publicKey}A`)).toBe(false);
  });
});

describe('createInstallerVerifier (autoUpdater.verifyUpdateCodeSignature)', () => {
  it('ignores the Authenticode publisher names and checks the version being downloaded', async () => {
    const fetchReleaseFile = serving(latest);
    let version: string | null = VERSION;
    const verify = createInstallerVerifier(() => version, deps(fetchReleaseFile));
    await expect(verify(['GhostLink contributors'], downloadedInstaller())).resolves.toBeNull();
    version = null; // nothing announced by update-available: fail closed
    await expect(verify(['GhostLink contributors'], downloadedInstaller())).resolves.toMatch(/version/i);
    version = '0.2.1'; // a different release: its files are not served
    await expect(verify([], downloadedInstaller())).resolves.toMatch(/unavailable/);
  });

  it('reads everything from the tagged release of that version only', () => {
    expect(installerSignatureUrl(VERSION)).toBe(url(VERSION, 'GhostLink-Setup-0.2.0.exe.ed25519'));
    expect(checksumsUrl(VERSION)).toBe(url(VERSION, 'checksums-sha256.txt'));
    expect(checksumsSignatureUrl(VERSION)).toBe(url(VERSION, 'checksums-sha256.txt.ed25519'));
    for (const build of [installerSignatureUrl, checksumsUrl, checksumsSignatureUrl]) expect(() => build('0.2.0-beta')).toThrow();
  });
});

describe('createReleaseFileFetcher', () => {
  const SIGNATURE_URL = url(VERSION, 'GhostLink-Setup-0.2.0.exe.ed25519');
  const response = (body: Uint8Array | null, init: { status?: number; url?: string } = {}) => {
    const res = new Response(body, { status: init.status ?? 200 });
    Object.defineProperty(res, 'url', { value: init.url ?? SIGNATURE_URL });
    return res;
  };

  it('returns the bytes of a successful HTTPS download', async () => {
    const fetchImpl = vi.fn(async () => response(new Uint8Array(64).fill(9)));
    const fetchReleaseFile = createReleaseFileFetcher(fetchImpl);
    await expect(fetchReleaseFile(SIGNATURE_URL, 64)).resolves.toEqual(new Uint8Array(64).fill(9));
    expect(fetchImpl).toHaveBeenCalledWith(SIGNATURE_URL, expect.objectContaining({ redirect: 'follow', signal: expect.any(AbortSignal) }));
  });

  it('refuses non-HTTPS URLs before fetching, and HTTP redirects away from HTTPS', async () => {
    const fetchImpl = vi.fn(async () => response(new Uint8Array(64), { url: 'http://evil.example/sig' }));
    const fetchReleaseFile = createReleaseFileFetcher(fetchImpl);
    await expect(fetchReleaseFile('http://github.com/x.ed25519', 64)).rejects.toThrow(/https/i);
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(fetchReleaseFile(SIGNATURE_URL, 64)).rejects.toThrow(/https/i);
  });

  it('refuses error statuses and bodies over the given bound', async () => {
    await expect(createReleaseFileFetcher(async () => response(null, { status: 404 }))(SIGNATURE_URL, 64)).rejects.toThrow(/404/);
    await expect(createReleaseFileFetcher(async () => response(new Uint8Array(65)))(SIGNATURE_URL, 64)).rejects.toThrow(/too large/i);
    await expect(createReleaseFileFetcher(async () => response(new Uint8Array(5000)))(SIGNATURE_URL, 5000)).resolves.toHaveLength(5000);
  });

  it('gives up after the timeout', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    await expect(createReleaseFileFetcher(fetchImpl, 20)(SIGNATURE_URL, 64)).rejects.toThrow();
  });
});
