import { join } from 'node:path';
import type { JoinMode } from '@ghostlink/shared';
import { hashPassword } from '../../src/auth/password.js';
import { Db, type Row } from '../../src/db/database.js';

/**
 * Opens a second SQLite connection to a running test server's database.
 * M1 has no admin API yet (server.update, member.ban, … arrive in M3), so tests
 * set up those states directly. The server re-reads the tables on every handshake.
 */
export function withDb<T>(dataDir: string, fn: (db: Db) => T): T {
  const db = new Db(join(dataDir, 'ghostlink.db'));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function setJoinMode(dataDir: string, mode: JoinMode): void {
  withDb(dataDir, (db) => db.run('UPDATE server_meta SET join_mode = ? WHERE id = 1', mode));
}

export async function setPassword(dataDir: string, password: string | null): Promise<void> {
  const hash = password === null ? null : await hashPassword(password);
  withDb(dataDir, (db) => db.run('UPDATE server_meta SET password_hash = ? WHERE id = 1', hash));
}

export function setMaxMembers(dataDir: string, max: number): void {
  withDb(dataDir, (db) => db.run('UPDATE server_meta SET max_members = ? WHERE id = 1', max));
}

export function insertBan(dataDir: string, ban: { userId: string; publicKey?: Uint8Array; ip?: string }): void {
  withDb(dataDir, (db) => db.run(
    'INSERT INTO bans (user_id, public_key, ip, reason, banned_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ban.userId,
    ban.publicKey ?? null,
    ban.ip ?? null,
    'test',
    'test',
    Date.now(),
  ));
}

export function markRemoved(dataDir: string, userId: string, removedAt: number, rejoinBlockedUntil: number | null): void {
  withDb(dataDir, (db) => db.run('UPDATE users SET removed_at = ?, rejoin_blocked_until = ? WHERE id = ?', removedAt, rejoinBlockedUntil, userId));
}

export function getUser(dataDir: string, userId: string): Row | undefined {
  return withDb(dataDir, (db) => db.get('SELECT * FROM users WHERE id = ?', userId));
}

export function getInviteUses(dataDir: string, code: string): number {
  return withDb(dataDir, (db) => Number(db.get<{ uses: number }>('SELECT uses FROM invites WHERE code = ?', code)?.uses ?? -1));
}

export function countUsers(dataDir: string): number {
  return withDb(dataDir, (db) => Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0));
}

export function getOwner(dataDir: string): string | null {
  return withDb(dataDir, (db) => (db.get<{ owner_user_id: string | null }>('SELECT owner_user_id FROM server_meta WHERE id = 1')?.owner_user_id ?? null));
}
