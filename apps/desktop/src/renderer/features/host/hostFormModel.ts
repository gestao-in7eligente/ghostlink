import { DEFAULT_PORT } from '@ghostlink/shared';
import type { HostConfig, HostInviteOptions, HostJoinMode } from '../../../shared/hostTypes.js';

/** The form keeps what the person typed; numbers are parsed on submit. */
export interface HostForm {
  name: string;
  port: string;
  joinMode: HostJoinMode;
  maxMembers: string;
}

export type HostFormField = 'name' | 'port' | 'maxMembers';

export const HOST_NAME_MAX_LENGTH = 64;
export const DEFAULT_MAX_MEMBERS = 100;

/** Prefilled with the last hosted server (same name = same server), else the defaults (spec §9). */
export function initialHostForm(last: HostConfig | null, defaultName: string): HostForm {
  if (last) return { name: last.name, port: String(last.port), joinMode: last.joinMode, maxMembers: String(last.maxMembers) };
  return { name: defaultName.slice(0, HOST_NAME_MAX_LENGTH), port: String(DEFAULT_PORT), joinMode: 'invite', maxMembers: String(DEFAULT_MAX_MEMBERS) };
}

function wholeNumber(text: string, min: number, max: number): number | null {
  const t = text.trim();
  if (!/^\d{1,6}$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
}

/** The first invalid field, or the config to send (the main process validates again). */
export function validateHostForm(form: HostForm): { ok: true; config: HostConfig } | { ok: false; field: HostFormField } {
  const name = form.name.trim();
  if (name === '' || name.length > HOST_NAME_MAX_LENGTH) return { ok: false, field: 'name' };
  const port = wholeNumber(form.port, 1024, 65535);
  if (port === null) return { ok: false, field: 'port' };
  const maxMembers = wholeNumber(form.maxMembers, 1, 10_000);
  if (maxMembers === null) return { ok: false, field: 'maxMembers' };
  return { ok: true, config: { name, port, joinMode: form.joinMode, maxMembers } };
}

/** The invite options offered in the Host panel. */
export const INVITE_EXPIRY_CHOICES = ['1', '24', '168', 'never'] as const;
export const INVITE_USES_CHOICES = ['1', '10', 'unlimited'] as const;
export type InviteExpiryChoice = (typeof INVITE_EXPIRY_CHOICES)[number];
export type InviteUsesChoice = (typeof INVITE_USES_CHOICES)[number];

export function inviteOptions(expiry: InviteExpiryChoice, uses: InviteUsesChoice): HostInviteOptions {
  const opts: HostInviteOptions = {};
  if (expiry !== 'never') opts.expiresInHours = Number(expiry);
  if (uses !== 'unlimited') opts.maxUses = Number(uses);
  return opts;
}
