import { HeadphoneOff, Headphones, Mic, MicOff, PhoneCall, PhoneOff, Volume2 } from 'lucide-react';
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { VoiceParticipant } from '@ghostlink/shared';
import { useT } from '../../i18n/index.js';
import { ParticipantMenu } from './ParticipantMenu.js';
import { StateIcons, VoiceAvatar } from './parts.js';
import { joinVoice, leaveVoice, toggleDeafen, toggleMute, useVoiceDirectory, useVoiceRuntime } from './runtime.js';
import { isSpeaking, participantsOf, selfVoice, useVoiceStore } from './state.js';
import s from './voice.module.css';

function Tile({ p, channelId, isSelf, speaking, receiving }: { p: VoiceParticipant; channelId: string; isSelf: boolean; speaking: boolean; receiving: boolean }) {
  const t = useT();
  const directory = useVoiceDirectory();
  const [menu, setMenu] = useState(false);
  const name = directory.displayName(p.userId);
  const className = speaking ? `${s.tile} ${s.tileSpeaking}` : s.tile;
  const body = (
    <>
      <VoiceAvatar size={72} speaking={speaking} />
      <span className={s.tileName}>
        {name}
        {isSelf && ` (${t('voice.you')})`}
        {speaking && <span className={s.srOnly}>, {t('voice.speaking')}</span>}
      </span>
      {(p.muted || p.deafened || p.serverMuted) && (
        <span className={s.tileIcons}>
          <StateIcons p={p} size={16} />
        </span>
      )}
    </>
  );
  const data = { 'data-user': p.userId, 'data-speaking': speaking || undefined, 'data-receiving': receiving || undefined };
  if (isSelf) {
    return (
      <div className={className} role="group" aria-label={name} {...data}>
        {body}
      </div>
    );
  }
  return (
    <div className={s.anchor} {...data}>
      <button
        type="button"
        className={className}
        style={{ width: '100%' }}
        aria-haspopup="menu"
        aria-expanded={menu}
        onClick={() => setMenu(!menu)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu(true);
        }}
      >
        {body}
      </button>
      {menu && <ParticipantMenu participant={p} channelId={channelId} placement="down" onClose={() => setMenu(false)} />}
    </div>
  );
}

/**
 * The center view of a voice channel: a grid of participant tiles with speaking rings,
 * and the call bar (join, or mute / deafen / leave while in this channel).
 */
export function VoiceStage({ channelId }: { channelId: string }) {
  useVoiceRuntime();
  const t = useT();
  const directory = useVoiceDirectory();
  const participants = useVoiceStore((v) => participantsOf(v, channelId));
  const call = useVoiceStore((v) => v.call);
  const speakers = useVoiceStore(useShallow((v) => participantsOf(v, channelId).filter((p) => isSpeaking(v, p.userId)).map((p) => p.userId)));
  const receiving = useVoiceStore((v) => v.subscribed);
  const selfUserId = useVoiceStore((v) => v.selfUserId);
  const muted = useVoiceStore((v) => v.selfMuted || v.selfDeafened);
  const deafened = useVoiceStore((v) => v.selfDeafened);
  const serverMuted = useVoiceStore((v) => selfVoice(v)?.serverMuted ?? false);
  const available = useVoiceStore((v) => v.available);
  const here = call.channelId === channelId && call.status !== 'idle';
  const name = directory.channelName(channelId) ?? '';

  return (
    <section className={s.stage} aria-label={name} data-voice-stage={channelId}>
      <header className={s.stageHeader}>
        <Volume2 size={20} className={s.stageHeaderIcon} aria-hidden="true" />
        <h2>{name}</h2>
        <span className={s.pill}>{t('voice.channelType')}</span>
      </header>
      <div className={s.stageBody}>
        {participants.length === 0 ? (
          <div className={s.empty}>
            <span className={s.emptyIcon}>
              <Volume2 size={32} aria-hidden="true" />
            </span>
            <h3>{t('voice.empty')}</h3>
            <p>{t('voice.emptyHint')}</p>
          </div>
        ) : (
          <div className={s.grid}>
            {participants.map((p) => (
              <Tile
                key={p.userId}
                p={p}
                channelId={channelId}
                isSelf={p.userId === selfUserId}
                speaking={here && speakers.includes(p.userId)}
                receiving={here && receiving.includes(p.userId)}
              />
            ))}
          </div>
        )}
      </div>
      <footer className={s.stageBar}>
        {here ? (
          <>
            <button
              type="button"
              className={s.roundButton}
              aria-pressed={muted || serverMuted}
              aria-label={serverMuted ? t('voice.serverMuted') : t(muted ? 'voice.unmute' : 'voice.mute')}
              disabled={serverMuted}
              onClick={() => void toggleMute()}
            >
              {muted || serverMuted ? <MicOff size={20} aria-hidden="true" /> : <Mic size={20} aria-hidden="true" />}
            </button>
            <button type="button" className={s.roundButton} aria-pressed={deafened} aria-label={t(deafened ? 'voice.undeafen' : 'voice.deafen')} onClick={() => void toggleDeafen()}>
              {deafened ? <HeadphoneOff size={20} aria-hidden="true" /> : <Headphones size={20} aria-hidden="true" />}
            </button>
            <button type="button" className={`${s.roundButton} ${s.roundDanger}`} aria-label={t('voice.disconnect')} onClick={() => void leaveVoice()}>
              <PhoneOff size={20} aria-hidden="true" />
            </button>
          </>
        ) : available ? (
          <button type="button" className={s.primary} onClick={() => void joinVoice(channelId)} data-voice-join={channelId}>
            <PhoneCall size={18} aria-hidden="true" />
            {t('voice.join')}
          </button>
        ) : (
          <p className={s.unavailable} role="status">
            {t('voice.unavailable')}
          </p>
        )}
      </footer>
    </section>
  );
}
