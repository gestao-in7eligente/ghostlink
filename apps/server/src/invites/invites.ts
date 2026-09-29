import { randomBytes } from 'node:crypto';
import {
  ProtocolError,
  formatInviteLink,
  formatPasteCode,
  formatWebLink,
  toBase32,
  type InvitePayload,
} from '@ghostlink/shared';
import type { Db } from '../db/database.js';
import { WEB_SITE_BASE } from '../version.js';

export interface InviteInfo {
  code: string;
  link: string;
  pasteCode: string;
  webLink: string;
}

export interface CreateInviteOptions {
  maxUses?: number;
  expiresInHours?: number;
  createdBy?: string | null;
  now: number;
}

const MAX_USES_LIMIT = 10_000;
const MAX_EXPIRY_HOURS = 24 * 365;

/** 10 random base32 characters = 50 bits (spec §3.5). */
function randomCode(): string {
  return toBase32(randomBytes(7)).slice(0, 10);
}

export function createInvite(db: Db, opts: CreateInviteOptions): { code: string } {
  const { maxUses, expiresInHours } = opts;
  if (maxUses !== undefined && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > MAX_USES_LIMIT)) {
    throw new ProtocolError('BAD_REQUEST', `maxUses must be an integer between 1 and ${MAX_USES_LIMIT}`);
  }
  if (expiresInHours !== undefined && (!Number.isFinite(expiresInHours) || expiresInHours <= 0 || expiresInHours > MAX_EXPIRY_HOURS)) {
    throw new ProtocolError('BAD_REQUEST', `expiresInHours must be between 0 and ${MAX_EXPIRY_HOURS}`);
  }
  const expiresAt = expiresInHours === undefined ? null : opts.now + Math.round(expiresInHours * 3_600_000);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const r = db.run(
      'INSERT OR IGNORE INTO invites (code, created_by, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?)',
      code,
      opts.createdBy ?? null,
      opts.now,
      expiresAt,
      maxUses ?? null,
    );
    if (r.changes === 1) return { code };
  }
  throw new Error('could not generate a unique invite code');
}

/**
 * Consumes one use atomically (spec §3.5). Must run inside `db.tx` together with
 * the membership insert, so a later failure in that transaction gives the use back.
 */
export function consumeInviteTx(db: Db, code: string, now: number): boolean {
  if (!db.inTransaction) throw new Error('consumeInviteTx must be called inside db.tx');
  const r = db.run(
    `UPDATE invites SET uses = uses + 1
     WHERE code = ? AND revoked = 0
       AND (max_uses IS NULL OR uses < max_uses)
       AND (expires_at IS NULL OR expires_at > ?)`,
    code,
    now,
  );
  return r.changes === 1;
}

export function buildInviteInfo(code: string, meta: { addresses: string[]; serverKeyId: string; name: string }): InviteInfo {
  const payload: InvitePayload = { addresses: meta.addresses, serverKeyId: meta.serverKeyId, inviteCode: code, name: meta.name };
  return {
    code,
    link: formatInviteLink(payload),
    pasteCode: formatPasteCode(payload),
    webLink: formatWebLink(payload, WEB_SITE_BASE),
  };
}
