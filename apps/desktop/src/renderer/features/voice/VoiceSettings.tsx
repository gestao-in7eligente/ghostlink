import { useEffect, useId, useState } from 'react';
import { useT } from '../../i18n/index.js';
import { Select, type SelectOption } from '../../layout/primitives.js';
import l from '../../layout/settings.module.css';
import { startLevelMeter } from './gateProcessor.js';
import { SILENCE_DB } from './gateLogic.js';
import { keyLabel } from './keys.js';
import { captureFor } from './noiseSuppression.js';
import { resolveNoiseSuppression, setKeyCapture, useNoiseStatus, useVoiceRuntime, voiceAudioContext } from './runtime.js';
import { MIN_THRESHOLD_DB, NOISE_SUPPRESSIONS, isPttCode, useVoiceSettings, type NoiseSuppression } from './settings.js';
import { useVoiceStore } from './state.js';
import { useDevices } from './VoiceControls.js';
import { VideoSettings } from './VideoSettings.js';
import s from './voice.module.css';

/**
 * The microphone level: the call's gate while in a call, else a test stream on demand,
 * through the chosen noise suppression like a call (noise spec §2).
 */
function useMicLevel(testing: boolean, deviceId: string | null, noise: NoiseSuppression): number {
  const inCall = useVoiceStore((v) => v.call.status !== 'idle');
  const callLevel = useVoiceStore((v) => v.inputLevelDb);
  const [testLevel, setTestLevel] = useState(SILENCE_DB);
  useEffect(() => {
    if (!testing || inCall) return;
    let stopMeter: (() => void) | null = null;
    let stream: MediaStream | null = null;
    let alive = true;
    void (async () => {
      const { mode, suppressor } = await resolveNoiseSuppression(noise);
      try {
        if (!alive) return;
        const s = await navigator.mediaDevices.getUserMedia({ audio: { ...(deviceId ? { deviceId } : {}), ...captureFor(mode) } });
        stream = s;
        if (!alive) return;
        stopMeter = startLevelMeter(s, voiceAudioContext(), setTestLevel, suppressor);
      } catch {
        setTestLevel(SILENCE_DB);
      } finally {
        if (!stopMeter) suppressor?.destroy();
        if (!alive) stream?.getTracks().forEach((t) => t.stop());
      }
    })();
    return () => {
      alive = false;
      stopMeter?.();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [testing, inCall, deviceId, noise]);
  return inCall ? callLevel : testLevel;
}

function Meter({ levelDb, thresholdDb, gated }: { levelDb: number; thresholdDb: number; gated: boolean }) {
  const t = useT();
  const pct = (db: number) => `${Math.max(0, Math.min(100, ((db - MIN_THRESHOLD_DB) / -MIN_THRESHOLD_DB) * 100))}%`;
  const open = gated && levelDb >= thresholdDb;
  return (
    <div className={s.meter} role="meter" aria-label={t('voice.settings.level')} aria-valuemin={MIN_THRESHOLD_DB} aria-valuemax={0} aria-valuenow={Math.round(levelDb)}>
      <span className={open ? `${s.meterFill} ${s.meterFillOpen}` : s.meterFill} style={{ width: pct(levelDb) }} />
      {gated && <span className={s.meterMark} style={{ left: pct(thresholdDb) }} />}
    </div>
  );
}

/** How the failure note names a suppressor (product names, the same in every language). */
const SUPPRESSOR_NAMES: Readonly<Record<NoiseSuppression, string>> = { rnnoise: 'RNNoise', speex: 'Speex', gtcrn: 'GTCRN', webrtc: 'WebRTC', off: '' };

/**
 * Voice settings (spec §11.1 item 7): input and output devices, the input level and the
 * voice-activity threshold, voice activity or push-to-talk and its key, noise suppression
 * (noise spec §1) and the call sounds (v0.5.2). Embedded in the user settings screen, whose
 * tab gives it its title; per-user volume lives in each participant's menu.
 */
export function VoiceSettings() {
  useVoiceRuntime();
  const t = useT();
  const ids = { input: useId(), output: useId(), sensitivity: useId(), mode: useId(), noise: useId() };
  const settings = useVoiceSettings((st) => st.settings);
  const update = useVoiceSettings((st) => st.update);
  const globalPtt = useVoiceStore((v) => v.globalPtt);
  const inCall = useVoiceStore((v) => v.call.status !== 'idle');
  const inputs = useDevices('audioinput', true);
  const outputs = useDevices('audiooutput', true);
  const [testing, setTesting] = useState(false);
  const [recording, setRecording] = useState(false);
  const level = useMicLevel(testing, settings.inputDeviceId, settings.noiseSuppression);
  const noiseFailed = useNoiseStatus((n) => n.failed.includes(settings.noiseSuppression));
  const noiseInUse = useNoiseStatus((n) => n.inUse);

  useEffect(() => {
    if (!recording) return;
    setKeyCapture(true);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code !== 'Escape' && isPttCode(e.code)) update({ pttCode: e.code });
      setRecording(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      setKeyCapture(false);
    };
  }, [recording, update]);

  // '' is the system default device.
  const deviceOptions = (list: MediaDeviceInfo[]): SelectOption<string>[] => [
    { value: '', label: t('voice.defaultDevice') },
    ...list.map((d, i) => ({ value: d.deviceId, label: d.label || t('voice.deviceUnnamed', { n: i + 1 }) })),
  ];
  const noiseOptions = NOISE_SUPPRESSIONS.map((mode) => ({ value: mode, label: t(`voice.noise.${mode}`) }));

  return (
    <section className={s.settings} data-voice-settings="">
      <div className={s.twoColumns}>
        <div className={s.settingsGroup}>
          <span id={ids.input} className={s.settingsLabel}>
            {t('voice.inputDevice')}
          </span>
          <Select labelledBy={ids.input} value={settings.inputDeviceId ?? ''} options={deviceOptions(inputs)} onChange={(v) => update({ inputDeviceId: v || null })} />
        </div>
        <div className={s.settingsGroup}>
          <span id={ids.output} className={s.settingsLabel}>
            {t('voice.outputDevice')}
          </span>
          <Select labelledBy={ids.output} value={settings.outputDeviceId ?? ''} options={deviceOptions(outputs)} onChange={(v) => update({ outputDeviceId: v || null })} />
        </div>
      </div>

      <fieldset className={s.settingsGroup} style={{ border: 0, margin: 0, padding: 0 }}>
        <legend className={s.settingsLabel}>{t('voice.settings.mode')}</legend>
        <label className={s.radioRow}>
          <input type="radio" name={ids.mode} checked={settings.mode === 'vad'} onChange={() => update({ mode: 'vad' })} />
          {t('voice.settings.vad')}
        </label>
        <label className={s.radioRow}>
          <input type="radio" name={ids.mode} checked={settings.mode === 'ptt'} onChange={() => update({ mode: 'ptt' })} />
          {t('voice.settings.ptt')}
        </label>
      </fieldset>

      {settings.mode === 'ptt' && (
        <div className={s.settingsGroup}>
          <span className={s.settingsLabel}>{t('voice.settings.key')}</span>
          <div className={s.keyRow}>
            <kbd className={recording ? `${s.kbd} ${s.kbdRecording}` : s.kbd} aria-live="polite">
              {recording ? t('voice.settings.pressKey') : settings.pttCode ? keyLabel(settings.pttCode, t) : t('voice.settings.noKey')}
            </kbd>
            <button type="button" className={s.secondary} onClick={() => setRecording(!recording)} data-voice-record-key="">
              {settings.pttCode ? t('voice.settings.changeKey') : t('voice.settings.recordKey')}
            </button>
          </div>
          {settings.pttCode && <p className={s.hint}>{t(globalPtt ? 'voice.settings.globalOn' : 'voice.settings.globalOff')}</p>}
        </div>
      )}

      <div className={s.settingsGroup}>
        <label className={s.settingsLabel} htmlFor={ids.sensitivity}>
          {settings.mode === 'vad' ? t('voice.settings.sensitivity') : t('voice.settings.micTest')}
        </label>
        <Meter levelDb={level} thresholdDb={settings.thresholdDb} gated={settings.mode === 'vad'} />
        {settings.mode === 'vad' && (
          <>
            <input
              id={ids.sensitivity}
              className={s.range}
              type="range"
              min={MIN_THRESHOLD_DB}
              max={0}
              step={1}
              value={settings.thresholdDb}
              aria-valuetext={`${settings.thresholdDb} dB`}
              onChange={(e) => update({ thresholdDb: Number(e.target.value) })}
            />
            <p className={s.hint}>{t('voice.settings.sensitivityHint')}</p>
          </>
        )}
        {!inCall && (
          <div>
            <button type="button" className={s.secondary} aria-pressed={testing} onClick={() => setTesting(!testing)}>
              {testing ? t('voice.settings.micTestStop') : t('voice.settings.micTestStart')}
            </button>
          </div>
        )}
      </div>

      <div className={s.settingsGroup} data-voice-noise={noiseInUse ?? ''}>
        <span id={ids.noise} className={s.settingsLabel}>
          {t('voice.settings.noise')}
        </span>
        <Select labelledBy={ids.noise} value={settings.noiseSuppression} options={noiseOptions} onChange={(v) => update({ noiseSuppression: v })} />
        <p className={s.hint}>{t('voice.settings.noiseHint')}</p>
        {noiseFailed && (
          <p className={s.noiseFailed} role="status">
            {t('voice.settings.noiseFailed', { mode: SUPPRESSOR_NAMES[settings.noiseSuppression] })}
          </p>
        )}
      </div>

      <label className={l.perm} data-voice-call-sounds="">
        <span className={l.permText}>
          <span className={l.permName}>{t('voice.settings.callSounds')}</span>
          <span className={l.hint}>{t('voice.settings.callSoundsHint')}</span>
        </span>
        <input type="checkbox" role="switch" className={l.switch} checked={settings.callSounds} onChange={(e) => update({ callSounds: e.target.checked })} />
      </label>

      <p className={s.hint}>{t('voice.settings.volumeHint')}</p>
      <VideoSettings />
    </section>
  );
}
