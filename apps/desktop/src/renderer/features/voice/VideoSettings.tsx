import { createLocalVideoTrack, type LocalVideoTrack } from 'livekit-client';
import { VideoOff } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useT } from '../../i18n/index.js';
import { Select, type SelectOption } from '../../layout/primitives.js';
import { CAMERA_QUALITIES, DEFAULT_CAMERA_QUALITY, cameraCaptureOptions, cameraQualityParts, type CameraQuality } from './camera.js';
import { CameraVideo } from './CameraParts.js';
import { useCameraTracks } from './cameraStore.js';
import { useVoiceSettings } from './settings.js';
import { useDevices } from './VoiceControls.js';
import s from './voice.module.css';
import v from './VideoSettings.module.css';

/**
 * What the preview shows: my camera in the call when it is on (nothing else is opened), else,
 * while testing, a camera of its own with the chosen device and quality. That one stops when
 * the test stops or the section closes (spec 2026-10-01-camera §2).
 */
function useCameraPreview(testing: boolean, deviceId: string | null, quality: CameraQuality): { track: LocalVideoTrack | null; failed: boolean } {
  const callCamera = useCameraTracks((st) => st.local);
  const [test, setTest] = useState<LocalVideoTrack | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (!testing || callCamera) return;
    let alive = true;
    let opened: LocalVideoTrack | null = null;
    createLocalVideoTrack(cameraCaptureOptions(quality, deviceId)).then(
      (track) => {
        opened = track;
        if (alive) setTest(track);
        else track.stop();
      },
      () => {
        if (alive) setFailed(true);
      },
    );
    return () => {
      alive = false;
      opened?.stop();
      setTest(null);
    };
  }, [testing, callCamera, deviceId, quality]);
  return { track: callCamera ?? test, failed };
}

/**
 * The video half of "Voz e vídeo" (spec 2026-10-01-camera §2): the camera (the app's
 * Select), a live preview ("Testar câmera", or my camera while it is on in a call) and the
 * quality my camera sends.
 */
export function VideoSettings() {
  const t = useT();
  const ids = { camera: useId(), quality: useId(), title: useId() };
  const deviceId = useVoiceSettings((st) => st.settings.cameraDeviceId);
  const quality = useVoiceSettings((st) => st.settings.cameraQuality);
  const update = useVoiceSettings((st) => st.update);
  const cameras = useDevices('videoinput', true);
  const inCall = useCameraTracks((st) => st.local !== null);
  const [testing, setTesting] = useState(false);
  const preview = useCameraPreview(testing, deviceId, quality);

  // '' is the system's first camera.
  const cameraOptions: SelectOption<string>[] = [
    { value: '', label: t('voice.defaultDevice') },
    ...cameras.map((d, i) => ({ value: d.deviceId, label: d.label || t('voice.deviceUnnamed', { n: i + 1 }) })),
  ];
  const qualityOptions: SelectOption<CameraQuality>[] = CAMERA_QUALITIES.map((q) => ({
    value: q,
    label: t('voice.screen.qualityOption', cameraQualityParts(q)),
    ...(q === DEFAULT_CAMERA_QUALITY ? { hint: t('voice.settings.cameraQualityDefault') } : {}),
  }));

  return (
    <div className={v.video} role="group" aria-labelledby={ids.title} data-video-settings="">
      <h4 id={ids.title} className={v.title}>
        {t('voice.settings.video')}
      </h4>

      <div className={v.preview} role="img" aria-label={t('voice.settings.cameraPreview')} data-camera-preview="">
        <span className={v.previewEmpty}>
          <VideoOff size={32} aria-hidden="true" />
          {t('voice.settings.cameraPreviewOff')}
        </span>
        {preview.track && <CameraVideo track={preview.track} mirrored />}
      </div>
      {inCall ? (
        <p className={s.hint}>{t('voice.settings.cameraInCall')}</p>
      ) : (
        <div>
          <button type="button" className={s.secondary} aria-pressed={testing} onClick={() => setTesting(!testing)} data-camera-test="">
            {testing ? t('voice.settings.cameraTestStop') : t('voice.settings.cameraTest')}
          </button>
        </div>
      )}
      {preview.failed && (
        <p className={v.warning} role="status">
          {t('voice.notice.cameraUnavailable')}
        </p>
      )}

      <div className={s.twoColumns}>
        <div className={s.settingsGroup}>
          <span id={ids.camera} className={s.settingsLabel}>
            {t('voice.camera.device')}
          </span>
          <Select labelledBy={ids.camera} value={deviceId ?? ''} options={cameraOptions} onChange={(id) => update({ cameraDeviceId: id || null })} />
          {cameras.length === 0 && <p className={s.hint}>{t('voice.settings.noCamera')}</p>}
        </div>
        <div className={s.settingsGroup}>
          <span id={ids.quality} className={s.settingsLabel}>
            {t('voice.settings.cameraQuality')}
          </span>
          <Select labelledBy={ids.quality} value={quality} options={qualityOptions} onChange={(q) => update({ cameraQuality: q })} />
        </div>
      </div>
      <p className={s.hint}>{t('voice.settings.cameraQualityHint')}</p>
    </div>
  );
}
