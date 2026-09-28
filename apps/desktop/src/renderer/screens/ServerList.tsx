import { useEffect, useState } from 'react';
import type { AppErrorCode } from '../../shared/appErrors.js';
import type { RendererWelcome, SavedServer } from '../../shared/ipcTypes.js';
import { ErrorLine, Screen } from '../components/Screen.js';
import ui from '../components/ui.module.css';
import { errorCodeOf, errorMessage, useT } from '../i18n/index.js';

/** Saved servers (one connection at a time, spec §1.3): reconnect, remove, or join a new one. */
export function ServerList({ onJoin, onJoined }: { onJoin: () => void; onJoined: (welcome: RendererWelcome) => void }) {
  const t = useT();
  const [servers, setServers] = useState<SavedServer[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [error, setError] = useState<AppErrorCode | null>(null);

  useEffect(() => {
    let alive = true;
    window.ghostlink.servers.list().then(
      (list) => alive && setServers(list),
      (e: unknown) => alive && setError(errorCodeOf(e)),
    );
    return () => {
      alive = false;
    };
  }, []);

  const connect = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      onJoined(await window.ghostlink.servers.connect(id));
    } catch (e) {
      setError(errorCodeOf(e));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      await window.ghostlink.servers.remove(id);
      setServers((list) => list?.filter((s) => s.id !== id) ?? null);
    } catch (e) {
      setError(errorCodeOf(e));
    } finally {
      setConfirmRemove(null);
    }
  };

  return (
    <Screen title={t('servers.title')} wide>
      {servers === null && <p className={ui.hint}>{t('app.loading')}</p>}
      {servers?.length === 0 && <p className={ui.text}>{t('servers.empty')}</p>}
      {servers && servers.length > 0 && (
        <ul className={ui.list}>
          {servers.map((s) => (
            <li key={s.id} className={ui.item}>
              <div className={ui.itemText}>
                <span className={ui.itemTitle}>{s.name}</span>
                <span className={ui.hint}>
                  {t('servers.as', { nickname: s.nickname })} · {s.addresses[0]}
                </span>
                {confirmRemove === s.id && <span className={ui.hint}>{t('servers.removeConfirm', { name: s.name })}</span>}
              </div>
              <div className={ui.actions}>
                {confirmRemove === s.id ? (
                  <>
                    <button type="button" className={ui.button} onClick={() => setConfirmRemove(null)}>
                      {t('common.cancel')}
                    </button>
                    <button type="button" className={`${ui.button} ${ui.danger}`} onClick={() => void remove(s.id)}>
                      {t('servers.remove')}
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className={ui.button} disabled={busyId !== null} onClick={() => setConfirmRemove(s.id)}>
                      {t('servers.remove')}
                    </button>
                    <button
                      type="button"
                      className={`${ui.button} ${ui.primary}`}
                      disabled={busyId !== null}
                      onClick={() => void connect(s.id)}
                    >
                      {busyId === s.id ? t('state.connecting') : t('servers.connect')}
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <ErrorLine text={error && errorMessage(t, error)} />
      <div className={ui.actions}>
        <button type="button" className={`${ui.button} ${ui.primary}`} onClick={onJoin}>
          {t('servers.join')}
        </button>
      </div>
    </Screen>
  );
}
