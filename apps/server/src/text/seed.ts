import { DEFAULT_EVERYONE_PERMISSIONS, EVERYONE_POSITION, PERMISSIONS } from '@ghostlink/shared';
import type { Db } from '../db/database.js';
import { newEntityId } from './repo.js';

export const ADMIN_SYSTEM_TAG = 'admin';

/** Default names; the owner may rename them. The UI shows `@everyone` as "@todos" in pt-BR. */
export const SEED = {
  everyoneName: '@todos',
  adminName: 'Admin',
  textChannel: 'geral',
  voiceChannel: 'Sala de voz',
  /** Red and not hoisted, like the "Admin" badge of the owner's UI reference. */
  adminColor: 0xed4245,
} as const;

/**
 * First run (spec §6, §7): `@todos` with DEFAULT_EVERYONE_PERMISSIONS (no
 * CREATE_INVITES), `Admin` with ADMINISTRATOR, a text channel `geral` and a
 * voice channel `Sala de voz`. Idempotent: does nothing once `@todos` exists.
 */
export function seedDefaults(db: Db, now: number): void {
  db.tx(() => {
    if (db.get('SELECT 1 AS x FROM roles WHERE is_default = 1')) return;
    db.run(
      `INSERT INTO roles (id, name, color, permissions, position, hoist, mentionable, is_default)
       VALUES (?, ?, 0, ?, ?, 0, 0, 1)`,
      newEntityId(), SEED.everyoneName, DEFAULT_EVERYONE_PERMISSIONS, EVERYONE_POSITION,
    );
    db.run(
      `INSERT INTO roles (id, name, color, permissions, position, hoist, mentionable, is_default, system_tag)
       VALUES (?, ?, ?, ?, 1, 0, 0, 0, ?)`,
      newEntityId(), SEED.adminName, SEED.adminColor, PERMISSIONS.ADMINISTRATOR, ADMIN_SYSTEM_TAG,
    );
    if (!db.get('SELECT 1 AS x FROM channels LIMIT 1')) {
      db.run('INSERT INTO channels (id, name, type, position, created_at) VALUES (?, ?, ?, 0, ?)', newEntityId(), SEED.textChannel, 'text', now);
      db.run('INSERT INTO channels (id, name, type, position, created_at) VALUES (?, ?, ?, 1, ?)', newEntityId(), SEED.voiceChannel, 'voice', now);
    }
  });
}
