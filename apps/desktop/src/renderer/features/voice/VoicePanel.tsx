import { MonitorUp, MonitorX, PhoneOff, SignalHigh, Volume2, VolumeX, X } from 'lucide-react';
import { errorMessage, useT } from '../../i18n/index.js';
import { leaveVoice, useVoiceDirectory, useVoiceRuntime } from './runtime.js';
import { LiveBadge, TrackVideo } from './screenParts.js';
import { ScreenPickerHost } from './ScreenPicker.js';
import { screenQualityParts } from './screenShare.js';
import { useScreenShareButton } from './ScreenStage.js';
import { useScreenTracks } from './screenStore.js';
import { useVoiceStore, type ScreenSharing, type VoiceNotice } from './state.js';
import s from './voice.module.css';

function NoticeText({ notice }: { notice: VoiceNotice }) {
  const t = useT();
  switch (notice.kind) {
    case 'error':
      return <>{errorMessage(t, notice.code)}</>;
    case 'forceDisconnect':
      return <>{t('voice.notice.forceDisconnect')}</>;
    case 'dropped':
      return <>{t('voice.notice.dropped')}</>;
    case 'micUnavailable':
      return <>{t('voice.notice.micUnavailable')}</>;
    case 'screenFailed':
      return <>{t('voice.notice.screenFailed')}</>;
    case 'screenAudio':
      return <>{t('voice.notice.screenAudio')}</>;
  }
}

/** The last voice problem, until dismissed. */
export function VoiceNoticeBar() {
  const t = useT();
  const notice = useVoiceStore((v) => v.notice);
  const dispatch = useVoiceStore((v) => v.dispatch);
  if (!notice) return null;
  return (
    <div className={s.notice} role="alert" data-voice-notice={notice.kind}>
      <p>
        <NoticeText notice={notice} />
      </p>
      <button type="button" className={`${s.iconButton} ${s.noticeClose}`} aria-label={t('voice.notice.dismiss')} onClick={() => dispatch({ type: 'notice', notice: null })}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

/** While I share: a small preview of what goes out, the LIVE badge, the source and its quality. */
function SharingPreview({ sharing }: { sharing: ScreenSharing }) {
  const t = useT();
  const preview = useScreenTracks((st) => st.local);
  const sound = t(sharing.audio ? 'voice.screen.soundOn' : 'voice.screen.soundOff');
  return (
    <div className={s.sharing} data-screen-sharing="">
      <span className={s.sharingPreview}>
        <TrackVideo track={preview} className={s.streamVideo} label={t('voice.screen.preview')} />
      </span>
      <span className={s.sharingText}>
        <span className={s.sharingTitle}>
          <LiveBadge />
          <span className={s.sharingName}>{sharing.name}</span>
        </span>
        <span className={s.sharingMeta}>
          {t('voice.screen.qualityOption', screenQualityParts(sharing.quality))}
          {sharing.audio ? <Volume2 size={14} aria-label={sound} role="img" /> : <VolumeX size={14} aria-label={sound} role="img" />}
        </span>
      </span>
    </div>
  );
}

/** "Transmitir tela", or while live the preview and "Parar transmissão" (spec 2026-10-01 §2). */
function ScreenShareRow({ channelId }: { channelId: string }) {
  const sharing = useVoiceStore((v) => v.sharing);
  const button = useScreenShareButton(channelId);
  return (
    <>
      {sharing && <SharingPreview sharing={sharing} />}
      <button
        type="button"
        className={sharing ? `${s.panelWide} ${s.panelWideDanger}` : s.panelWide}
        aria-disabled={!button.enabled || undefined}
        title={button.title}
        onClick={button.onClick}
        data-screen-share={sharing ? 'stop' : 'start'}
      >
        {sharing ? <MonitorX size={18} aria-hidden="true" /> : <MonitorUp size={18} aria-hidden="true" />}
        <span>{button.label}</span>
      </button>
    </>
  );
}

/**
 * The top row of the user panel (reference: it replaces the camera / screen / music row):
 * "Voice connected · <channel>" with the signal round trip and the disconnect button, then
 * the screen share button (with the preview while live). Renders nothing outside a call,
 * except a pending voice notice.
 */
export function VoicePanel() {
  useVoiceRuntime();
  const t = useT();
  const call = useVoiceStore((v) => v.call);
  const pingMs = useVoiceStore((v) => v.pingMs);
  const directory = useVoiceDirectory();
  if (call.status === 'idle' || !call.channelId) return <VoiceNoticeBar />;
  const waiting = call.status !== 'connected';
  const title = t(call.status === 'connected' ? 'voice.connected' : call.status === 'connecting' ? 'voice.connecting' : 'voice.reconnecting');
  const locale = document.documentElement.lang || undefined;
  const ping = pingMs === null ? null : new Intl.NumberFormat(locale, { style: 'unit', unit: 'millisecond', unitDisplay: 'short' }).format(pingMs);

  return (
    <>
      <VoiceNoticeBar />
      <section className={s.panel} aria-label={title} data-voice-panel={call.status}>
        <div className={s.panelRow}>
          <SignalHigh size={20} className={waiting ? `${s.panelSignal} ${s.panelSignalWait}` : s.panelSignal} aria-hidden="true" />
          <div className={s.panelText}>
            <span className={waiting ? `${s.panelTitle} ${s.panelTitleWait}` : s.panelTitle} aria-live="polite">
              {title}
            </span>
            <span className={s.panelChannel}>{directory.channelName(call.channelId) ?? ''}</span>
          </div>
          {ping && (
            <span className={s.ping} title={t('voice.latency')}>
              {ping}
            </span>
          )}
          <button type="button" className={s.iconButton} aria-label={t('voice.disconnect')} title={t('voice.disconnect')} onClick={() => void leaveVoice()}>
            <PhoneOff size={18} aria-hidden="true" />
          </button>
        </div>
        <ScreenShareRow channelId={call.channelId} />
      </section>
      <ScreenPickerHost />
    </>
  );
}
