import { useEffect, useRef, useState } from 'react';
import type { RendererWelcome } from '../../shared/ipcTypes.js';
import { ChatView } from '../features/chat/ChatView.js';
import { MemberList } from '../features/members/MemberList.js';
import { InviteDialog } from '../features/server-settings/InviteDialog.js';
import { LeaveDialog } from '../features/server-settings/LeaveDialog.js';
import { ServerSettings } from '../features/server-settings/ServerSettings.js';
import { errorCodeOf, errorMessage, useT } from '../i18n/index.js';
import { useConnectionStore } from '../stores/connection.js';
import { useTextStore } from '../stores/text.js';
import { ChannelSidebar, type SidebarDialog } from './ChannelSidebar.js';
import l from './layout.module.css';
import { primitives as p } from './primitives.js';
import { ServerRail } from './ServerRail.js';
import { useLayoutSlots } from './slots.js';
import { UserPanel } from './UserPanel.js';
import { UserSettings } from './UserSettings.js';
import { useTextSync } from './useTextSync.js';

type Dialog = SidebarDialog | 'user' | null;

/**
 * The main screen (spec §11.1 item 4, owner's UI reference): server rail, channel
 * sidebar with the user panel, the chat (or the voice stage) and the member list.
 */
export function MainLayout({ welcome, onLeave }: { welcome: RendererWelcome; onLeave: () => void }) {
  const t = useT();
  useTextSync(welcome);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [leaving, setLeaving] = useState(false);
  const stageId = useTextStore((s) => s.channels.stageId);
  const VoiceStage = useLayoutSlots((s) => s.VoiceStage);
  const shellRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  // The channel list and the rail leave room for the user panel, whose height changes with voice.
  useEffect(() => {
    const panel = panelRef.current;
    const shell = shellRef.current;
    if (!panel || !shell) return;
    const observer = new ResizeObserver(() => shell.style.setProperty('--panel-h', `${panel.offsetHeight}px`));
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);

  const disconnect = async () => {
    await window.ghostlink.servers.disconnect().catch(() => undefined);
    onLeave();
  };

  return (
    <div ref={shellRef} className={l.shell}>
      <ServerRail currentId={welcome.serverId} onHome={() => void disconnect()} />
      <ChannelSidebar onOpen={setDialog} />
      <main className={l.center}>{stageId !== null && VoiceStage ? <VoiceStage channelId={stageId} /> : <ChatView />}</main>
      <aside className={l.members} aria-label={t('members.title')}>
        <MemberList />
      </aside>
      <UserPanel ref={panelRef} onSettings={() => setDialog('user')} onDisconnect={() => void disconnect()} />

      {dialog === 'invite' && <InviteDialog onClose={() => setDialog(null)} />}
      {dialog === 'settings' && <ServerSettings onClose={() => setDialog(null)} />}
      {dialog === 'leave' && <LeaveDialog serverId={welcome.serverId} onClose={() => setDialog(null)} onLeaving={setLeaving} onLeft={onLeave} />}
      {dialog === 'user' && <UserSettings onClose={() => setDialog(null)} />}
      {!leaving && <ConnectionLost serverId={welcome.serverId} onLeave={onLeave} />}
    </div>
  );
}

/** Shown when the connection failed for good (kicked, banned, server gone…). */
function ConnectionLost({ serverId, onLeave }: { serverId: string; onLeave: () => void }) {
  const t = useT();
  const state = useConnectionStore((s) => s.state);
  const error = useConnectionStore((s) => s.error);
  const [busy, setBusy] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  if (state !== 'failed') return null;

  const reconnect = async () => {
    setBusy(true);
    setRetryError(null);
    try {
      useConnectionStore.getState().dispatch({ type: 'joined', welcome: await window.ghostlink.servers.connect(serverId) });
    } catch (e) {
      setRetryError(errorMessage(t, errorCodeOf(e)));
    } finally {
      setBusy(false);
    }
  };
  // After a kick or a ban, reconnecting cannot work: only offer the way out.
  const final = error === 'KICKED' || error === 'BANNED';

  return (
    <div className={l.lostOverlay}>
      <div className={l.lostCard} role="alertdialog" aria-modal="true" aria-labelledby="lost-title" aria-describedby="lost-text">
        <h2 id="lost-title" className={l.lostTitle}>
          {t('layout.connectionFailed')}
        </h2>
        <p id="lost-text" className={l.lostText}>
          {errorMessage(t, error ?? 'CONNECTION_LOST')}
        </p>
        {retryError && (
          <p className={p.error} role="alert">
            {retryError}
          </p>
        )}
        <div className={l.lostActions}>
          <button type="button" className={p.button} disabled={busy} onClick={onLeave}>
            {t('layout.backToServers')}
          </button>
          {!final && (
            <button type="button" className={`${p.button} ${p.buttonPrimary}`} disabled={busy} onClick={() => void reconnect()} autoFocus>
              {t('connected.reconnect')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
