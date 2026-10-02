import { RotateCcw } from 'lucide-react';
import { useId } from 'react';
import { useT } from '../../i18n/index.js';
import { MenuItem } from '../../layout/primitives.js';
import { setUserVolume } from './runtime.js';
import { MAX_VOLUME, useVoiceSettings, volumeOf } from './settings.js';
import { useVoiceStore, viewVoice } from './state.js';
import s from './voice.module.css';

/**
 * Someone's volume for me, inside their menu: 0–200 %, saved per server (the one on screen) and
 * user (spec §8.4), with a reset. The arrows up and down move past it; left and right change it.
 */
export function UserVolume({ userId }: { userId: string }) {
  const t = useT();
  const sliderId = useId();
  const serverId = useVoiceStore((v) => viewVoice(v).serverId);
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
        <MenuItem icon={<RotateCcw size={16} aria-hidden="true" />} onSelect={() => setUserVolume(userId, 100)}>
          {t('voice.resetVolume')}
        </MenuItem>
      )}
    </>
  );
}
