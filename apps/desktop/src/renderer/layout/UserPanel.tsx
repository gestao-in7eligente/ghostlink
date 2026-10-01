import { forwardRef } from 'react';
import { LogOut, Settings } from 'lucide-react';
import { useVoiceStore } from '../features/voice/state.js';
import { useT } from '../i18n/index.js';
import { useConnectionStore } from '../stores/connection.js';
import { useTextStore } from '../stores/text.js';
import l from './layout.module.css';
import { Avatar } from './primitives.js';
import { useLayoutSlots } from './slots.js';

/**
 * The card at the bottom-left (owner's UI reference). Its top row is the Voice
 * track's panel (only while in voice); the bottom row is the user, the Voice
 * track's mic/headphones controls, settings and disconnect. On the Home screen the
 * voice parts show only during a call, which goes on there (chamada-continua §1):
 * "Voz conectada — {canal} / {servidor}" with the microphone, the headphones and hang-up.
 */
export const UserPanel = forwardRef<
  HTMLElement,
  {
    onSettings: () => void;
    /** Opens the user settings on the voice section (the voice panel's and device menus' shortcut). */
    onVoiceSettings?: () => void;
    /** Omitted on the Home screen (nothing to disconnect from): the exit button is hidden. */
    onDisconnect?: () => void;
    /** Home screen: the global nickname, shown instead of the server nickname. */
    homeNickname?: string;
    /** Home screen: the presence line and dot (friends network); omitted while it loads. */
    homeStatus?: { online: boolean; text: string };
  }
>(function UserPanel({ onSettings, onVoiceSettings, onDisconnect, homeNickname, homeStatus }, ref) {
  const t = useT();
  const nickname = useTextStore((s) => (Object.hasOwn(s.members.byId, s.server.selfId) ? s.members.byId[s.server.selfId]!.nickname : ''));
  const avatar = useTextStore((s) => (Object.hasOwn(s.members.byId, s.server.selfId) ? s.members.byId[s.server.selfId]!.avatar : null));
  const state = useConnectionStore((s) => s.state);
  const fallbackNick = useConnectionStore((s) => s.welcome?.self.nickname ?? '');
  const VoicePanel = useLayoutSlots((s) => s.VoicePanel);
  const VoiceControls = useLayoutSlots((s) => s.VoiceControls);
  const home = homeNickname !== undefined;
  const inCall = useVoiceStore((v) => v.call.status !== 'idle');
  const voice = !home || inCall;
  const online = home ? homeStatus?.online === true : state === 'connected';
  const name = homeNickname ?? (nickname || fallbackNick);
  const status = home ? (homeStatus?.text ?? t('home.panelStatus')) : online ? t('layout.online') : t(`state.${state}`);

  return (
    <section ref={ref} className={l.userPanel} aria-label={t('layout.userPanel')}>
      {voice && VoicePanel && <VoicePanel onOpenSettings={onVoiceSettings} />}
      <div className={l.panelRow}>
        <Avatar size={32} name={name} hash={home ? null : avatar} self online={online} />
        <div className={l.who}>
          <span className={l.whoName}>{name}</span>
          <span className={l.whoStatus} role="status">
            {status}
          </span>
        </div>
        <div className={l.panelActions}>
          {voice && VoiceControls && <VoiceControls onOpenSettings={onVoiceSettings} />}
          <button type="button" className={l.panelButton} onClick={onSettings} aria-label={t('layout.userSettings')} title={t('layout.userSettings')}>
            <Settings size={19} aria-hidden="true" />
          </button>
          {onDisconnect && (
            <button
              type="button"
              className={`${l.panelButton} ${l.panelExit}`}
              onClick={onDisconnect}
              aria-label={t('layout.disconnect')}
              title={t('layout.disconnect')}
            >
              <LogOut size={19} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </section>
  );
});
