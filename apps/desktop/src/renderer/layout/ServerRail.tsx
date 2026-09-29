import { useEffect, useState } from 'react';
import { House, Plus } from 'lucide-react';
import type { SavedServer } from '../../shared/ipcTypes.js';
import { useT } from '../i18n/index.js';
import { useConnectionStore } from '../stores/connection.js';
import { AddServerDialog } from './AddServerDialog.js';
import l from './layout.module.css';
import { serverInitials } from './names.js';
import { railEntries, type RailEntry } from './rail.js';
import { useLayoutSlots } from './slots.js';

/**
 * The far-left column (owner's UI reference): home (back to the server list), the
 * round "+" right below it (the "Adicionar servidor" chooser), a divider, then the
 * saved servers. One connection at a time (spec §1.3): opening another server
 * replaces this one.
 */
export function ServerRail({ currentId, onHome }: { currentId: string; onHome: () => void }) {
  const t = useT();
  const [servers, setServers] = useState<SavedServer[]>([]);
  const [adding, setAdding] = useState(false);
  const RailExtras = useLayoutSlots((s) => s.RailExtras);

  useEffect(() => {
    let alive = true;
    window.ghostlink.servers.list().then(
      (list) => alive && setServers(list),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [currentId]);

  const open = async (id: string) => {
    if (id === currentId) return;
    try {
      const welcome = await window.ghostlink.servers.connect(id);
      useConnectionStore.getState().dispatch({ type: 'joined', welcome });
    } catch {
      // The connection store already shows the failure (state "failed").
    }
  };

  const entry = (e: RailEntry) => {
    switch (e.kind) {
      case 'home':
        return (
          <div key="home" className={l.railItem}>
            <button type="button" className={`${l.railButton} ${l.railHome}`} onClick={onHome} aria-label={t('layout.home')} title={t('layout.home')}>
              <House size={20} aria-hidden="true" />
            </button>
          </div>
        );
      case 'add':
        return (
          <div key="add" className={l.railItem}>
            <button
              type="button"
              className={`${l.railButton} ${l.railAdd}`}
              onClick={() => setAdding(true)}
              aria-haspopup="dialog"
              aria-label={t('layout.addServer')}
              title={t('layout.addServer')}
            >
              <Plus size={22} aria-hidden="true" />
            </button>
          </div>
        );
      case 'divider':
        return <div key="divider" className={l.railDivider} role="separator" />;
      case 'server': {
        const s = e.server;
        const active = s.id === currentId;
        return (
          <div key={s.id} className={active ? `${l.railItem} ${l.railActive}` : l.railItem}>
            <button
              type="button"
              className={l.railButton}
              onClick={() => void open(s.id)}
              aria-label={s.name}
              aria-current={active ? 'page' : undefined}
              title={s.name}
            >
              {serverInitials(s.name)}
            </button>
          </div>
        );
      }
      case 'extras':
        return RailExtras ? <RailExtras key="extras" /> : null;
    }
  };

  return (
    <nav className={l.rail} aria-label={t('layout.servers')}>
      {railEntries(servers).map(entry)}
      {adding && <AddServerDialog onClose={() => setAdding(false)} onHome={onHome} />}
    </nav>
  );
}
