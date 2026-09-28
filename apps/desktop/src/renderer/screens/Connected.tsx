import { useState } from 'react';
import { formatFingerprint } from '@ghostlink/shared';
import type { RendererWelcome } from '../../shared/ipcTypes.js';
import { ErrorLine, Screen } from '../components/Screen.js';
import ui from '../components/ui.module.css';
import { errorCodeOf, errorMessage, useT } from '../i18n/index.js';
import { useConnectionStore } from '../stores/connection.js';

/** Milestone 1 placeholder for the main screen: server, fingerprint, state and disconnect. */
export function Connected({ welcome, onLeave }: { welcome: RendererWelcome; onLeave: () => void }) {
  const t = useT();
  const { state, error } = useConnectionStore();
  const dispatch = useConnectionStore((s) => s.dispatch);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const disconnect = async () => {
    setBusy(true);
    try {
      await window.ghostlink.servers.disconnect();
      onLeave();
    } finally {
      setBusy(false);
    }
  };

  const reconnect = async () => {
    setBusy(true);
    setActionError(null);
    try {
      dispatch({ type: 'joined', welcome: await window.ghostlink.servers.connect(welcome.serverId) });
    } catch (e) {
      setActionError(errorMessage(t, errorCodeOf(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={welcome.server.name} wide>
      <p className={ui.status}>
        <span className={state === 'connected' ? `${ui.dot} ${ui.dotOn}` : ui.dot} aria-hidden="true" />
        {t(`state.${state}`)}
      </p>
      <p className={ui.text}>{t('connected.as', { nickname: welcome.self.nickname })}</p>
      {welcome.self.isOwner && <p className={ui.text}>{t('connected.owner')}</p>}
      <div className={ui.field}>
        <span className={ui.label}>{t('connected.fingerprint')}</span>
        <p className={ui.fingerprint}>{formatFingerprint(welcome.server.serverKeyId)}</p>
        <span className={ui.hint}>{t('connected.version', { version: welcome.server.version })}</span>
      </div>
      <p className={ui.hint}>{t('connected.placeholder')}</p>
      <ErrorLine text={state === 'failed' && error ? errorMessage(t, error) : actionError} />
      <div className={ui.actions}>
        {state === 'failed' ? (
          <>
            <button type="button" className={ui.button} disabled={busy} onClick={onLeave}>
              {t('common.back')}
            </button>
            <button type="button" className={`${ui.button} ${ui.primary}`} disabled={busy} onClick={() => void reconnect()}>
              {t('connected.reconnect')}
            </button>
          </>
        ) : (
          <button type="button" className={`${ui.button} ${ui.danger}`} disabled={busy} onClick={() => void disconnect()}>
            {t('connected.disconnect')}
          </button>
        )}
      </div>
    </Screen>
  );
}
