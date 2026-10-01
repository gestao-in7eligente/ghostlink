import { MonitorUp, MonitorX, Rss, SlidersHorizontal, Volume2, VolumeX, X } from 'lucide-react';
import { errorMessage, useT } from '../../i18n/index.js';
import { HangUpIcon } from './parts.js';
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

/** "Transmitir tela" / "Parar transmissão": an icon button of the panel's row (spec 2026-10-01 §2). */
function ScreenShareButton({ channelId }: { channelId: string }) {
  const sharing = useVoiceStore((v) => v.sharing !== null);
  const button = useScreenShareButton(channelId);
  return (
    <button
      type="button"
      className={sharing ? `${s.panelAction} ${s.panelActionDanger}` : s.panelAction}
      aria-disabled={!button.enabled || undefined}
      aria-label={button.label}
      title={button.title}
      onClick={button.onClick}
      data-screen-share={sharing ? 'stop' : 'start'}
    >
      {sharing ? <MonitorX size={20} aria-hidden="true" /> : <MonitorUp size={20} aria-hidden="true" />}
    </button>
  );
}

/**
 * The top of the user panel, like Discord's: the connection square, "Voz conectada" over
 * the channel, the signal round trip and the hang-up; the preview while I share; then a
 * row of equal buttons (Discord: camera, screen, activities, soundboard; here the screen
 * and, when the layout offers it, the voice settings). Renders nothing outside a call,
 * except a pending voice notice.
 */
export function VoicePanel({ onOpenSettings }: { onOpenSettings?: () => void }) {
  useVoiceRuntime();
  const t = useT();
  const call = useVoiceStore((v) => v.call);
  const pingMs = useVoiceStore((v) => v.pingMs);
  const sharing = useVoiceStore((v) => v.sharing);
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
          <span className={waiting ? `${s.panelSignal} ${s.panelSignalWait}` : s.panelSignal} aria-hidden="true">
            <Rss size={18} />
          </span>
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
          <button
            type="button"
            className={`${s.iconButton} ${s.panelHangUp}`}
            aria-label={t('voice.disconnect')}
            title={t('voice.disconnect')}
            onClick={() => void leaveVoice()}
          >
            <HangUpIcon size={16} />
          </button>
        </div>
        {sharing && <SharingPreview sharing={sharing} />}
        <div className={s.panelActions}>
          <ScreenShareButton channelId={call.channelId} />
          {onOpenSettings && (
            <button type="button" className={s.panelAction} aria-label={t('voice.openSettings')} title={t('voice.openSettings')} onClick={onOpenSettings}>
              <SlidersHorizontal size={20} aria-hidden="true" />
            </button>
          )}
        </div>
      </section>
      <ScreenPickerHost />
    </>
  );
}
