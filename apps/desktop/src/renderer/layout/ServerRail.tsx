import { useEffect, useState } from 'react';
import { House, Plus } from 'lucide-react';
import type { AppErrorCode } from '../../shared/appErrors.js';
import type { SavedServer } from '../../shared/ipcTypes.js';
import { errorCodeOf, useT } from '../i18n/index.js';
import { useConnectionStore } from '../stores/connection.js';
import { AddServerDialog } from './AddServerDialog.js';
import l from './layout.module.css';
import { serverInitials } from './names.js';
import { ConfirmDialog, Menu, MenuItem } from './primitives.js';
import { railEntries, type RailEntry } from './rail.js';
import { useLayoutSlots } from './slots.js';

/**
 * The far-left column (owner's UI reference): home (back to the server list), the
 * round "+" right below it (the "Adicionar servidor" chooser), a divider, then the
 * saved servers. One connection at a time (spec §1.3): opening another server
 * replaces this one. A right-click on a server that is not open offers "Remover da lista".
 */
export function ServerRail({
  currentId,
  onHome,
  homeActive = false,
  onOpenFailed,
}: {
  currentId: string;
  onHome: () => void;
  /** The Home screen is open: the home button shows as selected. */
  homeActive?: boolean;
  /** Home screen: why a server could not be opened (null when a new attempt starts). */
  onOpenFailed?: (code: AppErrorCode | null) => void;
}) {
  const t = useT();
  const [servers, setServers] = useState<SavedServer[]>([]);
  const [adding, setAdding] = useState(false);
  const [menu, setMenu] = useState<{ server: SavedServer; x: number; y: number } | null>(null);
  const [removing, setRemoving] = useState<SavedServer | null>(null);
  const [listVersion, setListVersion] = useState(0);
  const RailExtras = useLayoutSlots((s) => s.RailExtras);
  const onOpenServer = useLayoutSlots((s) => s.onOpenServer);

  useEffect(() => {
    let alive = true;
    window.ghostlink.servers.list().then(
      (list) => alive && setServers(list),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [currentId, listVersion]);

  const open = async (id: string) => {
    if (id === currentId) return;
    const server = servers.find((s) => s.id === id);
    if (server && onOpenServer?.(server)) return;
    onOpenFailed?.(null);
    try {
      const welcome = await window.ghostlink.servers.connect(id);
      useConnectionStore.getState().dispatch({ type: 'joined', welcome });
    } catch (e) {
      // In a server, the connection store shows the failure (state "failed"); the Home screen has its own line.
      onOpenFailed?.(errorCodeOf(e));
    }
  };

  const remove = async (server: SavedServer) => {
    await window.ghostlink.servers.remove(server.id);
    setListVersion((n) => n + 1);
  };

  const entry = (e: RailEntry) => {
    switch (e.kind) {
      case 'home':
        return (
          <div key="home" className={homeActive ? `${l.railItem} ${l.railActive}` : l.railItem}>
            <button type="button" className={`${l.railButton} ${l.railHome}`} onClick={onHome} aria-label={t('layout.home')} title={t('layout.home')} aria-current={homeActive ? 'page' : undefined}>
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
              onContextMenu={(event) => {
                event.preventDefault();
                if (!active) setMenu({ server: s, x: event.clientX, y: event.clientY });
              }}
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
      {menu && (
        <Menu anchor={{ x: menu.x, y: menu.y }} label={t('rail.server.menu', { name: menu.server.name })} onClose={() => setMenu(null)}>
          <MenuItem
            danger
            onSelect={() => {
              setRemoving(menu.server);
              setMenu(null);
            }}
          >
            {t('home.remove')}
          </MenuItem>
        </Menu>
      )}
      {removing && (
        <ConfirmDialog
          title={t('home.removeConfirm', { name: removing.name })}
          body={t('home.removeBody')}
          confirmLabel={t('home.remove')}
          onConfirm={() => remove(removing)}
          onClose={() => setRemoving(null)}
        />
      )}
    </nav>
  );
}
