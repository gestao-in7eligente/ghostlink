// Small pieces of the screen-sharing UI: a LiveKit video in a <video>, the LIVE badge and
// the stream volume.
import type { Track } from 'livekit-client';
import { Volume2, VolumeX } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import { useT } from '../../i18n/index.js';
import { setScreenVolume } from './runtime.js';
import { MAX_VOLUME, screenVolumeKey, useVoiceSettings, volumeOf } from './settings.js';
import { useVoiceStore, viewVoice } from './state.js';
import s from './voice.module.css';

/**
 * A LiveKit video track in a <video>: track.attach(el) on mount, detach on unmount (spec
 * §8.4: never a hand-made srcObject). Remote tracks then follow the element's size
 * (adaptiveStream picks the simulcast layer).
 */
export function TrackVideo({ track, className, label, userId }: { track: Track | null; className?: string; label?: string; userId?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !track) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);
  return <video ref={ref} className={className} autoPlay playsInline muted aria-label={label} data-screen-video={userId} />;
}

/** The red "AO VIVO" pill (Discord's LIVE). */
export function LiveBadge() {
  const t = useT();
  return (
    <span className={s.liveBadge} data-screen-live-badge="">
      {t('voice.screen.live')}
    </span>
  );
}

/** A stream's volume, 0–200 %, saved apart from that person's voice. Inline, so it works in fullscreen. */
export function StreamVolume({ userId }: { userId: string }) {
  const t = useT();
  const id = useId();
  const serverId = useVoiceStore((v) => viewVoice(v).serverId);
  const volume = useVoiceSettings((st) => volumeOf(st.settings, serverId, screenVolumeKey(userId)));
  const percent = new Intl.NumberFormat(document.documentElement.lang || undefined, { style: 'percent' }).format(volume / 100);
  return (
    <span className={s.streamVolume} title={`${t('voice.screen.volume')}: ${percent}`}>
      <label htmlFor={id} className={s.streamVolumeIcon}>
        {volume === 0 ? <VolumeX size={18} aria-hidden="true" /> : <Volume2 size={18} aria-hidden="true" />}
        <span className={s.srOnly}>{t('voice.screen.volume')}</span>
      </label>
      <input
        id={id}
        className={s.range}
        type="range"
        min={0}
        max={MAX_VOLUME}
        step={5}
        value={volume}
        aria-valuetext={percent}
        onChange={(e) => setScreenVolume(userId, Number(e.target.value))}
        data-screen-volume={userId}
      />
    </span>
  );
}
