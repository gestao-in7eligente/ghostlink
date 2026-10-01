import { useEffect, useRef, useState } from 'react';
import { EllipsisVertical, KeyRound, LogOut, MessageCircle, Play, Plus, Search, Server } from 'lucide-react';
import type { RendererWelcome, SavedServer } from '../../shared/ipcTypes.js';
import { GhostMark } from '../components/GhostMark.js';
import { useHostStore } from '../features/host/hostStore.js';
import { openHostFlow, openHostPanel } from '../features/host/hostUi.js';
import { openIdentitySettings } from '../features/identity/identityModel.js';
import { deletionMessage } from '../features/serverDelete/serverDeleteModel.js';
import { ExitServerDialog } from '../features/serverDelete/ServerExitDialogs.js';
import { errorCodeOf, errorMessage, useT } from '../i18n/index.js';
import { AddServerDialog } from '../layout/AddServerDialog.js';
import l from '../layout/layout.module.css';
import { serverInitials } from '../layout/names.js';
import { Menu, MenuItem, MenuSeparator } from '../layout/primitives.js';
import { ServerRail } from '../layout/ServerRail.js';
import { UserPanel } from '../layout/UserPanel.js';
import { UserSettings } from '../layout/UserSettings.js';
import { useConnectionStore } from '../stores/connection.js';
import { useSavedListStore } from '../stores/savedList.js';
import { useSettingsStore } from '../stores/settings.js';
import { filterHomeRows, homeActivity, homeServerRows, type HomeActivity, type HomeServerRow, type HomeTab } from './homeModel.js';
import h from './home.module.css';

/**
 * The Home screen, laid out like Discord's "Amigos" page (owner's reference, 2026-09-29):
 * rail · sidebar (search, identity, "Seus servidores"; creating and joining are the
 * rail's "+", owner's request) · the server list with tabs,
 * search and row actions · "Ativo agora" (the server hosted here). GhostLink has no
 * accounts, so the saved servers stand where Discord lists friends.
 */
