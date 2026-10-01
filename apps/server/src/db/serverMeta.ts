import type { JoinMode } from '@ghostlink/shared';
import type { Db } from './database.js';

export interface ServerMeta {
  name: string;
  /** The icon's SHA-256 (hex), or null (spec 2026-10-01-icone-do-servidor); the file lives with the photos. */
  icon: string | null;
  joinMode: JoinMode;
  passwordHash: string | null;
  ownerUserId: string | null;
  setupCodeHash: string | null;
  publicAddresses: string[];
  maxMembers: number;
  createdAt: number;
  /** The deletion deadline while the server is being deleted (spec "sair e excluir servidor" §3), else null. */
  deletingAt: number | null;
  /** When the data was erased; never cleared. */
  deletedAt: number | null;
}

interface MetaRow {
  name: string;
  icon_file_id: string | null;
  join_mode: JoinMode;
  password_hash: string | null;
  owner_user_id: string | null;
  setup_code_hash: string | null;
  public_addresses: string;
  max_members: number;
  created_at: number;
  deleting_at: number | null;
  deleted_at: number | null;
}

function parseAddresses(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((a): a is string => typeof a === 'string') : [];
  } catch {
    return [];
  }
}

export function getMeta(db: Db): ServerMeta {
  const row = db.get<MetaRow>('SELECT * FROM server_meta WHERE id = 1');
  if (!row) throw new Error('server_meta is missing; call ensureMeta first');
  return {
    name: row.name,
    icon: row.icon_file_id,
    joinMode: row.join_mode,
    passwordHash: row.password_hash,
    ownerUserId: row.owner_user_id,
    setupCodeHash: row.setup_code_hash,
    publicAddresses: parseAddresses(row.public_addresses),
    maxMembers: Number(row.max_members),
    createdAt: Number(row.created_at),
    deletingAt: row.deleting_at === null ? null : Number(row.deleting_at),
    deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
  };
}

/** Seeds the single server_meta row on first run; later runs keep the stored name, join mode and member limit. */
export function ensureMeta(db: Db, init: { name: string; joinMode: JoinMode; maxMembers?: number; now: number }): ServerMeta {
  db.run(
    'INSERT OR IGNORE INTO server_meta (id, name, join_mode, max_members, created_at) VALUES (1, ?, ?, ?, ?)',
    init.name,
    init.joinMode,
    init.maxMembers ?? 100,
    init.now,
  );
  return getMeta(db);
}

export function setPublicAddresses(db: Db, addresses: readonly string[]): void {
  db.run('UPDATE server_meta SET public_addresses = ? WHERE id = 1', JSON.stringify(addresses));
}
