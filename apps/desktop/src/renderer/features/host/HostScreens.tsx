// The public entry points of the Host feature for other screens:
//   <HostFlowModal>  — "Criar um servidor" (e.g. the rail's "+" → "Adicionar servidor")
//   <HostPanelModal> — the hosted server's panel (e.g. the server header menu)
//   <HostScreens>    — mounted once by App; opened with openHostFlow() / openHostPanel()
import { useState } from 'react';
import type { RendererWelcome } from '../../../shared/ipcTypes.js';
import { HostForm } from './HostForm.js';
import { HostPanel } from './HostPanel.js';
import { useHostStore } from './hostStore.js';
import { closeHost, hostFlowView, useHostUi } from './hostUi.js';

type View = 'form' | 'panel';

function HostModal({
  view,
  setView,
  onClose,
  onFormHosted,
  onPanelJoined,
}: {
  view: View;
  setView: (view: View) => void;
  onClose: () => void;
  onFormHosted: (welcome: RendererWelcome) => void;
  onPanelJoined: (welcome: RendererWelcome) => void;
}) {
  if (view === 'form') {
    // Joined as the owner → the caller lands on the server; the join failed → the panel says why.
    return <HostForm onCancel={onClose} onStarted={(r) => (r.welcome ? onFormHosted(r.welcome) : setView('panel'))} />;
  }
  return <HostPanel onClose={onClose} onJoined={onPanelJoined} onHostAnother={() => setView('form')} />;
}

/**
 * "Criar um servidor": the Host form as a modal (or the panel, when a server is
 * already hosted — one at a time). `onHosted` gets the owner's welcome once the
 * server runs and the app joined it; the caller then closes the modal.
 */
export function HostFlowModal({ onClose, onHosted }: { onClose: () => void; onHosted: (welcome: RendererWelcome) => void }) {
  const [view, setView] = useState<View>(() => hostFlowView(useHostStore.getState().status?.state));
  return <HostModal view={view} setView={setView} onClose={onClose} onFormHosted={onHosted} onPanelJoined={onHosted} />;
}

/** The Host panel as a modal. `onJoined` gets the welcome after a restart, a rejoin or "Recuperar posse". */
export function HostPanelModal({ onClose, onJoined }: { onClose: () => void; onJoined: (welcome: RendererWelcome) => void }) {
  const [view, setView] = useState<View>('panel');
  return <HostModal view={view} setView={setView} onClose={onClose} onFormHosted={onJoined} onPanelJoined={onJoined} />;
}

/** App mounts this once; openHostFlow() / openHostPanel() / closeHost() drive it from anywhere. */
export function HostScreens({ onJoined }: { onJoined: (welcome: RendererWelcome) => void }) {
  const view = useHostUi((s) => s.view);
  const show = useHostUi((s) => s.show);
  if (view === 'closed') return null;
  return (
    <HostModal
      view={view}
      setView={show}
      onClose={closeHost}
      onFormHosted={(welcome) => {
        closeHost();
        onJoined(welcome);
      }}
      onPanelJoined={onJoined}
    />
  );
}