export function HomeLayout({ nickname, onJoined }: { nickname: string; onJoined: (welcome: RendererWelcome) => void }) {
  const t = useT();
  const hostStatus = useHostStore((st) => st.status);
  const [servers, setServers] = useState<SavedServer[]>([]);
  const [tab, setTab] = useState<HomeTab>('all');
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ row: HomeServerRow; anchor: DOMRect } | null>(null);
  const [exiting, setExiting] = useState<SavedServer | null>(null);
  const listRevision = useSavedListStore((st) => st.revision);
  const locale = useSettingsStore((st) => st.settings?.locale ?? 'pt-BR');
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const reload = () =>
    window.ghostlink.servers.list().then(
      (list) => setServers(list),
      () => undefined,
    );
  useEffect(() => {
    void reload();
  }, [hostStatus?.revision, listRevision]);

  // Same trick as the main layout: the sidebar leaves room for the user panel.
  useEffect(() => {
    const panel = panelRef.current;
    const shell = shellRef.current;
    if (!panel || !shell) return;
    const observer = new ResizeObserver(() => shell.style.setProperty('--panel-h', `${panel.offsetHeight}px`));
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);

  const rows = homeServerRows(servers, hostStatus);
  const shown = filterHomeRows(rows, tab, query);
  const activity = homeActivity(hostStatus);
  const hostedRow = rows.find((r) => r.hosted) ?? null;

  const open = async (row: HomeServerRow) => {
    setError(null);
    // A server hosted here that is not running: start it (the Host flow prefills the last settings).
    if (row.stopped) {
      openHostFlow();
      return;
    }
    setBusyId(row.id);
    try {
      onJoined(await window.ghostlink.servers.connect(row.id));
    } catch (e) {
      const code = errorCodeOf(e);
      // Leave/delete spec §3: the owner deleted it (the date comes with the failed connection's state).
      const deletion = deletionMessage(code, row.name, useConnectionStore.getState().deletingAt, locale);
      setError(deletion ? t(deletion.text, deletion.vars) : errorMessage(t, code));
      if (code === 'SERVER_DELETED') void reload(); // main took it out of the list
    } finally {
      setBusyId(null);
    }
  };

  const subtitle = (row: HomeServerRow) => {
    if (busyId === row.id) return t('home.connecting');
    if (row.hosted) return row.stopped ? t('home.row.stopped') : t('home.row.running');
    return row.address ?? '';
  };

  return (
    <div ref={shellRef} className={`${l.shell} ${h.shell}`}>
      <ServerRail currentId="" onHome={() => undefined} homeActive />

      <nav className={l.sidebar} aria-label={t('home.nav')}>
        <div className={h.sidebarHeader}>
          <button type="button" className={h.searchOpen} onClick={() => searchRef.current?.focus()}>
            {t('home.searchOpen')}
          </button>
        </div>
        <div className={l.channelScroll}>
          <ul className={h.navList}>
            <li>
              <button type="button" className={h.navItem} onClick={openIdentitySettings}>
                <KeyRound size={20} aria-hidden="true" />
                {t('identity.settings.open')}
              </button>
            </li>
          </ul>

          <div className={h.sectionHeader}>
            <h2 className={h.sectionTitle}>{t('home.yourServers')}</h2>
            <button type="button" className={h.sectionAdd} onClick={() => setAdding(true)} aria-haspopup="dialog" aria-label={t('layout.addServer')} title={t('layout.addServer')}>
              <Plus size={16} aria-hidden="true" />
            </button>
          </div>
          <ul className={h.dmList}>
            {rows.map((row) => (
              <li key={row.id}>
                <button type="button" className={h.dmItem} disabled={busyId !== null} onClick={() => void open(row)}>
                  <ServerAvatar name={row.name} />
                  <span className={h.dmName}>{row.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </nav>

      <main className={`${l.center} ${h.center}`}>
        <header className={h.topbar}>
          <span className={h.topTitle}>
            <Server size={20} aria-hidden="true" />
            {t('home.nav.servers')}
          </span>
          <span className={h.topDot} aria-hidden="true" />
          <div className={h.tabs} role="tablist" aria-label={t('home.tabs')}>
            {(['all', 'hosted'] as const).map((id) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? `${h.tab} ${h.tabSelected}` : h.tab} onClick={() => setTab(id)}>
                {t(`home.tab.${id}`)}
              </button>
            ))}
          </div>
          <button type="button" className={h.addButton} onClick={() => setAdding(true)} aria-haspopup="dialog">
            {t('layout.addServer')}
          </button>
        </header>

        {rows.length === 0 ? (
          <div className={h.welcome}>
            <GhostMark size={96} />
            <h1 className={h.welcomeTitle}>{t('home.welcome', { name: nickname })}</h1>
            <p className={h.welcomeText}>{t('home.emptyLead')}</p>
          </div>
        ) : (
          <div className={h.listArea}>
            <label className={h.search}>
              <Search size={18} aria-hidden="true" />
              <input ref={searchRef} type="search" className={h.searchInput} placeholder={t('home.search')} aria-label={t('home.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            {error && (
              <p className={h.error} role="alert">
                {error}
              </p>
            )}
            <h2 className={h.count}>{t(`home.count.${tab}`, { count: String(shown.length) })}</h2>
            {shown.length === 0 ? (
              <p className={h.none}>{tab === 'hosted' && query.trim() === '' ? t('home.noHosted') : t('home.noMatch')}</p>
            ) : (
              <ul className={h.rows}>
                {shown.map((row) => (
                  <li key={row.id} className={h.row}>
                    <button type="button" className={h.rowMain} disabled={busyId !== null} onClick={() => void open(row)}>
                      <ServerAvatar name={row.name} />
                      <span className={h.rowText}>
                        <span className={h.rowName}>{row.name}</span>
                        <span className={h.rowSub}>{subtitle(row)}</span>
                      </span>
                    </button>
                    <div className={h.rowActions}>
                      <button
                        type="button"
                        className={h.roundButton}
                        disabled={busyId !== null}
                        onClick={() => void open(row)}
                        aria-label={row.stopped ? t('home.row.start', { name: row.name }) : t('home.row.open', { name: row.name })}
                        title={row.stopped ? t('home.row.start', { name: row.name }) : t('home.row.open', { name: row.name })}
                      >
                        {row.stopped ? <Play size={18} aria-hidden="true" /> : <MessageCircle size={18} aria-hidden="true" />}
                      </button>
                      <button
                        type="button"
                        className={h.roundButton}
                        aria-haspopup="menu"
                        aria-expanded={menu?.row.id === row.id}
                        aria-label={t('home.row.more', { name: row.name })}
                        title={t('home.row.more', { name: row.name })}
                        onClick={(e) => setMenu({ row, anchor: e.currentTarget.getBoundingClientRect() })}
                      >
                        <EllipsisVertical size={18} aria-hidden="true" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </main>

      <aside className={h.active} aria-label={t('home.active.title')}>
        <h2 className={h.activeTitle}>{t('home.active.title')}</h2>
        {activity ? (
          <ActivityCard activity={activity} onOpen={hostedRow && activity.state === 'running' ? () => void open(hostedRow) : null} />
        ) : (
          <div className={h.activeEmpty}>
            <p className={h.activeEmptyTitle}>{t('home.active.emptyTitle')}</p>
            <p className={h.activeEmptyText}>{t('home.active.emptyText')}</p>
          </div>
        )}
      </aside>

      <UserPanel ref={panelRef} homeNickname={nickname} onSettings={() => setSettingsOpen(true)} />
      {menu && (
        <Menu anchor={menu.anchor} label={t('home.row.more', { name: menu.row.name })} align="end" onClose={() => setMenu(null)}>
          <MenuItem
            onSelect={() => {
              setMenu(null);
              void open(menu.row);
            }}
          >
            {menu.row.stopped ? t('home.active.start') : t('home.active.open')}
          </MenuItem>
          <MenuSeparator />
          {/* Leave/delete spec §2: no "Remover da lista"; the dialog connects and offers delete to the owner. */}
          <MenuItem
            danger
            icon={<LogOut size={16} aria-hidden="true" />}
            onSelect={() => {
              const server = servers.find((s) => s.id === menu.row.id) ?? null;
              setMenu(null);
              setExiting(server);
            }}
          >
            {t('layout.leave')}
          </MenuItem>
        </Menu>
      )}
      {exiting && <ExitServerDialog server={exiting} onClose={() => setExiting(null)} onChanged={() => useSavedListStore.getState().changed()} />}
      {settingsOpen && <UserSettings offline onClose={() => setSettingsOpen(false)} />}
      {adding && <AddServerDialog onClose={() => setAdding(false)} onHome={() => undefined} />}
    </div>
  );
}

/** A server without an icon: its initials on a rounded tile, like the rail. */
function ServerAvatar({ name }: { name: string }) {
  return (
    <span className={h.avatar} aria-hidden="true">
      {serverInitials(name)}
    </span>
  );
}

/** "Ativo agora": the server hosted on this computer, its state and what to do with it. */
function ActivityCard({ activity, onOpen }: { activity: HomeActivity; onOpen: (() => void) | null }) {
  const t = useT();
  const idle = activity.state === 'stopped' || activity.state === 'failed';
  return (
    <section className={h.card} aria-label={activity.name}>
      <div className={h.cardHead}>
        <ServerAvatar name={activity.name} />
        <span className={h.rowText}>
          <span className={h.rowName}>{activity.name}</span>
          <span className={h.rowSub}>{t('home.active.hostedHere')}</span>
        </span>
      </div>
      <div className={h.cardBody}>
        <p className={h.cardState}>
          <span className={`${h.stateDot} ${h[activity.state]}`} aria-hidden="true" />
          {t(`home.active.${activity.state}`)}
          {activity.members !== null && activity.maxMembers !== null && (
            <span className={h.cardMeta}> · {t('home.active.members', { count: String(activity.members), max: String(activity.maxMembers) })}</span>
          )}
        </p>
        {activity.address && <p className={h.cardAddress}>{t('home.active.address', { address: activity.address })}</p>}
        <div className={h.cardActions}>
          {idle ? (
            <button type="button" className={h.cardPrimary} onClick={openHostFlow}>
              {t('home.active.start')}
            </button>
          ) : (
            <>
              {onOpen && (
                <button type="button" className={h.cardPrimary} onClick={onOpen}>
                  {t('home.active.open')}
                </button>
              )}
              <button type="button" className={h.cardSecondary} onClick={openHostPanel}>
                {t('home.active.manage')}
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
