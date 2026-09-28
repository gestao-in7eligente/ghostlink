import { Room } from 'livekit-client';
import { Check, ChevronUp, HeadphoneOff, Headphones, Mic, MicOff, Settings } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useT } from '../../i18n/index.js';
import { Menu, MenuItem } from './parts.js';
import { toggleDeafen, toggleMute, useVoiceRuntime } from './runtime.js';
import { useVoiceSettings } from './settings.js';
import { selfVoice, useVoiceStore } from './state.js';
import s from './voice.module.css';

type DeviceKind = 'audioinput' | 'audiooutput';

/** Real devices only: Chromium's "default"/"communications" aliases are the system default entry. */
export function useDevices(kind: DeviceKind, active: boolean): MediaDeviceInfo[] {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const load = () =>
      Room.getLocalDevices(kind, true).then(
        (list) => alive && setDevices(list.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications' && d.deviceId !== '')),
        () => alive && setDevices([]),
      );
    void load();
    navigator.mediaDevices?.addEventListener('devicechange', load);
    return () => {
      alive = false;
      navigator.mediaDevices?.removeEventListener('devicechange', load);
    };
  }, [kind, active]);
  return devices;
}

function DeviceMenu({ kind, onClose, onOpenSettings }: { kind: DeviceKind; onClose(): void; onOpenSettings?: () => void }) {
  const t = useT();
  const devices = useDevices(kind, true);
  const selected = useVoiceSettings((st) => (kind === 'audioinput' ? st.settings.inputDeviceId : st.settings.outputDeviceId));
  const update = useVoiceSettings((st) => st.update);
  const choose = (deviceId: string | null) => {
    update(kind === 'audioinput' ? { inputDeviceId: deviceId } : { outputDeviceId: deviceId });
    onClose();
  };
  const label = t(kind === 'audioinput' ? 'voice.inputDevice' : 'voice.outputDevice');
  return (
    <Menu label={label} placement="up" onClose={onClose}>
      <p className={s.menuTitle} aria-hidden="true">
        {label}
      </p>
      <MenuItem checked={selected === null} onSelect={() => choose(null)}>
        <span>{t('voice.defaultDevice')}</span>
        {selected === null && <Check size={16} className={s.menuCheck} aria-hidden="true" />}
      </MenuItem>
      {devices.map((d, i) => (
        <MenuItem key={d.deviceId} checked={selected === d.deviceId} onSelect={() => choose(d.deviceId)}>
          <span>{d.label || t('voice.deviceUnnamed', { n: i + 1 })}</span>
          {selected === d.deviceId && <Check size={16} className={s.menuCheck} aria-hidden="true" />}
        </MenuItem>
      ))}
      {onOpenSettings && (
        <>
          <div className={s.menuSeparator} role="separator" />
          <MenuItem
            onSelect={() => {
              onClose();
              onOpenSettings();
            }}
          >
            <Settings size={16} aria-hidden="true" />
            <span>{t('voice.openSettings')}</span>
          </MenuItem>
        </>
      )}
    </Menu>
  );
}

/**
 * The microphone and headphones buttons of the user panel, each with its ▴ device menu
 * (reference, bottom row). They work outside a call too: the choice applies on joining.
 */
export function VoiceControls({ onOpenSettings }: { onOpenSettings?: () => void }) {
  useVoiceRuntime();
  const t = useT();
  const muted = useVoiceStore((v) => v.selfMuted || v.selfDeafened);
  const deafened = useVoiceStore((v) => v.selfDeafened);
  const serverMuted = useVoiceStore((v) => selfVoice(v)?.serverMuted ?? false);
  const [open, setOpen] = useState<DeviceKind | null>(null);
  const micLabel = serverMuted ? t('voice.serverMuted') : t(muted ? 'voice.unmute' : 'voice.mute');
  const soundLabel = t(deafened ? 'voice.undeafen' : 'voice.deafen');

  return (
    <div className={s.controls}>
      <div className={s.anchor}>
        <button
          type="button"
          className={serverMuted ? `${s.iconButton} ${s.iconDanger}` : s.iconButton}
          aria-pressed={muted || serverMuted}
          aria-label={micLabel}
          title={micLabel}
          disabled={serverMuted}
          onClick={() => void toggleMute()}
          data-voice-control="mute"
        >
          {muted || serverMuted ? <MicOff size={18} aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}
        </button>
        <button
          type="button"
          className={`${s.iconButton} ${s.chevron}`}
          aria-haspopup="menu"
          aria-expanded={open === 'audioinput'}
          aria-label={t('voice.inputOptions')}
          title={t('voice.inputOptions')}
          onClick={() => setOpen(open === 'audioinput' ? null : 'audioinput')}
        >
          <ChevronUp size={12} aria-hidden="true" />
        </button>
        {open === 'audioinput' && <DeviceMenu kind="audioinput" onClose={() => setOpen(null)} onOpenSettings={onOpenSettings} />}
      </div>
      <div className={s.anchor}>
        <button
          type="button"
          className={s.iconButton}
          aria-pressed={deafened}
          aria-label={soundLabel}
          title={soundLabel}
          onClick={() => void toggleDeafen()}
          data-voice-control="deafen"
        >
          {deafened ? <HeadphoneOff size={18} aria-hidden="true" /> : <Headphones size={18} aria-hidden="true" />}
        </button>
        <button
          type="button"
          className={`${s.iconButton} ${s.chevron}`}
          aria-haspopup="menu"
          aria-expanded={open === 'audiooutput'}
          aria-label={t('voice.outputOptions')}
          title={t('voice.outputOptions')}
          onClick={() => setOpen(open === 'audiooutput' ? null : 'audiooutput')}
        >
          <ChevronUp size={12} aria-hidden="true" />
        </button>
        {open === 'audiooutput' && <DeviceMenu kind="audiooutput" onClose={() => setOpen(null)} onOpenSettings={onOpenSettings} />}
      </div>
    </div>
  );
}
