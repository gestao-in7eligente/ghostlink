import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_CHECKSUMS_FILE } from '@ghostlink/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { parseChecksums as appParseChecksums } from '../../apps/desktop/src/main/updaterSignature.js';
import { CHECKSUMS_FILE, checksumsFor, parseChecksums, verifyReleaseDir } from '../lib/releaseFiles.mjs';
import { generateReleaseKey, signFiles } from '../lib/releaseKey.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const verifyScript = join(repoRoot, 'scripts', 'verify-release.mjs');

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ghostlink-verify-release-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const key = generateReleaseKey();

/** A release directory as the sign job leaves it: files, their .ed25519, checksums and its .ed25519. */
async function signedRelease(version = '0.2.0', files?: Record<string, string>, checksumsKey = key): Promise<string> {
  const dir = tempDir();
  const all = files ?? {
    [`GhostLink-Setup-${version}.exe`]: `installer ${version}`,
    [`GhostLink-Setup-${version}.exe.blockmap`]: 'blockmap',
    'latest.yml': `version: ${version}\n`,
    [`ghostlink-server-${version}.tgz`]: `server ${version}`,
    'install.sh': '#!/usr/bin/env bash\n',
  };
  for (const [name, data] of Object.entries(all)) writeFileSync(join(dir, name), data);
  signFiles(
    Object.keys(all).map((name) => join(dir, name)),
    key.privateKeyPem,
    key.publicKey,
  );
  writeFileSync(join(dir, CHECKSUMS_FILE), await checksumsFor(dir));
  signFiles([join(dir, CHECKSUMS_FILE)], checksumsKey.privateKeyPem, checksumsKey.publicKey);
  return dir;
}

describe('verifyReleaseDir (release.yml checks what the app and install.sh will check, before publishing)', () => {
  it('accepts a release whose signed checksums list the installer and the server package of this version', async () => {
    const dir = await signedRelease();
    await expect(verifyReleaseDir(dir, '0.2.0', key.publicKey)).resolves.toEqual(['GhostLink-Setup-0.2.0.exe', 'ghostlink-server-0.2.0.tgz']);
  });

  it('refuses checksums signed by another key', async () => {
    const dir = await signedRelease('0.2.0', undefined, generateReleaseKey());
    await expect(verifyReleaseDir(dir, '0.2.0', key.publicKey)).rejects.toThrow(/checksums-sha256\.txt\.ed25519/);
  });

  it('refuses a release without the checksums signature', async () => {
    const dir = await signedRelease();
    unlinkSync(join(dir, `${CHECKSUMS_FILE}.ed25519`));
    await expect(verifyReleaseDir(dir, '0.2.0', key.publicKey)).rejects.toThrow(/missing/);
  });

  it('refuses a release whose installer is not named after this version (every client would reject it)', async () => {
    const dir = await signedRelease('0.2.0', { 'GhostLink Setup 0.2.0.exe': 'x', 'ghostlink-server-0.2.0.tgz': 'y' });
    await expect(verifyReleaseDir(dir, '0.2.0', key.publicKey)).rejects.toThrow(/GhostLink-Setup-0\.2\.0\.exe/);
  });

  it('refuses a file changed after the checksums were written', async () => {
    const dir = await signedRelease();
    writeFileSync(join(dir, 'ghostlink-server-0.2.0.tgz'), 'changed');
    await expect(verifyReleaseDir(dir, '0.2.0', key.publicKey)).rejects.toThrow(/checksums-sha256\.txt/);
  });

  it('refuses a checksums file that is not exactly what checksums.mjs writes', async () => {
    const dir = await signedRelease();
    writeFileSync(join(dir, CHECKSUMS_FILE), (await checksumsFor(dir)).replace(/\n/g, '\r\n'));
    signFiles([join(dir, CHECKSUMS_FILE)], key.privateKeyPem, key.publicKey);
    await expect(verifyReleaseDir(dir, '0.2.0', key.publicKey)).rejects.toThrow(/checksums-sha256\.txt/);
  });

  it('refuses a per-file signature by another key', async () => {
    const dir = await signedRelease();
    const other = generateReleaseKey();
    signFiles([join(dir, 'GhostLink-Setup-0.2.0.exe')], other.privateKeyPem, other.publicKey);
    writeFileSync(join(dir, CHECKSUMS_FILE), await checksumsFor(dir));
    signFiles([join(dir, CHECKSUMS_FILE)], key.privateKeyPem, key.publicKey);
    await expect(verifyReleaseDir(dir, '0.2.0', key.publicKey)).rejects.toThrow(/GhostLink-Setup-0\.2\.0\.exe\.ed25519/);
  });

  it('refuses a version that is not a stable release', async () => {
    const dir = await signedRelease();
    await expect(verifyReleaseDir(dir, 'v0.2.0', key.publicKey)).rejects.toThrow(/version/);
  });
});

describe('verify-release.mjs', () => {
  it('fails with usage, and fails a release not signed by the embedded release key', async () => {
    const usage = spawnSync(process.execPath, [verifyScript], { encoding: 'utf8' });
    expect(usage.status).toBe(2);
    const dir = await signedRelease();
    const wrongKey = spawnSync(process.execPath, [verifyScript, dir, '0.2.0'], { encoding: 'utf8' });
    expect(wrongKey.status).toBe(1);
    expect(wrongKey.stderr).toMatch(/verify-release: .*ed25519/);
  });
});

describe('checksums-sha256.txt contract between the pipeline and the app', () => {
  it('uses the same file name', () => {
    expect(CHECKSUMS_FILE).toBe(RELEASE_CHECKSUMS_FILE);
  });

  it('is parsed by the app exactly as the pipeline wrote it', async () => {
    const dir = await signedRelease();
    const text = await checksumsFor(dir);
    const app = appParseChecksums(Buffer.from(text));
    expect(app).not.toBeNull();
    expect(app).toEqual(parseChecksums(text));
    expect(app!.has('GhostLink-Setup-0.2.0.exe')).toBe(true);
  });
});
