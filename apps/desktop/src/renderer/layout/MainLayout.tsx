import { useEffect, useRef, useState } from 'react';
import type { RendererWelcome } from '../../shared/ipcTypes.js';
import { BotPage } from '../features/bots/BotPage.js';
import { ChatView } from '../features/chat/ChatView.js';
import { MemberList } from '../features/members/MemberList.js';
import { ProfileCardHost } from '../features/profileCard/ProfileCard.js';
import { InviteDialog } from '../features/server-settings/InviteDialog.js';
import { LeaveDialog } from '../features/server-settings/LeaveDialog.js';
import { ServerSettings } from '../features/server-settings/ServerSettings.js';
import { DeletionBanner, useServerDeleteSync } from '../features/serverDelete/DeletionBanner.js';
import { EnterpriseBanner } from '../features/enterprise/EnterpriseBanner.js';
import { useEnterpriseSync } from '../stores/enterprise.js';
import { deletionMessage } from '../features/serverDelete/serverDeleteModel.js';
import { DeleteServerDialog } from '../features/serverDelete/ServerExitDialogs.js';
import { ServerUpdateNotice } from '../features/serverUpdate/ServerUpdateNotice.js';
import { errorCodeOf, errorMessage, useT } from '../i18n/index.js';
import { centerView } from '../stores/channels.js';
import { useConnectionStore } from '../stores/connection.js';
import { useSettingsStore } from '../stores/settings.js';
import { useTextStore } from '../stores/text.js';
import { ChannelSidebar, type SidebarDialog } from './ChannelSidebar.js';
import l from './layout.module.css';
import { primitives as p } from './primitives.js';
import { ServerRail } from './ServerRail.js';
import { useLayoutSlots } from './slots.js';
import { UserPanel } from './UserPanel.js';
import { UserSettings } from './UserSettings.js';
import { provideUserSettingsOpener } from './userSettingsOpener.js';
import { useTextSync } from './useTextSync.js';

/** 'voice': the user settings, opened on the voice section. */
type Dialog = SidebarDialog | 'user' | 'voice' | null;

/**
 * The main screen (spec §11.1 item 4, owner's UI reference): server rail, channel
 * sidebar with the user panel, the chat (or the voice stage, or a bot's page) and the member list.
 */
export function MainLayout({ welcome, onLeave }: { welcome: RendererWelcome; onLeave: () => void }) {
  const t = useT();
  useTextSync(welcome);
  useServerDeleteSync(welcome);
  useEnterpriseSync();
  const [dialog, setDialog] = useState<Dialog>(null);
  /** The channel the invite or the settings are about (the channel menu), or null: the whole server. */
  const [dialogChannel, setDialogChannel] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const stageId = useTextStore((s) => s.channels.stageId);
  const botPageId = useTextStore((s) => s.channels.botPageId);
  const view = centerView({ stageId, botPageId });
  const VoiceStage = useLayoutSlots((s) => s.VoiceStage);
  const shellRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  // A person's menu on myself: "Editar perfil por servidor" opens the user settings on Perfil.
  useEffect(() => provideUserSettingsOpener(() => setDialog('user')), []);

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
      <ServerRail currentId={welcome.serverId} onHome={() => void disconnect()} onCurrentExit={setDialog} />
      <ChannelSidebar
        onOpen={(next, channelId) => {
          setDialogChannel(channelId ?? null);
          setDialog(next);
        }}
      />
      <main className={l.center}>
        {/* Leave/delete spec §3: the owner's red band while the server waits for its erase. */}
        <DeletionBanner serverId={welcome.serverId} />
        <EnterpriseBanner />
        {view === 'stage' && stageId !== null && VoiceStage ? (
          <VoiceStage channelId={stageId} onOpenSettings={() => setDialog('voice')} />
        ) : view === 'bot' && botPageId !== null ? (
          // Bot page spec: the bot selected in BOTS, like a channel.
          <BotPage botId={botPageId} />
        ) : (
          <>
            {/* Spec 2026-10-01 §5: only the owner sees it, when the server is behind the app. */}
            <ServerUpdateNotice serverKeyId={welcome.server.serverKeyId} />
            <ChatView />
          </>
        )}
      </main>
      <aside className={l.members} aria-label={t('members.title')}>
        <MemberList />
      </aside>
      <UserPanel ref={panelRef} onSettings={() => setDialog('user')} onVoiceSettings={() => setDialog('voice')} onDisconnect={() => void disconnect()} />
      {/* Spec 2026-10-02-cartao-de-perfil: a member's card, from a message's author or the member list. */}
      <ProfileCardHost />

      {dialog === 'invite' && <InviteDialog channelId={dialogChannel ?? undefined} onClose={() => setDialog(null)} />}
      {dialog === 'settings' && <ServerSettings channelId={dialogChannel ?? undefined} onClose={() => setDialog(null)} />}
      {dialog === 'leave' && <LeaveDialog serverId={welcome.serverId} onClose={() => setDialog(null)} onLeaving={setLeaving} onLeft={onLeave} />}
      {dialog === 'delete' && <DeleteOpenServer serverId={welcome.serverId} onClose={() => setDialog(null)} />}
      {(dialog === 'user' || dialog === 'voice') && <UserSettings section={dialog === 'voice' ? 'voice' : undefined} onClose={() => setDialog(null)} />}
      {!leaving && <ConnectionLost serverId={welcome.serverId} onLeave={onLeave} />}
    </div>
  );
}

/** "Excluir servidor" on the open server (the owner, leave/delete spec §3): it stays open, with the red band. */
function DeleteOpenServer({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const name = useTextStore((s) => s.server.name);
  return (
    <DeleteServerDialog
      name={name}
      onDelete={async () => {
        await window.ghostlink.servers.delete(serverId);
      }}
      onClose={onClose}
    />
  );
}

/** Shown when the connection failed for good (kicked, banned, server deleted, server gone…). */
function ConnectionLost({ serverId, onLeave }: { serverId: string; onLeave: () => void }) {
  const t = useT();
  const state = useConnectionStore((s) => s.state);
  const error = useConnectionStore((s) => s.error);
  const deletingAt = useConnectionStore((s) => s.deletingAt);
  const name = useConnectionStore((s) => s.welcome?.server.name ?? '');
  const locale = useSettingsStore((s) => s.settings?.locale ?? 'pt-BR');
  const owner = useConnectionStore((s) => s.welcome?.self.isOwner === true);
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
  // After a kick, a ban or the owner's deletion, reconnecting cannot work: only offer the way out.
  const deletion = deletionMessage(error, name, deletingAt, locale, owner);
  const final = error === 'KICKED' || error === 'BANNED' || deletion !== null;

  return (
    <div className={l.lostOverlay}>
      <div className={l.lostCard} role="alertdialog" aria-modal="true" aria-labelledby="lost-title" aria-describedby="lost-text">
        <h2 id="lost-title" className={l.lostTitle}>
          {deletion ? t(deletion.title) : t('layout.connectionFailed')}
        </h2>
        <p id="lost-text" className={l.lostText}>
          {deletion ? t(deletion.text, deletion.vars) : errorMessage(t, error ?? 'CONNECTION_LOST')}
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
