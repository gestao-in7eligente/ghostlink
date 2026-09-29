import { useEffect, useState } from 'react';
import { House, Plus } from 'lucide-react';
import type { SavedServer } from '../../shared/ipcTypes.js';
import { useT } from '../i18n/index.js';
import { useConnectionStore } from '../stores/connection.js';
import l from './layout.module.css';
import { serverInitials } from './names.js';
import { useLayoutSlots } from './slots.js';

/**
 * The far-left column: home (back to the server list), the saved servers, and "+".
 * One connection at a time (spec §1.3): opening another server replaces this one.
 */
export function ServerRail({ currentId, onHome }: { currentId: string; onHome: () => void }) {
  const t = useT();
  const [servers, setServers] = useState<SavedServer[]>([]);
  const onAddServer = useLayoutSlots((s) => s.onAddServer);
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

  return (
    <nav className={l.rail} aria-label={t('layout.servers')}>
      <div className={l.railItem}>
        <button type="button" className={`${l.railButton} ${l.railHome}`} onClick={onHome} aria-label={t('layout.home')} title={t('layout.home')}>
          <House size={20} aria-hidden="true" />
        </button>
      </div>
      {/* Owner requirement: "+" right below the home button; it opens "Adicionar servidor". */}
      <div className={l.railItem}>
        <button
          type="button"
          className={`${l.railButton} ${l.railAdd}`}
          onClick={onAddServer ?? onHome}
          aria-label={t('layout.addServer')}
          title={t('layout.addServer')}
        >
          <Plus size={22} aria-hidden="true" />
        </button>
      </div>
      <div className={l.railDivider} role="separator" />
      {servers.map((s) => {
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
      })}
      {RailExtras && <RailExtras />}
    </nav>
  );
}
