import type { EnterpriseLicenseInfo } from '@ghostlink/shared';

/** The owner's band at the top (spec §1 "Validade"): the 7 days before expiry and the 7 after. */
export function licenseBanner(
  license: EnterpriseLicenseInfo | null,
  owner: boolean,
): { key: 'enterprise.banner.expiring' | 'enterprise.banner.grace'; date: number } | null {
  if (!owner || !license || license.expiresAt === null) return null;
  if (license.state === 'expiring') return { key: 'enterprise.banner.expiring', date: license.expiresAt };
  if (license.state === 'grace' && license.graceEndsAt !== null) return { key: 'enterprise.banner.grace', date: license.graceEndsAt };
  return null;
}
