import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RELEASE_PUBLIC_KEY } from '@ghostlink/shared';
import {
  createInstallerVerifier,
  createSignatureFetcher,
  installerSignatureUrl,
  verifyDetachedSignature,
  verifyInstaller,
  type SignatureFetcher,
} from '../../src/main/updaterSignature.js';
import { useTempDir } from '../helpers/tempDir.js';

const dir = useTempDir('ghostlink-updater-');

function keyPair(): { publicKey: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return { publicKey: der.subarray(12).toString('base64url'), privateKey };
}

const release = keyPair();
const INSTALLER = Buffer.from('MZ… pretend this is GhostLink-Setup-0.1.1.exe');
const SIGNATURE_URL = 'https://github.com/gestao-in7eligente/ghostlink/releases/download/v0.1.1/GhostLink-Setup-0.1.1.exe.ed25519';

/** The installer as electron-updater leaves it before verification (a temp name in its cache dir). */
function downloadedInstaller(bytes: Uint8Array = INSTALLER): string {
  const path = join(dir.path, 'temp-GhostLink-Setup-0.1.1.exe');
  writeFileSync(path, bytes);
  return path;
}

/** Serves one signature at the expected URL; anything else is a 404. */
function serving(signature: Uint8Array): SignatureFetcher & ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string) => {
    if (url !== SIGNATURE_URL) throw new Error(`HTTP 404 for ${url}`);
    return signature;
  });
}

const deps = (fetchSignature: SignatureFetcher) => ({ fetchSignature, publicKey: release.publicKey });

describe('verifyInstaller (spec §15: detached Ed25519 signature of the installer)', () => {
  it('accepts an installer signed by the release key (null = valid, electron-updater contract)', async () => {
    const fetchSignature = serving(sign(null, INSTALLER, release.privateKey));
    await expect(verifyInstaller(downloadedInstaller(), '0.1.1', deps(fetchSignature))).resolves.toBeNull();
    expect(fetchSignature).toHaveBeenCalledWith(SIGNATURE_URL);
  });

  it('rejects a tampered installer (wrong signature for these bytes)', async () => {
    const fetchSignature = serving(sign(null, INSTALLER, release.privateKey));
    const tampered = Buffer.concat([INSTALLER, Buffer.from('\0evil')]);
    await expect(verifyInstaller(downloadedInstaller(tampered), '0.1.1', deps(fetchSignature))).resolves.toMatch(/signature/i);
  });

  it('rejects a garbage signature of the right length', async () => {
    const fetchSignature = serving(new Uint8Array(64).fill(1));
    await expect(verifyInstaller(downloadedInstaller(), '0.1.1', deps(fetchSignature))).resolves.toMatch(/signature/i);
  });

  it('rejects an installer signed by another key (wrong key)', async () => {
    const attacker = keyPair();
    const fetchSignature = serving(sign(null, INSTALLER, attacker.privateKey));
    await expect(verifyInstaller(downloadedInstaller(), '0.1.1', deps(fetchSignature))).resolves.toMatch(/signature/i);
  });

  it('rejects when the signature file is missing from the release', async () => {
    const fetchSignature = vi.fn(async () => {
      throw new Error('HTTP 404');
    });
    await expect(verifyInstaller(downloadedInstaller(), '0.1.1', deps(fetchSignature))).resolves.toMatch(/signature/i);
  });

  it('rejects when the downloaded installer is missing', async () => {
    const fetchSignature = serving(sign(null, INSTALLER, release.privateKey));
    await expect(verifyInstaller(join(dir.path, 'gone.exe'), '0.1.1', deps(fetchSignature))).resolves.toMatch(/installer/i);
  });

  it.each([63, 65, 0])('rejects a signature of %i bytes', async (length) => {
    const good = sign(null, INSTALLER, release.privateKey);
    const signature = Buffer.alloc(length);
    good.copy(signature, 0, 0, Math.min(length, 64));
    await expect(verifyInstaller(downloadedInstaller(), '0.1.1', deps(serving(signature)))).resolves.toMatch(/signature/i);
  });

  it.each([null, '', '0.1.1-rc.1', '../../0.1.1', 'v0.1.1', '0.1.1/x'])(
    'refuses the version %j without downloading anything',
    async (version) => {
      const fetchSignature = serving(sign(null, INSTALLER, release.privateKey));
      await expect(verifyInstaller(downloadedInstaller(), version, deps(fetchSignature))).resolves.toMatch(/version/i);
      expect(fetchSignature).not.toHaveBeenCalled();
    },
  );

  it('never throws, even when the fetcher does something odd', async () => {
    const fetchSignature = vi.fn(async () => 'not bytes' as unknown as Uint8Array);
    await expect(verifyInstaller(downloadedInstaller(), '0.1.1', deps(fetchSignature))).resolves.toEqual(expect.any(String));
  });

  it('trusts RELEASE_PUBLIC_KEY by default, not whatever key signed the file', async () => {
    const fetchSignature = serving(sign(null, INSTALLER, release.privateKey));
    expect(release.publicKey).not.toBe(RELEASE_PUBLIC_KEY);
    await expect(verifyInstaller(downloadedInstaller(), '0.1.1', { fetchSignature })).resolves.toMatch(/signature/i);
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
    const fetchSignature = serving(sign(null, INSTALLER, release.privateKey));
    let version: string | null = '0.1.1';
    const verify = createInstallerVerifier(() => version, deps(fetchSignature));
    await expect(verify(['GhostLink contributors'], downloadedInstaller())).resolves.toBeNull();
    version = null; // nothing announced by update-available: fail closed
    await expect(verify(['GhostLink contributors'], downloadedInstaller())).resolves.toMatch(/version/i);
    version = '0.1.2'; // a different release: its signature URL is not served
    await expect(verify([], downloadedInstaller())).resolves.toMatch(/signature/i);
  });

  it('builds the signature URL from the version only', () => {
    expect(installerSignatureUrl('0.1.1')).toBe(SIGNATURE_URL);
    expect(() => installerSignatureUrl('0.1.1-beta')).toThrow();
  });
});

