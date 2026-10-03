import { generateKeyPairSync, sign } from 'node:crypto';
import { formatLicense, type LicenseData } from '@ghostlink/shared';

/**
 * A license key made for this test run only (never a real one, never written anywhere): pass
 * `publicKey` to createEnterpriseModule and sign licenses with `issue`.
 */
export function testLicenseKey(): { publicKey: string; issue(d: Omit<LicenseData, 'v'>): string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'jwk' }).x;
  if (typeof raw !== 'string') throw new Error('not an Ed25519 key');
  return { publicKey: raw, issue: (d) => formatLicense({ v: 1, ...d }, (input) => sign(null, input, privateKey)) };
}
