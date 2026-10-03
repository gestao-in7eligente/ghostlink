import { generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LICENSE_LIMITS, LICENSE_PUBLIC_KEY, checkLicense, formatLicense, grantsEnterprise, parseLicense, toBase64Url, utf8, type LicenseData } from '../src/index.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 2, 15);
const SERVER = 'S'.repeat(43);
// Made for this run only: never a real license key.
const key = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');

const data = (o: Partial<LicenseData> = {}): LicenseData => ({ v: 1, company: 'TC Flag', serverKeyId: SERVER, issuedAt: NOW - DAY, expiresAt: NOW + 30 * DAY, ...o });
const issue = (d: LicenseData = data(), k: KeyObject = key.privateKey) => formatLicense(d, (input) => sign(null, input, k));
const check = (text: string, now = NOW) =>
  checkLicense(text, { serverKeyId: SERVER, now, verify: (signed, signature) => verify(null, signed, key.publicKey, signature) });

describe('Enterprise licenses (spec §1)', () => {
  it('a license for this server is valid, and reads back as issued', () => {
    const text = issue();
    expect(text).toMatch(/^GLE1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/);
    expect(check(text)).toEqual({ state: 'valid', data: data() });
    expect(check(`  ${text}\n`).state).toBe('valid');
  });

  it('warns in the last 7 days, stays Enterprise 7 days past expiry, then expires', () => {
    const expiresAt = NOW + 30 * DAY;
    const text = issue();
    expect(check(text, expiresAt - LICENSE_LIMITS.warnBeforeMs - 1).state).toBe('valid');
    expect(check(text, expiresAt - LICENSE_LIMITS.warnBeforeMs).state).toBe('expiring');
    expect(check(text, expiresAt + 1).state).toBe('grace');
    expect(check(text, expiresAt + LICENSE_LIMITS.graceMs).state).toBe('grace');
    expect(check(text, expiresAt + LICENSE_LIMITS.graceMs + 1).state).toBe('expired');
    expect((['valid', 'expiring', 'grace'] as const).every(grantsEnterprise)).toBe(true);
    expect((['expired', 'wrong-server', 'invalid'] as const).some(grantsEnterprise)).toBe(false);
  });

  it('a license copied to another server does not count there', () => {
    expect(check(issue(data({ serverKeyId: 'T'.repeat(43) })))).toMatchObject({ state: 'wrong-server', data: { company: 'TC Flag' } });
  });

  it('a forged license is invalid: another key, or data changed after signing', () => {
    expect(check(issue(data(), other.privateKey))).toEqual({ state: 'invalid', data: null });
    const [prefix, , signature] = issue().split('.');
    const changed = toBase64Url(utf8(JSON.stringify({ ...data(), company: 'Outra' })));
    expect(check(`${prefix}.${changed}.${signature}`).state).toBe('invalid');
  });

  it.each([
    ['empty', ''],
    ['prefix only', 'GLE1'],
    ['another version', issue().replace(/^GLE1/, 'GLE2')],
    ['an extra part', `${issue()}.x`],
    ['not base64url', 'GLE1.%%%.' + 'A'.repeat(86)],
    ['not JSON', `GLE1.${toBase64Url(utf8('oi'))}.${'A'.repeat(86)}`],
    ['an unknown field', `GLE1.${toBase64Url(utf8(JSON.stringify({ ...data(), extra: 1 })))}.${'A'.repeat(86)}`],
    ['expires before issued', issue(data({ expiresAt: NOW - 2 * DAY }))],
    ['a short signature', issue().slice(0, -2)],
    ['too long', `GLE1.${'A'.repeat(LICENSE_LIMITS.maxLength)}.${'A'.repeat(86)}`],
  ])('a broken license (%s) is invalid', (_why, text) => {
    expect(parseLicense(text)).toBeNull();
    expect(check(text)).toEqual({ state: 'invalid', data: null });
  });

  it('the license public key is set (the ceremony ran)', () => {
    expect(LICENSE_PUBLIC_KEY).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
