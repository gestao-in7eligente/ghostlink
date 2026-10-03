// Enterprise licenses (spec 2026-10-02-enterprise-e-hermes-da-empresa-design.md §1). Pure data and
// parsing: the server checks the signature with node:crypto (apps/server/src/enterprise/), the
// owner's scripts sign (scripts/lib/license.mjs mirrors formatLicense byte for byte).
import { z } from 'zod';
import { LICENSE_LABEL } from './constants.js';
import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from './encoding.js';
import { ProtocolError } from './errors.js';

/**
 * Raw 32-byte Ed25519 public key of the LICENSE key (its own key, never the release key),
 * base64url. Its private half lives only on the owner's PC (D:\GhostLink Licencas\), made once by
 * scripts/gen-license-key.mjs. Empty until that ceremony: every license is refused.
 */
export const LICENSE_PUBLIC_KEY: string = '';

export const LICENSE_PREFIX = 'GLE1';

export const LICENSE_LIMITS = {
  /** The whole `GLE1.<data>.<signature>` text. */
  maxLength: 2048,
  companyMax: 100,
  /** Still Enterprise this long after `expiresAt` (the owner is warned). */
  graceMs: 7 * 86_400_000,
  /** The owner is warned this long before `expiresAt`. */
  warnBeforeMs: 7 * 86_400_000,
} as const;

/** What a license says. Dates are ms epoch; the server's clock decides. */
export interface LicenseData {
  v: 1;
  company: string;
  /** The server it is for: its TLS key pin, as in invites (base64url SHA-256 of the SPKI). */
  serverKeyId: string;
  issuedAt: number;
  expiresAt: number;
}

export const licenseDataSchema: z.ZodType<LicenseData> = z
  .strictObject({
    v: z.literal(1),
    company: z.string().min(1).max(LICENSE_LIMITS.companyMax),
    serverKeyId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    issuedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .refine((d) => d.expiresAt > d.issuedAt, 'expires before it was issued');

const DATA_SEGMENT = /^[A-Za-z0-9_-]{1,2000}$/;
const SIGNATURE_SEGMENT = /^[A-Za-z0-9_-]{86}$/;

/** The bytes the license key signs: UTF-8 of "ghostlink-license-v1\n" + the base64url data segment (no '\n' can hide in it). */
export function licenseSigningInput(dataSegment: string): Uint8Array {
  if (!DATA_SEGMENT.test(dataSegment)) throw new ProtocolError('BAD_REQUEST', 'invalid license data');
  return utf8(`${LICENSE_LABEL}\n${dataSegment}`);
}

/** `GLE1.<data>.<signature>`; `sign` returns the raw 64-byte Ed25519 signature of its input. */
export function formatLicense(data: LicenseData, sign: (input: Uint8Array) => Uint8Array): string {
  const json = JSON.stringify({ v: data.v, company: data.company, serverKeyId: data.serverKeyId, issuedAt: data.issuedAt, expiresAt: data.expiresAt });
  const segment = toBase64Url(utf8(json));
  return `${LICENSE_PREFIX}.${segment}.${toBase64Url(sign(licenseSigningInput(segment)))}`;
}

export interface ParsedLicense {
  data: LicenseData;
  /** licenseSigningInput(<data segment>). */
  signed: Uint8Array;
  signature: Uint8Array;
}

/** Reads a license (spaces around it allowed); null when it is not one. Does not check the signature. */
export function parseLicense(text: unknown): ParsedLicense | null {
  if (typeof text !== 'string') return null;
  const s = text.trim();
  if (s.length === 0 || s.length > LICENSE_LIMITS.maxLength) return null;
  const parts = s.split('.');
  if (parts.length !== 3 || parts[0] !== LICENSE_PREFIX) return null;
  const segment = parts[1]!;
  const sig = parts[2]!;
  if (!DATA_SEGMENT.test(segment) || !SIGNATURE_SEGMENT.test(sig)) return null;
  try {
    const parsed = licenseDataSchema.safeParse(JSON.parse(fromUtf8(fromBase64Url(segment))));
    const signature = fromBase64Url(sig);
    if (!parsed.success || signature.length !== 64) return null;
    return { data: parsed.data, signed: licenseSigningInput(segment), signature };
  } catch {
    return null;
  }
}

/**
 * Where a license stands for one server now:
 * - invalid: not a license, or a signature the license key did not make;
 * - wrong-server: signed, but for another server;
 * - valid; expiring (its last 7 days); grace (the 7 days after expiresAt): Enterprise;
 * - expired: past the grace, the server is normal again.
 */
export const LICENSE_STATES = ['valid', 'expiring', 'grace', 'expired', 'wrong-server', 'invalid'] as const;
export type LicenseState = (typeof LICENSE_STATES)[number];

export interface LicenseCheck {
  state: LicenseState;
  /** The license's data once its signature checked out (every state but invalid). */
  data: LicenseData | null;
}

export function checkLicense(
  text: unknown,
  opts: { serverKeyId: string; now: number; verify: (signed: Uint8Array, signature: Uint8Array) => boolean },
): LicenseCheck {
  const parsed = parseLicense(text);
  if (!parsed || !opts.verify(parsed.signed, parsed.signature)) return { state: 'invalid', data: null };
  const { data } = parsed;
  if (data.serverKeyId !== opts.serverKeyId) return { state: 'wrong-server', data };
  if (opts.now > data.expiresAt + LICENSE_LIMITS.graceMs) return { state: 'expired', data };
  if (opts.now > data.expiresAt) return { state: 'grace', data };
  if (opts.now >= data.expiresAt - LICENSE_LIMITS.warnBeforeMs) return { state: 'expiring', data };
  return { state: 'valid', data };
}

/** The license makes the server Enterprise (spec §1: until its validity plus 7 days). */
export function grantsEnterprise(state: LicenseState): boolean {
  return state === 'valid' || state === 'expiring' || state === 'grace';
}
