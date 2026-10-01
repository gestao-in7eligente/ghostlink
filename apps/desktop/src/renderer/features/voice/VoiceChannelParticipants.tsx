import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useT } from '../../i18n/index.js';
import { ParticipantMenu } from './ParticipantMenu.js';
import { StateIcons, VoiceAvatar } from './parts.js';
import { useVoiceDirectory, useVoiceRuntime } from './runtime.js';
import { LiveBadge } from './screenParts.js';
import { isSpeaking, participantsOf, useVoiceStore } from './state.js';
import s from './voice.module.css';

/**
 * Who is in a voice channel, under its row in the channel sidebar: avatar, name, a
 * green ring while speaking, mute / deafen / server-mute marks, and "AO VIVO" while
 * sharing a screen. Other people open
 * a menu (volume, moderation) with a click, Enter or the context-menu key.
 */
export function VoiceChannelParticipants({ channelId }: { channelId: string }) {
  useVoiceRuntime();
  const t = useT();
  const participants = useVoiceStore((v) => participantsOf(v, channelId));
  const speakers = useVoiceStore(useShallow((v) => (v.call.channelId === channelId ? participantsOf(v, channelId).filter((p) => isSpeaking(v, p.userId)).map((p) => p.userId) : [])));
  const selfUserId = useVoiceStore((v) => v.selfUserId);
  const directory = useVoiceDirectory();
  const [menuFor, setMenuFor] = useState<string | null>(null);
  if (participants.length === 0) return null;

  return (
    <ul className={s.participants} aria-label={directory.channelName(channelId) ?? undefined} data-voice-participants={channelId}>
      {participants.map((p) => {
        const isSelf = p.userId === selfUserId;
        const speaking = speakers.includes(p.userId);
        const name = directory.displayName(p.userId);
        const rowClass = speaking ? `${s.participantRow} ${s.participantSpeaking}` : s.participantRow;
        const content = (
          <>
            <VoiceAvatar size={24} speaking={speaking} />
            <span className={s.participantName}>
              {name}
              {speaking && <span className={s.srOnly}>, {t('voice.speaking')}</span>}
            </span>
            <StateIcons p={p} />
            {p.screen && <LiveBadge />}
          </>
        );
        return (
          <li key={p.userId} className={s.anchor} data-user={p.userId} data-speaking={speaking || undefined}>
            {isSelf ? (
              <div className={rowClass}>{content}</div>
            ) : (
              <button
                type="button"
                className={rowClass}
                aria-haspopup="menu"
                aria-expanded={menuFor === p.userId}
                onClick={() => setMenuFor(menuFor === p.userId ? null : p.userId)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenuFor(p.userId);
                }}
              >
                {content}
              </button>
            )}
            {menuFor === p.userId && <ParticipantMenu participant={p} channelId={channelId} placement="down" onClose={() => setMenuFor(null)} />}
          </li>
        );
      })}
    </ul>
  );
}
