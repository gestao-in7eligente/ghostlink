import type { Db } from '../db/database.js';
import type { ServerMeta } from '../db/serverMeta.js';

/**
 * Where a server stands in its deletion (spec 2026-10-01-sair-e-excluir-servidor-design.md §3):
 *   - `active`: normal;
 *   - `deleting`: offline for everyone but the owner until `at`, then erased;
 *   - `deleted`: the deadline passed (erased, or about to be at the next check); everyone is refused.
 * The deadline is always judged by the server's clock (spec §4).
 */
export type DeletionState =
  | { phase: 'active' }
  | { phase: 'deleting'; at: number }
  | { phase: 'deleted' };

export function deletionState(meta: Pick<ServerMeta, 'deletingAt' | 'deletedAt'>, now: number): DeletionState {
  if (meta.deletedAt !== null) return { phase: 'deleted' };
  if (meta.deletingAt === null) return { phase: 'active' };
  return now >= meta.deletingAt ? { phase: 'deleted' } : { phase: 'deleting', at: meta.deletingAt };
}

/** Sets the deadline unless one is already set or the data is already gone; returns the deadline in force (null once deleted). */
export function markDeleting(db: Db, at: number): number | null {
  db.run('UPDATE server_meta SET deleting_at = ? WHERE id = 1 AND deleting_at IS NULL AND deleted_at IS NULL', at);
  const row = db.get<{ deleting_at: number | null; deleted_at: number | null }>('SELECT deleting_at, deleted_at FROM server_meta WHERE id = 1');
  return row && row.deleted_at === null && row.deleting_at !== null ? Number(row.deleting_at) : null;
}

/** Clears the deadline (restore); a no-op once the data is gone. True when a deadline was cleared. */
export function clearDeleting(db: Db): boolean {
  return db.run('UPDATE server_meta SET deleting_at = NULL WHERE id = 1 AND deleting_at IS NOT NULL AND deleted_at IS NULL').changes > 0;
}

export type DeletionRefusal = { code: 'SERVER_DELETING'; at: number } | { code: 'SERVER_DELETED' };

/**
 * Whether the handshake must refuse `userId` (spec §3.3): while the deadline runs everyone but
 * the owner, with the deadline; after it everyone. Null when they may go on.
 */
export function deletionRefusal(meta: Pick<ServerMeta, 'deletingAt' | 'deletedAt' | 'ownerUserId'>, now: number, userId: string): DeletionRefusal | null {
  const state = deletionState(meta, now);
  if (state.phase === 'deleted') return { code: 'SERVER_DELETED' };
  if (state.phase === 'deleting' && userId !== meta.ownerUserId) return { code: 'SERVER_DELETING', at: state.at };
  return null;
}
