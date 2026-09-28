import { useEffect, useState } from 'react';
import type { AppErrorCode } from '../shared/appErrors.js';
import type { IdentityStatus, RendererWelcome } from '../shared/ipcTypes.js';
import { ErrorLine, Screen } from './components/Screen.js';
import ui from './components/ui.module.css';
import { HostIndicator } from './features/host/HostIndicator.js';
import { HostScreens } from './features/host/HostScreens.js';
import { openHostFlow } from './features/host/hostUi.js';
import { useHostStatusSync } from './features/host/useHostStatusSync.js';
import { DEFAULT_LOCALE, errorCodeOf, errorMessage, useT } from './i18n/index.js';
import { Connected } from './screens/Connected.js';
import { IdentityLocked } from './screens/IdentityLocked.js';
import { Join } from './screens/Join.js';
import { Onboarding } from './screens/Onboarding.js';
import { ServerList } from './screens/ServerList.js';
import { useConnectionStore } from './stores/connection.js';
import { useSettingsStore } from './stores/settings.js';

export function App() {
  const t = useT();
  const settings = useSettingsStore((s) => s.settings);
  const connection = useConnectionStore();
  const [identity, setIdentity] = useState<IdentityStatus | null>(null);
  const [onboarding, setOnboarding] = useState(false);
  const [view, setView] = useState<'servers' | 'join'>('servers');
  const [loadError, setLoadError] = useState<AppErrorCode | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const api = window.ghostlink;
    const { dispatch } = useConnectionStore.getState();
    const offState = api.onConnectionState((event) => dispatch({ type: 'state', event }));
    const offEvents = api.onServerEvent((event) => dispatch({ type: 'serverEvent', event }));
    let alive = true;
    Promise.all([api.identity.status(), api.settings.get()]).then(
      ([status, loaded]) => {
        if (!alive) return;
        useSettingsStore.getState().setSettings(loaded);
        setIdentity(status);
        setOnboarding(status !== 'ready' || loaded.nickname === '');
        // The smoke test (main/smoke.ts) waits for this: the page rendered and IPC answered.
        document.documentElement.dataset.ready = '1';
      },
      (e: unknown) => alive && setLoadError(errorCodeOf(e)),
    );
    return () => {
      alive = false;
      offState();
      offEvents();
    };
  }, [attempt]);

  useHostStatusSync(attempt);

  useEffect(() => {
    document.documentElement.lang = settings?.locale ?? DEFAULT_LOCALE;
  }, [settings?.locale]);

  const joined = (welcome: RendererWelcome) => {
    useConnectionStore.getState().dispatch({ type: 'joined', welcome });
    setView('servers');
  };
  const leave = () => {
    useConnectionStore.getState().dispatch({ type: 'state', event: { state: 'idle', serverId: null } });
    setView('servers');
  };

  if (loadError) {
    return (
      <Screen title={t('app.loading')}>
        <ErrorLine text={errorMessage(t, loadError)} />
        <div className={ui.actions}>
          <button type="button" className={`${ui.button} ${ui.primary}`} onClick={() => { setLoadError(null); setAttempt((n) => n + 1); }}>
            {t('common.tryAgain')}
          </button>
        </div>
      </Screen>
    );
  }
  if (identity === null || settings === null) {
    return (
      <main className={ui.screen}>
        <p className={ui.hint}>{t('app.loading')}</p>
      </main>
    );
  }
  if (identity === 'locked') {
    return <IdentityLocked onStatus={(status) => { setIdentity(status); setOnboarding(status !== 'ready' || settings.nickname === ''); }} />;
  }
  if (onboarding) {
    const done = (next: 'join' | 'host') => {
      setIdentity('ready');
      setOnboarding(false);
      setView(next === 'join' ? 'join' : 'servers');
      if (next === 'host') openHostFlow();
    };
    return <Onboarding identity={identity} onDone={done} />;
  }
  // Host mode (spec §9): its dialogs open over any screen; the pill shows while hosting.
  const host = <><HostIndicator /><HostScreens onJoined={joined} /></>;
  if (connection.welcome && connection.state !== 'idle') {
    return <><Connected welcome={connection.welcome} onLeave={leave} />{host}</>;
  }
  if (view === 'join') return <><Join onCancel={() => setView('servers')} onJoined={joined} />{host}</>;
  return <><ServerList onJoin={() => setView('join')} onHost={openHostFlow} onJoined={joined} />{host}</>;
}
