import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_PUBLIC_KEY, ed25519SpkiDer, fromBase64Url } from '@ghostlink/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SIGNATURE_SUFFIX,
  embeddedPublicKey,
  generateReleaseKey,
  loadPrivateKey,
  publicKeyFromRaw,
  publicKeyPem,
  rawPublicKey,
  signFiles,
  verifyBytes,
} from '../lib/releaseKey.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const genScript = join(repoRoot, 'scripts', 'gen-release-key.mjs');
const signScript = join(repoRoot, 'scripts', 'sign-release.mjs');

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ghostlink-release-key-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('release key encoding', () => {
  it('round-trips the raw base64url public key through SPKI', () => {
    const { publicKey, privateKeyPem } = generateReleaseKey();
    expect(publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const key = publicKeyFromRaw(publicKey);
    expect(rawPublicKey(key)).toBe(publicKey);
    expect(rawPublicKey(loadPrivateKey(privateKeyPem))).toBe(publicKey);
  });

  it('builds the same SPKI DER as @ghostlink/shared (updater and scripts agree on the key)', () => {
    const { publicKey } = generateReleaseKey();
    const der = publicKeyFromRaw(publicKey).export({ type: 'spki', format: 'der' });
    expect(Buffer.from(ed25519SpkiDer(fromBase64Url(publicKey)))).toEqual(der);
  });

  it('prints an openssl-compatible PEM for the public key', () => {
    const { publicKey } = generateReleaseKey();
    const pem = publicKeyPem(publicKey);
    expect(pem).toMatch(/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=]+\n-----END PUBLIC KEY-----\n$/);
  });

  it.each([
    ['too short', 'AAAA'],
    ['padding', `${'A'.repeat(43)}=`],
    ['standard base64 alphabet', `${'A'.repeat(42)}+`],
    ['non-canonical trailing bits', `${'A'.repeat(42)}B`],
  ])('rejects a malformed raw public key (%s)', (_label, raw) => {
    expect(() => publicKeyFromRaw(raw)).toThrow();
  });

  it('refuses a private key that is not Ed25519, without echoing it', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => loadPrivateKey(rsa)).toThrow(/Ed25519/);
    let message = '';
    try {
      loadPrivateKey('-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----\n');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('not-a-key');
  });

  it('reads RELEASE_PUBLIC_KEY from packages/shared/src/release.ts', () => {
    expect(embeddedPublicKey(repoRoot)).toBe(RELEASE_PUBLIC_KEY);
  });
});

describe('signFiles', () => {
  it('writes <file>.ed25519: a raw 64-byte signature over the file bytes', () => {
    const dir = tempDir();
    const { publicKey, privateKeyPem } = generateReleaseKey();
    const file = join(dir, 'GhostLink-Setup-9.9.9.exe');
    writeFileSync(file, 'installer bytes');
    expect(signFiles([file], privateKeyPem, publicKey)).toEqual([`${file}${SIGNATURE_SUFFIX}`]);
    const signature = readFileSync(`${file}${SIGNATURE_SUFFIX}`);
    expect(signature).toHaveLength(64);
    expect(verifyBytes(readFileSync(file), signature, publicKeyFromRaw(publicKey))).toBe(true);
    expect(verifyBytes(Buffer.from('installer bytez'), signature, publicKeyFromRaw(publicKey))).toBe(false);
  });

  it('refuses to sign with a key that does not match the embedded public key', () => {
    const dir = tempDir();
    const file = join(dir, 'a.tgz');
    writeFileSync(file, 'x');
    const other = generateReleaseKey();
    const embedded = generateReleaseKey();
    expect(() => signFiles([file], other.privateKeyPem, embedded.publicKey)).toThrow(/does not match/);
    expect(existsSync(`${file}${SIGNATURE_SUFFIX}`)).toBe(false);
  });

  it('never signs a signature file, and refuses directories', () => {
    const dir = tempDir();
    const { publicKey, privateKeyPem } = generateReleaseKey();
    writeFileSync(join(dir, 'a.tgz'), 'x');
    writeFileSync(join(dir, `a.tgz${SIGNATURE_SUFFIX}`), 'old');
    expect(signFiles([join(dir, 'a.tgz'), join(dir, `a.tgz${SIGNATURE_SUFFIX}`)], privateKeyPem, publicKey)).toEqual([
      join(dir, `a.tgz${SIGNATURE_SUFFIX}`),
    ]);
    expect(() => signFiles([dir], privateKeyPem, publicKey)).toThrow(/not a file/);
  });

  it('rejects signatures of the wrong length or from another key', () => {
    const a = generateReleaseKey();
    const b = generateReleaseKey();
    const data = Buffer.from('data');
    const dir = tempDir();
    const file = join(dir, 'f');
    writeFileSync(file, data);
    signFiles([file], a.privateKeyPem, a.publicKey);
    const good = readFileSync(`${file}${SIGNATURE_SUFFIX}`);
    expect(verifyBytes(data, good, publicKeyFromRaw(a.publicKey))).toBe(true);
    expect(verifyBytes(data, good, publicKeyFromRaw(b.publicKey))).toBe(false);
    expect(verifyBytes(data, good.subarray(0, 63), publicKeyFromRaw(a.publicKey))).toBe(false);
    expect(verifyBytes(data, Buffer.concat([good, Buffer.from([0])]), publicKeyFromRaw(a.publicKey))).toBe(false);
  });
});

describe('gen-release-key.mjs', () => {
  it('writes the private key only to the requested file (0600, never overwritten) and prints the public key', () => {
    const dir = tempDir();
    const out = join(dir, 'release-key.pem');
    const stdout = execFileSync(process.execPath, [genScript, '--private-key-out', out], { encoding: 'utf8' });
    expect(stdout).not.toContain('PRIVATE KEY');
    const publicKey = /RELEASE_PUBLIC_KEY=([A-Za-z0-9_-]{43})/.exec(stdout)?.[1];
    expect(publicKey).toBeDefined();
    expect(rawPublicKey(loadPrivateKey(readFileSync(out, 'utf8')))).toBe(publicKey);
    if (process.platform !== 'win32') expect(statSync(out).mode & 0o777).toBe(0o600);

    const again = spawnSync(process.execPath, [genScript, '--private-key-out', out], { encoding: 'utf8' });
    expect(again.status).not.toBe(0);
    expect(again.stderr).toMatch(/already exists/);
  });
});

describe('sign-release.mjs', () => {
  it('fails without the key variable and never prints the key', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'a.tgz'), 'x');
    const env = { ...process.env };
    delete env.RELEASE_ED25519_PRIVATE_KEY_PEM;
    const missing = spawnSync(process.execPath, [signScript, join(dir, 'a.tgz')], { encoding: 'utf8', env });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toMatch(/RELEASE_ED25519_PRIVATE_KEY_PEM/);

    // A key other than the one embedded in release.ts: the release must stop before publishing.
    const { privateKeyPem } = generateReleaseKey();
    const wrong = spawnSync(process.execPath, [signScript, join(dir, 'a.tgz')], {
      encoding: 'utf8',
      env: { ...env, RELEASE_ED25519_PRIVATE_KEY_PEM: privateKeyPem },
    });
    expect(wrong.status).not.toBe(0);
    expect(wrong.stderr).toMatch(/does not match RELEASE_PUBLIC_KEY/);
    expect(`${wrong.stdout}${wrong.stderr}`).not.toContain(privateKeyPem.split('\n')[1]!);
    expect(existsSync(join(dir, `a.tgz${SIGNATURE_SUFFIX}`))).toBe(false);
  });
});
