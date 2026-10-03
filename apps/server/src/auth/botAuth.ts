import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { BOT_LIMITS, fromBase64Url, type ErrorCode, type ErrorEventExtra } from '@ghostlink/shared';
import type { Db } from '../db/database.js';
import { getMeta } from '../db/serverMeta.js';
import { deletionRefusal } from '../deletion/state.js';

/**
 * A bot's connection token (bots spec §2): 256 random bits, shown once in the connection code.
 * The server keeps only its SHA-256. A secret: never log it nor its hash.
 */
export function newBotToken(): { token: string; hash: Buffer } {
  const raw = randomBytes(BOT_LIMITS.tokenBytes);
  return { token: raw.toString('base64url'), hash: createHash('sha256').update(raw).digest() };
}

/** SHA-256 of the token's bytes; null when it is not base64url of 32 bytes. */
export function botTokenHash(token: string): Buffer | null {
  let raw: Uint8Array;
  try {
    raw = fromBase64Url(token);
  } catch {
    return null;
  }
  if (raw.length !== BOT_LIMITS.tokenBytes) return null;
  return createHash('sha256').update(raw).digest();
}

/**
 * The bot whose token this is, or null. Compares against every bot's hash in constant time
 * per entry and without stopping early (at most BOT_LIMITS.maxBots rows).
 */
export function findBotByToken(db: Db, token: string): string | null {
  const hash = botTokenHash(token);
  if (hash === null) return null;
  let found: string | null = null;
  for (const row of db.all<{ user_id: string; token_hash: Uint8Array }>('SELECT user_id, token_hash FROM bots')) {
    const stored = Buffer.from(row.token_hash);
    if (stored.length === hash.length && timingSafeEqual(stored, hash) && found === null) found = row.user_id;
  }
  return found;
}

export type BotAdmission =
  | { ok: true; user: { id: string; nickname: string } }
  | { ok: false; code: ErrorCode; countsAsFailure: boolean; extra?: ErrorEventExtra };

/**
 * Lets a bot with a valid token in (bots spec §2), with a member's rules: refused when banned,
 * within a kick's rejoin block, or while the server is being deleted; a bot kicked earlier
 * comes back as a member once the block is over. No invite, password or member limit.
 */
export function admitBot(db: Db, botId: string, now: number): BotAdmission {
  return db.tx((): BotAdmission => {
    const deletion = deletionRefusal(getMeta(db), now, botId);
    if (deletion) {
      return { ok: false, code: deletion.code, countsAsFailure: false, ...(deletion.code === 'SERVER_DELETING' ? { extra: { at: deletion.at } } : {}) };
    }
    if (db.get('SELECT 1 AS x FROM bans WHERE user_id = ?', botId)) return { ok: false, code: 'BANNED', countsAsFailure: true };
    // The company's own Hermes needs an Enterprise server (spec 2026-10-02-enterprise-e-hermes-da-empresa
    // §1); the enterprise module keeps `enterprise.edition` up to date.
    if (
      db.get(
        `SELECT 1 AS x FROM company_hermes WHERE bot_id = ?
         AND NOT EXISTS (SELECT 1 FROM enterprise WHERE id = 1 AND edition = 'enterprise')`,
        botId,
      )
    ) {
      return { ok: false, code: 'ENTERPRISE_REQUIRED', countsAsFailure: false };
    }
    const user = db.get<{ nickname: string; removed_at: number | null; rejoin_blocked_until: number | null }>(
      'SELECT nickname, removed_at, rejoin_blocked_until FROM users WHERE id = ? AND is_bot = 1',
      botId,
    );
    if (!user) return { ok: false, code: 'BAD_BOT_TOKEN', countsAsFailure: true };
    if (user.removed_at !== null && user.rejoin_blocked_until !== null && Number(user.rejoin_blocked_until) > now) {
      return { ok: false, code: 'REJOIN_BLOCKED', countsAsFailure: false };
    }
    db.run('UPDATE users SET removed_at = NULL, rejoin_blocked_until = NULL, last_seen_at = ? WHERE id = ?', now, botId);
    return { ok: true, user: { id: botId, nickname: user.nickname } };
  });
}
