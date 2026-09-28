import { ArrowRightLeft, Mic, MicOff, PhoneOff, RotateCcw } from 'lucide-react';
import { useId } from 'react';
import { PERMISSIONS, has, type VoiceParticipant } from '@ghostlink/shared';
import { useT } from '../../i18n/index.js';
import { Menu, MenuItem } from './parts.js';
import { moderateVoice, setUserVolume, useVoiceDirectory } from './runtime.js';
import { MAX_VOLUME, useVoiceSettings, volumeOf } from './settings.js';
import { useVoiceStore } from './state.js';
import s from './voice.module.css';

/** Someone's volume for me: 0–200 %, saved per server and user (spec §8.4), with a reset. */
export function UserVolume({ userId }: { userId: string }) {
  const t = useT();
  const sliderId = useId();
  const serverId = useVoiceStore((v) => v.serverId);
  const volume = useVoiceSettings((st) => volumeOf(st.settings, serverId, userId));
  const percent = new Intl.NumberFormat(document.documentElement.lang || undefined, { style: 'percent' }).format(volume / 100);
  return (
    <>
      <div className={s.menuSlider}>
        <div className={s.menuSliderHead}>
          <label htmlFor={sliderId}>{t('voice.userVolume')}</label>
          <span>{percent}</span>
        </div>
        <input
          id={sliderId}
          className={s.range}
          type="range"
          min={0}
          max={MAX_VOLUME}
          step={5}
          value={volume}
          aria-valuetext={percent}
          onChange={(e) => setUserVolume(userId, Number(e.target.value))}
          data-voice-volume={userId}
        />
      </div>
      {volume !== 100 && (
        <MenuItem onSelect={() => setUserVolume(userId, 100)}>
          <RotateCcw size={16} aria-hidden="true" />
          <span>{t('voice.resetVolume')}</span>
        </MenuItem>
      )}
    </>
  );
}

/**
 * The per-user volume inside a member's context menu (the main layout's MemberMenuExtras
 * slot). Nothing for myself.
 */
export function MemberVolume({ userId }: { userId: string; close?: () => void }) {
  const selfUserId = useVoiceStore((v) => v.selfUserId);
  if (userId === selfUserId) return null;
  return <UserVolume userId={userId} />;
}

/**
 * Options for someone in voice: their volume for me (0–200 %, saved per server and user)
 * and, when my permissions allow, server mute, disconnect and move (spec §5.2, §8.3).
 * Buttons are only hidden from those without the bit; the server decides every action.
 */
export function ParticipantMenu({ participant, channelId, placement, onClose }: {
  participant: VoiceParticipant;
  channelId: string;
  placement: 'up' | 'down';
  onClose(): void;
}) {
  const t = useT();
  const directory = useVoiceDirectory();
  const bits = directory.myPermissions(channelId);
  const canMute = has(bits, PERMISSIONS.MUTE_MEMBERS);
  const canMove = has(bits, PERMISSIONS.MOVE_MEMBERS);
  const targets = canMove ? directory.voiceChannels().filter((c) => c.id !== channelId && has(directory.myPermissions(c.id), PERMISSIONS.VIEW_CHANNEL)) : [];
  const name = directory.displayName(participant.userId);
  const act = (fn: () => Promise<void>) => () => {
    onClose();
    void fn();
  };

  return (
    <Menu label={t('voice.participantMenu', { name })} placement={placement} onClose={onClose}>
      <UserVolume userId={participant.userId} />
      {(canMute || canMove) && <div className={s.menuSeparator} role="separator" />}
      {canMute && (
        <MenuItem onSelect={act(() => moderateVoice(participant.userId, participant.serverMuted ? 'unmute' : 'mute'))} danger={!participant.serverMuted}>
          {participant.serverMuted ? <Mic size={16} aria-hidden="true" /> : <MicOff size={16} aria-hidden="true" />}
          <span>{t(participant.serverMuted ? 'voice.serverUnmute' : 'voice.serverMute')}</span>
        </MenuItem>
      )}
      {targets.map((c) => (
        <MenuItem key={c.id} onSelect={act(() => moderateVoice(participant.userId, 'move', c.id))}>
          <ArrowRightLeft size={16} aria-hidden="true" />
          <span>{t('voice.moveTo', { channel: c.name })}</span>
        </MenuItem>
      ))}
      {canMove && (
        <MenuItem onSelect={act(() => moderateVoice(participant.userId, 'disconnect'))} danger>
          <PhoneOff size={16} aria-hidden="true" />
          <span>{t('voice.disconnectUser')}</span>
        </MenuItem>
      )}
    </Menu>
  );
}
