import type { Edition } from '@ghostlink/shared';
import type { Db } from '../../src/db/database.js';
import { ENTERPRISE_MODULE_NAME, type EnterpriseModule } from '../../src/enterprise/index.js';

/**
 * An enterprise module whose edition the test sets (no license): for modules that only read the
 * edition. Writes `enterprise.edition` as the real module does, so the bot handshake sees it.
 */
export function fakeEnterprise(initial: Edition = 'enterprise'): EnterpriseModule & { set(edition: Edition): void } {
  let edition = initial;
  let db: Db | null = null;
  const listeners = new Set<(e: Edition) => void>();
  const write = () => db?.run("INSERT INTO enterprise (id, edition) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET edition = excluded.edition", edition);
  return {
    name: ENTERPRISE_MODULE_NAME,
    get edition() {
      return edition;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    recheck() {},
    init(ctx) {
      db = ctx.db;
      write();
    },
    set(next) {
      if (next === edition) return;
      edition = next;
      write();
      for (const listener of [...listeners]) listener(next);
    },
  };
}
