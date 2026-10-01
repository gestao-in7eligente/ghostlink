import { forwardRef } from 'react';
import { LogOut, Settings } from 'lucide-react';
import { useT } from '../i18n/index.js';
import { useConnectionStore } from '../stores/connection.js';
import { useTextStore } from '../stores/text.js';
import l from './layout.module.css';
import { Avatar } from './primitives.js';
import { useLayoutSlots } from './slots.js';

/**
 * The card at the bottom-left (owner's UI reference). Its top row is the Voice
 * track's panel (only while in voice); the bottom row is the user, the Voice
 * track's mic/headphones controls, settings and disconnect.
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
  }
>(function UserPanel({ onSettings, onVoiceSettings, onDisconnect, homeNickname }, ref) {
  const t = useT();
  const nickname = useTextStore((s) => (Object.hasOwn(s.members.byId, s.server.selfId) ? s.members.byId[s.server.selfId]!.nickname : ''));
  const state = useConnectionStore((s) => s.state);
  const fallbackNick = useConnectionStore((s) => s.welcome?.self.nickname ?? '');
  const VoicePanel = useLayoutSlots((s) => s.VoicePanel);
  const VoiceControls = useLayoutSlots((s) => s.VoiceControls);
  const home = homeNickname !== undefined;
  const online = !home && state === 'connected';
  const status = home ? t('home.panelStatus') : online ? t('layout.online') : t(`state.${state}`);

  return (
    <section ref={ref} className={l.userPanel} aria-label={t('layout.userPanel')}>
      {!home && VoicePanel && <VoicePanel onOpenSettings={onVoiceSettings} />}
      <div className={l.panelRow}>
        <Avatar size={32} online={online} />
        <div className={l.who}>
          <span className={l.whoName}>{home ? homeNickname : nickname || fallbackNick}</span>
          <span className={l.whoStatus} role="status">
            {status}
          </span>
        </div>
        <div className={l.panelActions}>
          {!home && VoiceControls && <VoiceControls onOpenSettings={onVoiceSettings} />}
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
