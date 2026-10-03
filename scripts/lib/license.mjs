// Enterprise license helpers (spec 2026-10-02-enterprise-e-hermes-da-empresa-design.md §1) for
// gen-license-key.mjs and issue-license.mjs. Node built-ins only. The format mirrors
// packages/shared/src/license.ts byte for byte (scripts/test/license.test.ts checks it).
import { Buffer } from 'node:buffer';
import { sign } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const LICENSE_PREFIX = 'GLE1';
export const LICENSE_LABEL = 'ghostlink-license-v1';

/**
 * `GLE1.<data>.<signature>`, as formatLicense in @ghostlink/shared.
 * @param {{ company: string; serverKeyId: string; issuedAt: number; expiresAt: number }} d
 * @param {import('node:crypto').KeyObject} privateKey an Ed25519 private key
 */
export function encodeLicense(d, privateKey) {
  const json = JSON.stringify({ v: 1, company: d.company, serverKeyId: d.serverKeyId, issuedAt: d.issuedAt, expiresAt: d.expiresAt });
  const segment = Buffer.from(json, 'utf8').toString('base64url');
  const signature = sign(null, Buffer.from(`${LICENSE_LABEL}\n${segment}`, 'utf8'), privateKey);
  return `${LICENSE_PREFIX}.${segment}.${signature.toString('base64url')}`;
}

/**
 * The git work tree that holds `path` (the nearest existing folder or a parent with a `.git` entry),
 * or null. A private key is never written there nor read from there.
 * @param {string} path a file path (it need not exist)
 */
export function enclosingWorkTree(path) {
  let dir = resolve(dirname(path));
  while (!existsSync(dir)) {
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  dir = realpathSync.native(dir);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * The last millisecond of `YYYY-MM-DD` in São Paulo (UTC−3, no daylight saving since 2019).
 * @param {string} date
 */
export function endOfDaySaoPaulo(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error('the date must be YYYY-MM-DD');
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1, 2, 59, 59, 999);
  if (new Date(ms - 3 * 3_600_000).toISOString().slice(0, 10) !== date) throw new Error('not a real date');
  return ms;
}

/**
 * LICENSE_PUBLIC_KEY as written in packages/shared/src/license.ts.
 * @param {string} repoRoot
 */
export function embeddedLicensePublicKey(repoRoot) {
  const source = readFileSync(join(repoRoot, 'packages', 'shared', 'src', 'license.ts'), 'utf8');
  const key = /export const LICENSE_PUBLIC_KEY: string = '([A-Za-z0-9_-]{43})';/.exec(source)?.[1];
  if (key === undefined) throw new Error('LICENSE_PUBLIC_KEY is not set in packages/shared/src/license.ts (run gen-license-key.mjs first)');
  return key;
}
