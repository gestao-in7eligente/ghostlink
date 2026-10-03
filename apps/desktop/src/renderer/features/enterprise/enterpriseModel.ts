import type { Edition, EnterpriseLicenseInfo } from '@ghostlink/shared';

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

const DAY_MS = 86_400_000;

/** Whole days from `now` to `at`, rounded up (a part of a day still counts), never below 0. */
export function daysUntil(at: number, now: number): number {
  return Math.max(0, Math.ceil((at - now) / DAY_MS));
}

export type EnterpriseView =
  | { mode: 'normal' }
  | { mode: 'enterprise'; tone: 'ok' | 'warning' | 'danger'; company: string; expiresAt: number; days: number };

/**
 * What the Enterprise tab shows: the plain view (identity + paste form) for a normal server, or the
 * license card for an Enterprise one. `days` counts to the expiry, or in grace to the fallback.
 */
export function enterpriseView(edition: Edition, license: EnterpriseLicenseInfo | null, now: number): EnterpriseView {
  if (edition !== 'enterprise' || !license || license.expiresAt === null) return { mode: 'normal' };
  const company = license.company ?? '';
  if (license.state === 'valid') return { mode: 'enterprise', tone: 'ok', company, expiresAt: license.expiresAt, days: daysUntil(license.expiresAt, now) };
  if (license.state === 'expiring') return { mode: 'enterprise', tone: 'warning', company, expiresAt: license.expiresAt, days: daysUntil(license.expiresAt, now) };
  if (license.state === 'grace' && license.graceEndsAt !== null) {
    return { mode: 'enterprise', tone: 'danger', company, expiresAt: license.expiresAt, days: daysUntil(license.graceEndsAt, now) };
  }
  return { mode: 'normal' };
}
