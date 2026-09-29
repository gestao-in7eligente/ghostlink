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
export const UserPanel = forwardRef<HTMLElement, { onSettings: () => void; onDisconnect: () => void }>(function UserPanel(
  { onSettings, onDisconnect },
  ref,
) {
  const t = useT();
  const nickname = useTextStore((s) => (Object.hasOwn(s.members.byId, s.server.selfId) ? s.members.byId[s.server.selfId]!.nickname : ''));
  const state = useConnectionStore((s) => s.state);
  const fallbackNick = useConnectionStore((s) => s.welcome?.self.nickname ?? '');
  const VoicePanel = useLayoutSlots((s) => s.VoicePanel);
  const VoiceControls = useLayoutSlots((s) => s.VoiceControls);
  const online = state === 'connected';
  const status = online ? t('layout.online') : t(`state.${state}`);

  return (
    <section ref={ref} className={l.userPanel} aria-label={t('layout.userPanel')}>
      {VoicePanel && <VoicePanel />}
      <div className={l.panelRow}>
        <Avatar size={32} online={online} />
        <div className={l.who}>
          <span className={l.whoName}>{nickname || fallbackNick}</span>
          <span className={l.whoStatus} role="status">
            {status}
          </span>
        </div>
        <div className={l.panelActions}>
          {VoiceControls && <VoiceControls />}
          <button type="button" className={l.panelButton} onClick={onSettings} aria-label={t('layout.userSettings')} title={t('layout.userSettings')}>
            <Settings size={19} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={`${l.panelButton} ${l.panelExit}`}
            onClick={onDisconnect}
            aria-label={t('layout.disconnect')}
            title={t('layout.disconnect')}
          >
            <LogOut size={19} aria-hidden="true" />
          </button>
        </div>
      </div>
    </section>
  );
});