describe('createSignatureFetcher', () => {
  const response = (body: Uint8Array | null, init: { status?: number; url?: string } = {}) => {
    const res = new Response(body, { status: init.status ?? 200 });
    Object.defineProperty(res, 'url', { value: init.url ?? SIGNATURE_URL });
    return res;
  };

  it('returns the 64 bytes of a successful HTTPS download', async () => {
    const fetchImpl = vi.fn(async () => response(new Uint8Array(64).fill(9)));
    const fetchSignature = createSignatureFetcher(fetchImpl);
    await expect(fetchSignature(SIGNATURE_URL)).resolves.toEqual(new Uint8Array(64).fill(9));
    expect(fetchImpl).toHaveBeenCalledWith(SIGNATURE_URL, expect.objectContaining({ redirect: 'follow', signal: expect.any(AbortSignal) }));
  });

  it('refuses non-HTTPS URLs before fetching, and HTTP redirects away from HTTPS', async () => {
    const fetchImpl = vi.fn(async () => response(new Uint8Array(64), { url: 'http://evil.example/sig' }));
    const fetchSignature = createSignatureFetcher(fetchImpl);
    await expect(fetchSignature('http://github.com/x.ed25519')).rejects.toThrow(/https/i);
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(fetchSignature(SIGNATURE_URL)).rejects.toThrow(/https/i);
  });

  it('refuses error statuses and oversized bodies', async () => {
    await expect(createSignatureFetcher(async () => response(null, { status: 404 }))(SIGNATURE_URL)).rejects.toThrow(/404/);
    await expect(createSignatureFetcher(async () => response(new Uint8Array(10_000)))(SIGNATURE_URL)).rejects.toThrow(/too large/i);
  });

  it('gives up after the timeout', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    await expect(createSignatureFetcher(fetchImpl, 20)(SIGNATURE_URL)).rejects.toThrow();
  });
});
