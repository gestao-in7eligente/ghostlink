import { useEffect, useRef, useState } from 'react';
import { LogIn, Play, Plus, Server, Trash2 } from 'lucide-react';
import type { RendererWelcome, SavedServer } from '../../shared/ipcTypes.js';
import { GhostMark } from '../components/GhostMark.js';
import { useHostStore } from '../features/host/hostStore.js';
import { openHostFlow } from '../features/host/hostUi.js';
import { openIdentitySettings } from '../features/identity/identityModel.js';
import { errorCodeOf, errorMessage, useT } from '../i18n/index.js';
import l from '../layout/layout.module.css';
import { ServerRail } from '../layout/ServerRail.js';
import { UserPanel } from '../layout/UserPanel.js';
import { UserSettings } from '../layout/UserSettings.js';
import { openAddServer, useAddServerUi } from './addServerUi.js';
import { homeServerRows, stoppedHostedServer } from './homeModel.js';
import h from './home.module.css';
import s from './integration.module.css';

/**
 * The Home screen (owner requirement: the app opens on the Discord-like layout):
 * the server rail, "Seus servidores" where the channels would be, a welcome with
 * Criar / Entrar in the center, and the user panel at the bottom-left.
 */
export function HomeLayout({ nickname, onJoined }: { nickname: string; onJoined: (welcome: RendererWelcome) => void }) {
  const t = useT();
  const hostStatus = useHostStore((st) => st.status);
  const [servers, setServers] = useState<SavedServer[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  const reload = () =>
    window.ghostlink.servers.list().then(
      (list) => setServers(list),
      () => undefined,
    );
  useEffect(() => {
    void reload();
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

  const rows = homeServerRows(servers, hostStatus);
  const stopped = stoppedHostedServer(hostStatus);

  const connect = async (id: string, stoppedHere: boolean) => {
    setError(null);
    // A server hosted here that is not running: start it (the Host flow prefills the last settings).
    if (stoppedHere) {
      openHostFlow();
      return;
    }
    setBusyId(id);
    try {
      onJoined(await window.ghostlink.servers.connect(id));
    } catch (e) {
      setError(errorMessage(t, errorCodeOf(e)));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id: string) => {
    setConfirmRemove(null);
    try {
      await window.ghostlink.servers.remove(id);
    } finally {
      void reload();
    }
  };

  return (
    <div ref={shellRef} className={`${l.shell} ${l.noMembers}`}>
      <ServerRail currentId="" onHome={() => undefined} />

      <nav className={l.sidebar} aria-label={t('home.yourServers')}>
        <div className={`${l.serverHeader} ${h.homeHeader}`}>
          <GhostMark size={22} />
          <span className={l.serverName}>{t('home.title')}</span>
        </div>
        <div className={l.channelScroll}>
          <div className={l.section}>
            <div className={l.sectionHeader}>
              <h2 className={l.sectionTitle}>{t('home.yourServers')}</h2>
              <button type="button" className={l.sectionAdd} onClick={openAddServer} aria-label={t('layout.addServer')} title={t('layout.addServer')}>
                <Plus size={16} aria-hidden="true" />
              </button>
            </div>
            {rows.length === 0 ? (
              <p className={h.empty}>{t('home.noServers')}</p>
            ) : (
              <ul className={l.channelList}>
                {rows.map((row) => (
                  <li key={row.id} className={`${l.channelItem} ${h.serverItem}`}>
                    {confirmRemove === row.id ? (
                      <div className={h.confirm}>
                        <span className={h.confirmText}>{t('home.removeConfirm', { name: row.name })}</span>
                        <button type="button" className={h.confirmYes} onClick={() => void remove(row.id)}>
                          {t('home.remove')}
                        </button>
                        <button type="button" className={h.confirmNo} onClick={() => setConfirmRemove(null)}>
                          {t('home.cancel')}
                        </button>
                      </div>
                    ) : (
                      <>
                        <button type="button" className={l.channel} disabled={busyId !== null} onClick={() => void connect(row.id, row.stopped)}>
                          <span className={h.initials} aria-hidden="true">
                            {row.name.slice(0, 1).toUpperCase()}
                          </span>
                          <span className={h.serverRowName}>{busyId === row.id ? t('home.connecting') : row.name}</span>
                          {row.hosted && <span className={h.badge}>{row.stopped ? t('home.hostedStopped') : t('home.hosted')}</span>}
                        </button>
                        <button
                          type="button"
                          className={h.removeButton}
                          onClick={() => setConfirmRemove(row.id)}
                          aria-label={t('home.removeLabel', { name: row.name })}
                          title={t('home.removeLabel', { name: row.name })}
                        >
                          <Trash2 size={15} aria-hidden="true" />
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </nav>

      <main className={`${l.center} ${h.center}`}>
        <div className={h.hero}>
          <GhostMark size={72} />
          <h1 className={h.title}>{t('home.welcome', { name: nickname })}</h1>
          <p className={h.lead}>{t('home.lead')}</p>
          {error && (
            <p className={h.error} role="alert">
              {error}
            </p>
          )}
          <div className={`${s.options} ${h.options}`}>
            {stopped && (
              <button type="button" className={`${s.option} ${h.startOption}`} onClick={openHostFlow}>
                <span className={s.optionIcon} aria-hidden="true">
                  <Play size={22} />
                </span>
                <span className={s.optionText}>
                  <span className={s.optionTitle}>{t('home.startHosted', { name: stopped.name })}</span>
                  <span className={s.optionDesc}>{t('home.startHostedDesc')}</span>
                </span>
              </button>
            )}
            <button type="button" className={s.option} onClick={openHostFlow}>
              <span className={s.optionIcon} aria-hidden="true">
                <Server size={22} />
              </span>
              <span className={s.optionText}>
                <span className={s.optionTitle}>{t('addServer.create.title')}</span>
                <span className={s.optionDesc}>{t('addServer.create.desc')}</span>
              </span>
            </button>
            <button type="button" className={s.option} onClick={() => useAddServerUi.getState().openJoin()}>
              <span className={s.optionIcon} aria-hidden="true">
                <LogIn size={22} />
              </span>
              <span className={s.optionText}>
                <span className={s.optionTitle}>{t('addServer.join.title')}</span>
                <span className={s.optionDesc}>{t('addServer.join.desc')}</span>
              </span>
            </button>
          </div>
          <button type="button" className={h.link} onClick={openIdentitySettings}>
            {t('identity.settings.open')}
          </button>
        </div>
      </main>

      <UserPanel ref={panelRef} homeNickname={nickname} onSettings={() => setSettingsOpen(true)} />
      {settingsOpen && <UserSettings offline onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
