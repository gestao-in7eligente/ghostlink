import { normalizeInviteCode, type ErrorCode, type ErrorEventExtra } from '@ghostlink/shared';
import type { Db } from '../db/database.js';
import { getMeta } from '../db/serverMeta.js';
import { deletionRefusal } from '../deletion/state.js';
import { consumeInviteTx } from '../invites/invites.js';
import type { SlidingWindowLimiter } from '../ratelimit/limiter.js';
import { verifyPassword } from './password.js';
import { checkSetupCode, consumeSetupCode } from './setupCode.js';

export interface AdmissionRequest {
  userId: string;
  publicKey: Uint8Array;
  nickname: { display: string; norm: string };
  locale: string;
  /** Stored as last_ip; null behind a TCP proxy, where it would be the proxy's (spec §13). */
  ip: string | null;
  ipKey: string;
  password?: string;
  inviteCode?: string;
  setupCode?: string;
}

export interface AdmissionDeps {
  db: Db;
  dataDir: string;
  now: () => number;
  newIdentities: SlidingWindowLimiter;
}

export type AdmissionResult =
  | { ok: true; user: { id: string; nickname: string; isOwner: boolean }; created: boolean }
  | { ok: false; code: ErrorCode; countsAsFailure: boolean; extra?: ErrorEventExtra };

/** Codes caused by a bad credential; they count toward the per-IP auth-failure limit (spec §13). */
const CREDENTIAL_FAILURES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'BANNED', 'BAD_SETUP_CODE', 'BAD_PASSWORD', 'INVITE_REQUIRED', 'INVITE_INVALID',
]);

class Rejected extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly extra?: ErrorEventExtra,
  ) {
    super(code);
  }
}

function reject(code: ErrorCode, extra?: ErrorEventExtra): AdmissionResult {
  return extra === undefined
    ? { ok: false, code, countsAsFailure: CREDENTIAL_FAILURES.has(code) }
    : { ok: false, code, countsAsFailure: CREDENTIAL_FAILURES.has(code), extra };
}

interface UserRow {
  id: string;
  nickname: string;
  removed_at: number | null;
  rejoin_blocked_until: number | null;
}

/**
 * Decides whether a verified identity may enter (spec §3.3/§3.5/§7). Everything
 * slow (scrypt) happens first; then ONE synchronous transaction re-reads the
 * state, consumes the invite, checks max_members, the new-identities-per-IP
 * limit and nickname uniqueness, and inserts or reactivates the user. Any
 * rejection inside the transaction rolls it back, giving the invite use back.
 */
export async function admit(req: AdmissionRequest, deps: AdmissionDeps): Promise<AdmissionResult> {
  const { db } = deps;
  const banned = db.get(
    'SELECT 1 AS x FROM bans WHERE user_id = ? OR public_key = ? OR (ip IS NOT NULL AND ip = ?) LIMIT 1',
    req.userId,
    req.publicKey,
    req.ipKey,
  );
  if (banned) return reject('BANNED');

  const wantsOwner = req.setupCode !== undefined;
  if (wantsOwner && !checkSetupCode(db, req.setupCode!)) return reject('BAD_SETUP_CODE');

  const existing = db.get<UserRow>('SELECT id, nickname, removed_at, rejoin_blocked_until FROM users WHERE public_key = ?', req.publicKey);
  const isMember = existing !== undefined && existing.removed_at === null;

  if (existing && !isMember && existing.rejoin_blocked_until !== null && existing.rejoin_blocked_until > deps.now()) {
    return reject('REJOIN_BLOCKED');
  }

  const meta = getMeta(db);
  let inviteCode: string | null = null;
  if (!isMember && !wantsOwner) {
    if (meta.joinMode === 'password') {
      if (req.password === undefined || meta.passwordHash === null) return reject('BAD_PASSWORD');
      if (!(await verifyPassword(req.password, meta.passwordHash))) return reject('BAD_PASSWORD');
    } else if (meta.joinMode === 'invite') {
      if (req.inviteCode === undefined) return reject('INVITE_REQUIRED');
      inviteCode = normalizeInviteCode(req.inviteCode);
      if (inviteCode === null) return reject('INVITE_INVALID');
    }
  }

  const now = deps.now();
  try {
    return db.tx((): AdmissionResult => {
      const current = getMeta(db);
      // The handshake checked before the slow part; a server.delete may have run since. Inside
      // the transaction, so a refusal gives the invite use back.
      const deletion = deletionRefusal(current, now, req.userId);
      if (deletion) throw new Rejected(deletion.code, deletion.code === 'SERVER_DELETING' ? { at: deletion.at } : undefined);
      if (isMember) {
        db.run('UPDATE users SET last_seen_at = ?, last_ip = ?, locale = ? WHERE id = ?', now, req.ip, req.locale, existing.id);
        if (wantsOwner && !consumeSetupCode(db, deps.dataDir, req.setupCode!, existing.id)) throw new Rejected('BAD_SETUP_CODE');
        const isOwner = wantsOwner || current.ownerUserId === existing.id;
        return { ok: true, user: { id: existing.id, nickname: existing.nickname, isOwner }, created: false };
      }

      if (inviteCode !== null && !consumeInviteTx(db, inviteCode, now)) throw new Rejected('INVITE_INVALID');
      if (!wantsOwner) {
        // Bots do not take a member's place (bots spec §2; BOT_LIMITS.maxBots caps them).
        const active = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE removed_at IS NULL AND is_bot = 0');
        if (Number(active?.n ?? 0) >= current.maxMembers) throw new Rejected('SERVER_FULL');
        if (!existing && !deps.newIdentities.peek(req.ipKey)) throw new Rejected('RATE_LIMITED');
      }
      const taken = db.get('SELECT 1 AS x FROM users WHERE nickname_norm = ? AND id <> ?', req.nickname.norm, req.userId);
      if (taken) throw new Rejected('NICK_TAKEN');

      if (existing) {
        db.run(
          `UPDATE users SET nickname = ?, nickname_norm = ?, locale = ?, last_seen_at = ?, last_ip = ?,
             removed_at = NULL, rejoin_blocked_until = NULL WHERE id = ?`,
          req.nickname.display, req.nickname.norm, req.locale, now, req.ip, existing.id,
        );
      } else {
        db.run(
          `INSERT INTO users (id, public_key, nickname, nickname_norm, locale, joined_at, last_seen_at, last_ip)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          req.userId, req.publicKey, req.nickname.display, req.nickname.norm, req.locale, now, now, req.ip,
        );
      }
      // Last step: nothing after it can fail, so the setup-code file is only deleted on success.
      if (wantsOwner && !consumeSetupCode(db, deps.dataDir, req.setupCode!, req.userId)) throw new Rejected('BAD_SETUP_CODE');
      if (!existing && !wantsOwner) deps.newIdentities.hit(req.ipKey);
      const isOwner = wantsOwner || current.ownerUserId === req.userId;
      return { ok: true, user: { id: req.userId, nickname: req.nickname.display, isOwner }, created: !existing };
    });
  } catch (e) {
    if (e instanceof Rejected) return reject(e.code, e.extra);
    throw e;
  }
}
