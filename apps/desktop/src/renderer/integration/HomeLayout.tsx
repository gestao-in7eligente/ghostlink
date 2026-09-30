import { useEffect, useRef, useState } from 'react';
import { Users } from 'lucide-react';
import type { RendererWelcome, SavedServer } from '../../shared/ipcTypes.js';
import { FriendsHome } from '../features/friends/FriendsHome.js';
import { pendingIncoming } from '../features/friends/friendsModel.js';
import { useHostStore } from '../features/host/hostStore.js';
import { openHostFlow, openHostPanel } from '../features/host/hostUi.js';
import { errorCodeOf, errorMessage, useT } from '../i18n/index.js';
import l from '../layout/layout.module.css';
import { serverInitials } from '../layout/names.js';
import { ServerRail } from '../layout/ServerRail.js';
import { UserPanel } from '../layout/UserPanel.js';
import { UserSettings } from '../layout/UserSettings.js';
import { useFriendsStore, useFriendsSync } from '../stores/friends.js';
import { homeActivity, homeServerRows, type HomeActivity } from './homeModel.js';
import h from './home.module.css';

/**
 * The Home screen, laid out like Discord's Friends page (owner's reference; friends spec
 * 2026-09-30 §8): rail · sidebar (search, "Amigos", "Mensagens diretas") · the friends page ·
 * "Ativo agora" (the server hosted here). Servers live in the rail only.
 */
export function HomeLayout({ nickname, onJoined }: { nickname: string; onJoined: (welcome: RendererWelcome) => void }) {
  const t = useT();
  useFriendsSync();
  const hostStatus = useHostStore((st) => st.status);
  const friends = useFriendsStore((st) => st.snapshot);
  const [servers, setServers] = useState<SavedServer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    window.ghostlink.servers.list().then(
      (list) => setServers(list),
      () => undefined,
    );
  }, [hostStatus?.revision]);

  // Same trick as the main layout: the sidebar leaves room for the user panel.
  useEffect(() => {
    const panel = panelRef.current;
    const shell = shellRef.current;
    if (!panel || !shell) return;
    const observer = new ResizeObserver(() => shell.style.setProperty('--panel-h', `${panel.offsetHeight}px`));
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);

  const activity = homeActivity(hostStatus);
  const hostedRow = homeServerRows(servers, hostStatus).find((r) => r.hosted) ?? null;
  const waiting = pendingIncoming(friends?.friends ?? []);

  /** "Abrir" on the hosted server's card. */
  const openHosted = async (id: string) => {
    setError(null);
    try {
      onJoined(await window.ghostlink.servers.connect(id));
    } catch (e) {
      setError(errorMessage(t, errorCodeOf(e)));
    }
  };

  return (
    <div ref={shellRef} className={`${l.shell} ${h.shell}`}>
      <ServerRail currentId="" onHome={() => undefined} homeActive onOpenFailed={(code) => setError(code === null ? null : errorMessage(t, code))} />

      <nav className={l.sidebar} aria-label={t('home.nav')}>
        <div className={h.sidebarHeader}>
          <button type="button" className={h.searchOpen} onClick={() => searchRef.current?.focus()}>
            {t('friends.searchOpen')}
          </button>
        </div>
        <div className={l.channelScroll}>
          <ul className={h.navList}>
            <li>
              <button type="button" className={`${h.navItem} ${h.navSelected}`} aria-current="page">
                <Users size={20} aria-hidden="true" />
                <span className={h.navLabel}>{t('friends.title')}</span>
                {waiting > 0 && (
                  <span className={h.navBadge} aria-label={t('friends.pendingBadge', { count: waiting })}>
                    {waiting}
                  </span>
                )}
              </button>
            </li>
          </ul>
          <div className={h.sectionHeader}>
            <h2 className={h.sectionTitle}>{t('friends.dm.title')}</h2>
          </div>
          <p className={h.sectionEmpty}>{t('friends.dm.empty')}</p>
        </div>
      </nav>

      <main className={`${l.center} ${h.center}`}>
        {error && (
          <p className={h.error} role="alert">
            {error}
          </p>
        )}
        <FriendsHome nickname={nickname} searchRef={searchRef} />
      </main>

      <aside className={h.active} aria-label={t('home.active.title')}>
        <h2 className={h.activeTitle}>{t('home.active.title')}</h2>
        {activity ? (
          <ActivityCard activity={activity} onOpen={hostedRow && activity.state === 'running' ? () => void openHosted(hostedRow.id) : null} />
        ) : (
          <div className={h.activeEmpty}>
            <p className={h.activeEmptyTitle}>{t('home.active.emptyTitle')}</p>
            <p className={h.activeEmptyText}>{t('home.active.emptyText')}</p>
          </div>
        )}
      </aside>

      <UserPanel
        ref={panelRef}
        homeNickname={nickname}
        homeStatus={friends ? { online: friends.running, text: t(friends.running ? 'friends.panel.online' : 'friends.panel.invisible') } : undefined}
        onSettings={() => setSettingsOpen(true)}
      />
      {settingsOpen && <UserSettings offline onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

/** "Ativo agora": the server hosted on this computer, its state and what to do with it. */
function ActivityCard({ activity, onOpen }: { activity: HomeActivity; onOpen: (() => void) | null }) {
  const t = useT();
  const idle = activity.state === 'stopped' || activity.state === 'failed';
  return (
    <section className={h.card} aria-label={activity.name}>
      <div className={h.cardHead}>
        <span className={h.avatar} aria-hidden="true">
          {serverInitials(activity.name)}
        </span>
        <span className={h.cardText}>
          <span className={h.cardName}>{activity.name}</span>
          <span className={h.cardSub}>{t('home.active.hostedHere')}</span>
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
