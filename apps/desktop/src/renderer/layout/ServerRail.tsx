import { useEffect, useState } from 'react';
import { House, LogOut, Plus, Trash2, Volume2 } from 'lucide-react';
import type { AppErrorCode } from '../../shared/appErrors.js';
import { DEFAULT_NOTIFY_MODE, NOTIFY_MODES, type NotifyMode, type SavedServer } from '../../shared/ipcTypes.js';
import { useOpenServerExit } from '../features/serverDelete/DeletionBanner.js';
import { exitMenuItem, type ServerExitAction } from '../features/serverDelete/serverDeleteModel.js';
import { ExitServerDialog } from '../features/serverDelete/ServerExitDialogs.js';
import { callServerId, useVoiceStore } from '../features/voice/state.js';
import { errorCodeOf, useT } from '../i18n/index.js';
import { cachedWelcome, useConnectionStore } from '../stores/connection.js';
import { useSavedListStore } from '../stores/savedList.js';
import { AddServerDialog } from './AddServerDialog.js';
import l from './layout.module.css';
import { Menu, MenuHeading, MenuItem, MenuRadio, MenuSeparator, ServerIcon } from './primitives.js';
import { railEntries, type RailEntry } from './rail.js';
import { useLayoutSlots } from './slots.js';

/** Grows on every server switch, so a slow connect that lands after a newer switch is dropped. */
let openSeq = 0;

/**
 * The far-left column (owner's UI reference): home (back to the server list), the
 * round "+" right below it (the "Adicionar servidor" chooser), a divider, then the
 * saved servers. `currentId` is the server on screen: opening another one replaces it,
 * except the voice call's, which stays connected (chamada-continua §1) and carries a
 * green speaker; opening that one again is instant. A right-click on a server chooses which
 * of its messages raise a notification (notifications spec §1) and offers its way out
 * (leave/delete spec §2): "Sair do servidor", or "Excluir servidor" for the owner of the open server.
 */
export function ServerRail({
  currentId,
  onHome,
  homeActive = false,
  onCurrentExit,
  onOpenFailed,
}: {
  currentId: string;
  onHome: () => void;
  /** The Home screen is open: the home button shows as selected. */
  homeActive?: boolean;
  /** The open server's leave or delete dialog (the main layout owns them). */
  onCurrentExit?: (action: ServerExitAction) => void;
  /** Home screen: why a server could not be opened, and which one (null when a new attempt starts). */
  onOpenFailed?: (failure: { code: AppErrorCode; server: SavedServer } | null) => void;
}) {
  const t = useT();
  const [servers, setServers] = useState<SavedServer[]>([]);
  const [adding, setAdding] = useState(false);
  const [menu, setMenu] = useState<{ server: SavedServer; action: ServerExitAction | null; at: { x: number; y: number } } | null>(null);
  const [exiting, setExiting] = useState<SavedServer | null>(null);
  const RailExtras = useLayoutSlots((s) => s.RailExtras);
  const onOpenServer = useLayoutSlots((s) => s.onOpenServer);
  const listRevision = useSavedListStore((s) => s.revision);
  const openExit = useOpenServerExit();
  const callId = useVoiceStore(callServerId);

  useEffect(() => {
    let alive = true;
    window.ghostlink.servers.list().then(
      (list) => alive && setServers(list),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [currentId, listRevision]);

  /** The open server's menu knows its owner; any other one says "Sair" and its dialog connects first. */
  const exitFor = (server: SavedServer): ServerExitAction | null =>
    server.id === currentId && onCurrentExit ? openExit : exitMenuItem({ connected: false, owner: false, canDelete: false });

  /** Kept with the saved server, on this computer; the rail and the chat read the list again. */
  const setNotify = (server: SavedServer, mode: NotifyMode) => {
    setMenu(null);
    if ((server.notify ?? DEFAULT_NOTIFY_MODE) === mode) return;
    window.ghostlink.servers.setNotify(server.id, mode).then(
      () => useSavedListStore.getState().changed(),
      () => undefined,
    );
  };

  const open = async (id: string) => {
    if (id === currentId) return;
    const server = servers.find((s) => s.id === id);
    if (server && onOpenServer?.(server)) return;
    onOpenFailed?.(null);
    const seq = ++openSeq;
    // Instant switch: paint the server's last snapshot (in memory) while the real connection refreshes it.
    const cached = cachedWelcome(id);
    const previous = useConnectionStore.getState().welcome;
    if (cached) useConnectionStore.getState().dispatch({ type: 'joined', welcome: cached });
    try {
      const welcome = await window.ghostlink.servers.connect(id);
      if (seq !== openSeq) return; // a newer switch already took over
      useConnectionStore.getState().dispatch({ type: 'joined', welcome });
    } catch (e) {
      // Drop the cached paint so stale content is never shown as live: back to where we were, or Home.
      if (seq === openSeq && cached) useConnectionStore.getState().dispatch(previous ? { type: 'joined', welcome: previous } : { type: 'left' });
      // In a server, the connection store shows the failure (state "failed"); the Home screen has its own line.
      if (server) onOpenFailed?.({ code: errorCodeOf(e), server });
    }
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
        const call = s.id === callId;
        return (
          <div key={s.id} className={active ? `${l.railItem} ${l.railActive}` : l.railItem} data-call={call || undefined}>
            <button
              type="button"
              className={l.railButton}
              onClick={() => void open(s.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ server: s, action: exitFor(s), at: { x: event.clientX, y: event.clientY } });
              }}
              aria-label={s.name}
              aria-current={active ? 'page' : undefined}
              title={call ? `${s.name} · ${t('voice.callHere')}` : s.name}
            >
              <ServerIcon name={s.name} hash={s.iconHash} className={l.railIcon} />
            </button>
            {call && (
              <span className={l.railCall} aria-hidden="true">
                <Volume2 size={10} strokeWidth={2.5} />
              </span>
            )}
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
        <Menu anchor={menu.at} label={t('serverExit.menu', { name: menu.server.name })} onClose={() => setMenu(null)}>
          <div role="group" aria-label={t('notifications.title')}>
            <MenuHeading>{t('notifications.title')}</MenuHeading>
            {NOTIFY_MODES.map((mode) => (
              <MenuRadio key={mode} checked={(menu.server.notify ?? DEFAULT_NOTIFY_MODE) === mode} onSelect={() => setNotify(menu.server, mode)}>
                {t(`notifications.mode.${mode}`)}
              </MenuRadio>
            ))}
          </div>
          {menu.action !== null && (
            <>
              <MenuSeparator />
              <MenuItem
                danger
                icon={menu.action === 'delete' ? <Trash2 size={16} aria-hidden="true" /> : <LogOut size={16} aria-hidden="true" />}
                onSelect={() => {
                  const { server, action } = menu;
                  setMenu(null);
                  if (action === null) return;
                  if (server.id === currentId && onCurrentExit) onCurrentExit(action);
                  else setExiting(server);
                }}
              >
                {menu.action === 'delete' ? t('serverExit.delete') : t('layout.leave')}
              </MenuItem>
            </>
          )}
        </Menu>
      )}
      {exiting && <ExitServerDialog server={exiting} onClose={() => setExiting(null)} onChanged={() => useSavedListStore.getState().changed()} />}
    </nav>
  );
}
