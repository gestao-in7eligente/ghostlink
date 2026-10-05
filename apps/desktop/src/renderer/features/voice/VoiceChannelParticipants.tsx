import { Video } from 'lucide-react';
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useT } from '../../i18n/index.js';
import { useProfileCardStore } from '../profileCard/profileCardStore.js';
import { userMenuTriggers, type UserMenuRequest } from '../userMenu/triggers.js';
import { UserMenuFor } from '../userMenu/UserMenu.js';
import { StateIcons, VoiceAvatar } from './parts.js';
import { useVoiceDirectory, useVoiceRuntime } from './runtime.js';
import { LiveBadge } from './screenParts.js';
import { isSpeaking, participantsOf, useVoiceStore, viewVoice } from './state.js';
import s from './voice.module.css';

/**
 * Who is in a voice channel, under its row in the channel sidebar: avatar, name, a
 * green ring while speaking, mute / deafen / server-mute marks, a camera while theirs is
 * on, and "AO VIVO" while sharing a screen. A click (or Enter) opens the person's profile
 * card, the right click, the menu key or Shift+F10 their menu (spec 2026-10-02-menu-do-usuario).
 */
export function VoiceChannelParticipants({ channelId }: { channelId: string }) {
  useVoiceRuntime();
  const t = useT();
  // A channel of the server on screen; the call may run on another one (chamada-continua §2).
  const participants = useVoiceStore((v) => participantsOf(viewVoice(v), channelId));
  const speakers = useVoiceStore(useShallow((v) => (v.call.channelId === channelId ? participantsOf(v, channelId).filter((p) => isSpeaking(v, p.userId)).map((p) => p.userId) : [])));
  const here = useVoiceStore((v) => v.call.channelId === channelId && v.call.status === 'connected');
  const directory = useVoiceDirectory();
  const [menu, setMenu] = useState<UserMenuRequest | null>(null);
  if (participants.length === 0) return null;

  return (
    <ul className={s.participants} aria-label={directory.channelName(channelId) ?? undefined} data-voice-participants={channelId} data-voice-here={here || undefined}>
      {participants.map((p) => {
        const speaking = speakers.includes(p.userId);
        const name = directory.displayName(p.userId);
        const rowClass = speaking ? `${s.participantRow} ${s.participantSpeaking}` : s.participantRow;
        const content = (
          <>
            <VoiceAvatar size={24} speaking={speaking} userId={p.userId} />
            <span className={s.participantName}>
              {name}
              {speaking && <span className={s.srOnly}>, {t('voice.speaking')}</span>}
            </span>
            <StateIcons p={p} />
            {p.camera && (
              <span className={s.stateIcons}>
                <Video size={14} aria-label={t('voice.camera.live')} role="img" data-camera-icon="" />
              </span>
            )}
            {p.screen && <LiveBadge />}
          </>
        );
        return (
          <li key={p.userId} className={s.anchor} data-user={p.userId} data-speaking={speaking || undefined}>
            <button
              type="button"
              className={rowClass}
              aria-haspopup="dialog"
              data-profile-trigger
              onClick={(e) => useProfileCardStore.getState().open(p.userId, e.currentTarget.getBoundingClientRect(), 'right', e.currentTarget)}
              {...userMenuTriggers((anchor, opener) => setMenu({ userId: p.userId, anchor, opener }))}
            >
              {content}
            </button>
          </li>
        );
      })}
      {menu && <UserMenuFor request={menu} side="right" onClose={() => setMenu(null)} />}
    </ul>
  );
}
