import { PhoneOff, SignalHigh, X } from 'lucide-react';
import { errorMessage, useT } from '../../i18n/index.js';
import { leaveVoice, useVoiceDirectory, useVoiceRuntime } from './runtime.js';
import { useVoiceStore, type VoiceNotice } from './state.js';
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

/**
 * The top row of the user panel (reference: it replaces the camera / screen / music row):
 * "Voice connected · <channel>" with the signal round trip and the disconnect button.
 * Renders nothing outside a call, except a pending voice notice.
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
      </section>
    </>
  );
}
