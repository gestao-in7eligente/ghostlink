// Enterprise servers (spec 2026-10-02-enterprise-e-hermes-da-empresa-design.md §1): the edition
// everyone sees, and the license as its owner sees it. The license text never comes back.
//
// Request (the owner only): `enterprise.license.set { license }` → EnterpriseState. FORBIDDEN for
// anyone else; LICENSE_INVALID (unreadable, forged or for another server); LICENSE_EXPIRED (past the
// 7 days of grace). Stored only when it makes the server Enterprise; it replaces the old one at once.
// Welcome key `enterprise` and event `enterprise.state`: EnterpriseState, sent to everyone when the
// edition changes and to the owner when the license's state does.
import { z } from 'zod';
import { LICENSE_LIMITS, LICENSE_STATES, type LicenseState } from './license.js';

/** welcome.features: the server has editions (an older app ignores them). */
export const FEATURE_ENTERPRISE = 'enterprise';

export const EDITIONS = ['normal', 'enterprise'] as const;
export type Edition = (typeof EDITIONS)[number];

/** The stored license, for the owner only. */
export interface EnterpriseLicenseInfo {
  state: LicenseState;
  /** null when it could not be read (state invalid). */
  company: string | null;
  issuedAt: number | null;
  expiresAt: number | null;
  /** Enterprise until then: expiresAt + 7 days. */
  graceEndsAt: number | null;
}

/** The edition for everyone; `license` for the owner only (null: none pasted). */
export interface EnterpriseState {
  edition: Edition;
  license?: EnterpriseLicenseInfo | null;
}

export interface EnterpriseLicenseSetPayload {
  license: string;
}

export const ENTERPRISE_LIMITS = {
  /** enterprise.license.set per owner per minute. */
  licenseSetsPerMinute: 10,
} as const;

// ---- server side: strict ----

export const enterpriseLicenseSetSchema = z.strictObject({ license: z.string().min(1).max(LICENSE_LIMITS.maxLength + 256) });

// ---- client side: lenient ----

export const enterpriseLicenseInfoSchemaClient: z.ZodType<EnterpriseLicenseInfo> = z.object({
  state: z.enum(LICENSE_STATES).catch('invalid'),
  company: z.string().max(200).nullable().catch(null),
  issuedAt: z.number().nullable().catch(null),
  expiresAt: z.number().nullable().catch(null),
  graceEndsAt: z.number().nullable().catch(null),
});

export const enterpriseStateSchemaClient: z.ZodType<EnterpriseState> = z.object({
  edition: z.enum(EDITIONS).catch('normal'),
  license: enterpriseLicenseInfoSchemaClient.nullable().optional().catch(undefined),
});
