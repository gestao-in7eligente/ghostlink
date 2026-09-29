import { useEffect, useState } from 'react';
import type { AppErrorCode } from '../shared/appErrors.js';
import type { IdentityStatus, RendererWelcome } from '../shared/ipcTypes.js';
import { ErrorLine, Screen } from './components/Screen.js';
import ui from './components/ui.module.css';
import { HostIndicator } from './features/host/HostIndicator.js';
import { HostScreens } from './features/host/HostScreens.js';
import { openHostFlow } from './features/host/hostUi.js';
import { useHostStatusSync } from './features/host/useHostStatusSync.js';
import { joinStartFromLink, useDeepLinkStore } from './features/deeplink/deepLinkStore.js';
import { useDeepLinkSync } from './features/deeplink/useDeepLinkSync.js';
import { IdentityScreens } from './features/identity/IdentityScreens.js';
import { DEFAULT_LOCALE, errorCodeOf, errorMessage, useT } from './i18n/index.js';
import { useAddServerUi } from './integration/addServerUi.js';
import { HomeLayout } from './integration/HomeLayout.js';
import { useLayoutWiring } from './integration/useLayoutWiring.js';
import { Connected } from './screens/Connected.js';
import { IdentityLocked } from './screens/IdentityLocked.js';
import { Join } from './screens/Join.js';
import { Onboarding } from './screens/Onboarding.js';
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
  useDeepLinkSync(attempt);
  useLayoutWiring();
  const deepLink = useDeepLinkStore((s) => s.pending);
  const joinOpen = useAddServerUi((s) => s.join);

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
  // Import, export and delete (spec §3.4): dialogs over any screen, including onboarding and the locked screen.
  const identityChanged = (status: IdentityStatus) => {
    setIdentity(status);
    if (status === 'none') {
      useConnectionStore.getState().dispatch({ type: 'state', event: { state: 'idle', serverId: null } });
      setOnboarding(true);
    } else {
      setOnboarding(status !== 'ready' || settings.nickname === '');
    }
  };
  const identityDialogs = <IdentityScreens status={identity} onChanged={identityChanged} />;
  if (identity === 'locked') {
    return <><IdentityLocked onStatus={identityChanged} />{identityDialogs}</>;
  }
  if (onboarding) {
    const done = (next: 'join' | 'host') => {
      setIdentity('ready');
      setOnboarding(false);
      setView(next === 'join' ? 'join' : 'servers');
      if (next === 'host') openHostFlow();
    };
    return <><Onboarding identity={identity} onDone={done} />{identityDialogs}</>;
  }
  // Host mode (spec §9): its dialogs open over any screen. While hosting, the floating
  // pill shows outside the main layout; inside it the rail shows HostRailButton instead.
  const connected = connection.welcome !== null && connection.state !== 'idle';
  // Home and the main layout show hosting in the rail; only the Join screens need the floating pill.
  const inLayout = connected || (!deepLink && !joinOpen && view !== 'join');
  const host = (
    <>
      {!inLayout && <HostIndicator />}
      <HostScreens onJoined={joined} />
      {identityDialogs}
    </>
  );
  if (deepLink) {
    // A ghostlink:// link: its invite waits for "Aceitar convite" (spec §12); new links are ignored meanwhile.
    const clearLink = () => useDeepLinkStore.getState().clear();
    return (
      <>
        <Join
          key={`${deepLink.serverKeyId}-${deepLink.inviteCode ?? ''}`}
          start={joinStartFromLink(settings.nickname, deepLink)}
          onCancel={clearLink}
          onJoined={(welcome) => {
            clearLink();
            joined(welcome);
          }}
        />
        {host}
      </>
    );
  }
  if (joinOpen) {
    // "+" → "Entrar em um servidor": the Join screen, even over a connected server.
    const closeJoin = () => useAddServerUi.getState().closeJoin();
    return (
      <>
        <Join
          onCancel={closeJoin}
          onJoined={(welcome) => {
            closeJoin();
            joined(welcome);
          }}
        />
        {host}
      </>
    );
  }
  if (connection.welcome && connection.state !== 'idle') {
    return <><Connected welcome={connection.welcome} onLeave={leave} />{host}</>;
  }
  if (view === 'join') return <><Join onCancel={() => setView('servers')} onJoined={joined} />{host}</>;
  // The app opens on the Discord-like layout (owner requirement): Home = rail + "Seus servidores" + welcome.
  return <><HomeLayout nickname={settings.nickname} onJoined={joined} />{host}</>;
}
