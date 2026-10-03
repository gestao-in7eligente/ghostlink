import { spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLicense, ed25519SpkiDer, formatLicense, fromBase64Url } from '@ghostlink/shared';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const run = (script: string, args: string[]) => spawnSync(process.execPath, [join(repoRoot, 'scripts', script), ...args], { encoding: 'utf8' });

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ghostlink-license-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A key made by the script into a temp folder (deleted after the test), and its public half. */
function makeKey(): { file: string; publicKey: string } {
  const file = join(tempDir(), 'license-key.pem');
  const r = run('gen-license-key.mjs', ['--private-key-out', file]);
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout + r.stderr).not.toMatch(/PRIVATE KEY/);
  return { file, publicKey: /^LICENSE_PUBLIC_KEY=([A-Za-z0-9_-]{43})$/m.exec(r.stdout)![1]! };
}

describe('gen-license-key.mjs', () => {
  it('writes the private key outside any repository, never prints it and never overwrites it', () => {
    const { file } = makeKey();
    expect(readFileSync(file, 'utf8')).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    const again = run('gen-license-key.mjs', ['--private-key-out', file]);
    expect(again.status).toBe(1);
    expect(again.stdout + again.stderr).not.toMatch(/PRIVATE KEY/);
  });

  it('refuses a path inside this repository or any git work tree, and runs only with --private-key-out', () => {
    const inside = join(repoRoot, 'license-key-never-created.pem');
    expect(run('gen-license-key.mjs', ['--private-key-out', inside]).status).toBe(2);
    expect(existsSync(inside)).toBe(false);
    const other = tempDir();
    mkdirSync(join(other, '.git'));
    expect(run('gen-license-key.mjs', ['--private-key-out', join(other, 'sub', 'k.pem')]).status).toBe(2);
    expect(run('gen-license-key.mjs', []).status).toBe(2);
  });
});

describe('issue-license.mjs', () => {
  const server = 'S'.repeat(43);

  it('issues a license the server accepts, byte for byte what @ghostlink/shared would sign', () => {
    const key = makeKey();
    const r = run('issue-license.mjs', ['--key', key.file, '--company', 'TC Flag', '--server', server, '--until', '2099-12-31', '--expect-public-key', key.publicKey]);
    expect(r.status, r.stderr).toBe(0);
    const text = r.stdout.trim();
    const publicKey = createPublicKey({ key: Buffer.from(ed25519SpkiDer(fromBase64Url(key.publicKey))), format: 'der', type: 'spki' });
    const result = checkLicense(text, { serverKeyId: server, now: Date.now(), verify: (s, sig) => verify(null, s, publicKey, sig) });
    // 2099-12-31 23:59:59.999 in São Paulo (UTC−3).
    expect(result).toMatchObject({ state: 'valid', data: { company: 'TC Flag', serverKeyId: server, expiresAt: Date.UTC(2100, 0, 1, 2, 59, 59, 999) } });
    const privateKey = createPrivateKey(readFileSync(key.file, 'utf8'));
    expect(formatLicense(result.data!, (input) => sign(null, input, privateKey))).toBe(text);
  });

  it('refuses another key, a key inside a repository, a bad server identity and a past date', () => {
    const key = makeKey();
    const base = ['--company', 'TC Flag', '--server', server, '--until', '2099-12-31'];
    expect(run('issue-license.mjs', ['--key', key.file, ...base, '--expect-public-key', 'A'.repeat(43)]).status).toBe(1);
    expect(run('issue-license.mjs', ['--key', join(repoRoot, 'package.json'), ...base, '--expect-public-key', key.publicKey]).status).toBe(2);
    expect(run('issue-license.mjs', ['--key', key.file, '--company', 'TC Flag', '--server', 'short', '--until', '2099-12-31', '--expect-public-key', key.publicKey]).status).toBe(2);
    expect(run('issue-license.mjs', ['--key', key.file, '--company', 'TC Flag', '--server', server, '--until', '2001-01-01', '--expect-public-key', key.publicKey]).status).toBe(2);
  });
});
