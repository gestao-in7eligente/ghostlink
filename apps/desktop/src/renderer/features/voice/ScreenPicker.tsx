// The screen picker (spec 2026-10-01 §2), in the style of Discord's: tabs for screens and
// windows with thumbnails, then quality, content and the PC's sound. The sources come from
// main (desktopCapturer) while the modal is already open.
import { AppWindow, Monitor } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type { ScreenSource, ScreenSourceKind } from '../../../shared/screenTypes.js';
import { useT } from '../../i18n/index.js';
import { Modal, Select, primitives as p } from '../../layout/primitives.js';
import {
  DEFAULT_SCREEN_CONTENT,
  DEFAULT_SCREEN_QUALITY,
  SCREEN_QUALITIES,
  screenQualityParts,
  type ScreenContent,
  type ScreenQuality,
  type ScreenSelection,
} from './screenShare.js';
import { useScreenPicker, type PickerRequest } from './screenStore.js';
import s from './voice.module.css';

/** The last options used, for the next time the picker opens (this run only). */
let lastOptions: { quality: ScreenQuality; content: ScreenContent; audio: boolean } = {
  quality: DEFAULT_SCREEN_QUALITY,
  content: DEFAULT_SCREEN_CONTENT,
  audio: true,
};

type Sources = { status: 'loading' } | { status: 'ready'; list: ScreenSource[] } | { status: 'failed' };

function SourceThumb({ source }: { source: ScreenSource }) {
  if (source.thumbnail) return <img className={s.sourceImage} src={source.thumbnail} alt="" draggable={false} />;
  if (source.icon) return <img className={s.sourceIconLarge} src={source.icon} alt="" draggable={false} />;
  return source.kind === 'screen' ? <Monitor size={40} className={s.sourceFallback} aria-hidden="true" /> : <AppWindow size={40} className={s.sourceFallback} aria-hidden="true" />;
}

function PickerDialog({ request }: { request: PickerRequest }) {
  const t = useT();
  const qualityId = useId();
  const contentId = useId();
  const audioHintId = useId();
  const [sources, setSources] = useState<Sources>({ status: 'loading' });
  const [tab, setTab] = useState<ScreenSourceKind>('screen');
  const [selected, setSelected] = useState<string | null>(null);
  const [quality, setQuality] = useState(lastOptions.quality);
  const [content, setContent] = useState<ScreenContent>(lastOptions.content);
  const [audio, setAudio] = useState(lastOptions.audio);

  useEffect(() => {
    let alive = true;
    request.sources.then(
      (list) => alive && setSources({ status: 'ready', list }),
      () => alive && setSources({ status: 'failed' }),
    );
    return () => {
      alive = false;
    };
  }, [request]);

  const list = sources.status === 'ready' ? sources.list : [];
  const shown = list.filter((x) => x.kind === tab);
  const chosen = list.find((x) => x.id === selected) ?? null;

  const share = (source: ScreenSource | null) => {
    if (!source) return;
    lastOptions = { quality, content, audio };
    const selection: ScreenSelection = { sourceId: source.id, name: source.name, quality, content, audio };
    request.answer(selection);
  };

  const tabButton = (kind: ScreenSourceKind, label: string) => (
    <button
      type="button"
      role="tab"
      id={`screen-tab-${kind}`}
      aria-selected={tab === kind}
      aria-controls="screen-sources"
      className={s.pickerTab}
      onClick={() => setTab(kind)}
    >
      {label}
    </button>
  );

  return (
    <Modal
      title={t('voice.screen.share')}
      size="medium"
      onClose={() => request.answer(null)}
      footer={
        <>
          <button type="button" className={p.button} onClick={() => request.answer(null)}>
            {t('common.cancel')}
          </button>
          <button type="button" className={`${p.button} ${p.buttonPrimary}`} disabled={!chosen} onClick={() => share(chosen)} data-screen-go="">
            {t('voice.screen.go')}
          </button>
        </>
      }
    >
      <div className={s.picker} data-screen-picker={sources.status}>
        <div className={s.pickerTabs} role="tablist" aria-label={t('voice.screen.share')}>
          {tabButton('screen', t('voice.screen.tabScreens'))}
          {tabButton('window', t('voice.screen.tabWindows'))}
        </div>
        <div id="screen-sources" role="tabpanel" aria-labelledby={`screen-tab-${tab}`} className={s.pickerPanel}>
          {sources.status === 'loading' ? (
            <div className={s.sources} aria-busy="true">
              <p className={s.srOnly} role="status">
                {t('voice.screen.loading')}
              </p>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className={s.sourceSkeleton} aria-hidden="true">
                  <span className={s.sourceThumb} />
                  <span className={s.skeletonLine} />
                </div>
              ))}
            </div>
          ) : sources.status === 'failed' ? (
            <p className={s.pickerEmpty} role="alert">
              {t('voice.screen.loadFailed')}
            </p>
          ) : shown.length === 0 ? (
            <p className={s.pickerEmpty}>{t(tab === 'screen' ? 'voice.screen.noScreens' : 'voice.screen.noWindows')}</p>
          ) : (
            <div className={s.sources} role="radiogroup" aria-label={t(tab === 'screen' ? 'voice.screen.tabScreens' : 'voice.screen.tabWindows')}>
              {shown.map((source) => (
                <button
                  key={source.id}
                  type="button"
                  role="radio"
                  aria-checked={selected === source.id}
                  className={s.source}
                  onClick={() => setSelected(source.id)}
                  onDoubleClick={() => share(source)}
                  data-screen-source={source.kind}
                >
                  <span className={s.sourceThumb}>
                    <SourceThumb source={source} />
                  </span>
                  <span className={s.sourceName}>
                    {source.icon && source.thumbnail && <img className={s.sourceIcon} src={source.icon} alt="" draggable={false} />}
                    <span>{source.name}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className={s.pickerOptions}>
          <div className={s.settingsGroup}>
            <span id={qualityId} className={s.settingsLabel}>
              {t('voice.screen.quality')}
            </span>
            <Select<ScreenQuality>
              labelledBy={qualityId}
              value={quality}
              options={SCREEN_QUALITIES.map((q) => ({ value: q, label: t('voice.screen.qualityOption', screenQualityParts(q)) }))}
              onChange={setQuality}
            />
          </div>
          <div className={s.settingsGroup}>
            <span id={contentId} className={s.settingsLabel}>
              {t('voice.screen.content')}
            </span>
            <Select<ScreenContent>
              labelledBy={contentId}
              value={content}
              options={[
                { value: 'detail', label: t('voice.screen.contentDetail') },
                { value: 'motion', label: t('voice.screen.contentMotion') },
              ]}
              onChange={setContent}
            />
          </div>
        </div>
        <label className={s.checkRow}>
          <input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} aria-describedby={audioHintId} data-screen-audio="" />
          <span className={s.checkText}>
            <span>{t('voice.screen.audio')}</span>
            <span id={audioHintId} className={s.checkHint}>
              {t('voice.screen.audioHint')}
            </span>
          </span>
        </label>
      </div>
    </Modal>
  );
}

/**
 * Shows the picker while the publishing flow waits for a choice. The runtime cancels it when
 * the call ends, so the flow never waits on a picker nobody sees.
 */
export function ScreenPickerHost() {
  const request = useScreenPicker((st) => st.request);
  if (!request) return null;
  return <PickerDialog key={request.id} request={request} />;
}
