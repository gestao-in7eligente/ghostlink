import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ListMusic, Music, Pause, Play, SkipForward, Square, Volume2 } from 'lucide-react';
import {
  GHOST_DJ_EQ_BANDS,
  GHOST_DJ_EQ_LIMITS,
  GHOST_DJ_EQ_PRESET_IDS,
  ghostDjStateSchemaClient,
  type GhostDjControlAction,
  type GhostDjEq,
  type GhostDjState,
} from '@ghostlink/shared';
import { errorCodeOf, useT } from '../../i18n/index.js';
import { ErrorText } from '../../layout/primitives.js';
import { useConnectionStore } from '../../stores/connection.js';
import { useSettingsStore } from '../../stores/settings.js';
import { useTextStore } from '../../stores/text.js';
import { request } from '../chat/actions.js';
import { useVoiceStore, viewVoice } from '../voice/state.js';
import { useNow } from './BotParts.js';
import { bandLabel, canControlDj, djPosition, djStateOf, formatClock, formatGain, withBand } from './djModel.js';
import g from './botPage.module.css';
import d from './djPanel.module.css';

/** At most this often while a slider is dragged: the newest value always goes last. */
const SEND_EVERY_MS = 80;

/**
 * Sends the newest value, one request at a time: a value set while one is on its way replaces
 * the one waiting. `done` runs once nothing is left to send.
 */
function useLatestSender<T>(send: (value: T) => Promise<unknown>, done: () => void): (value: T) => void {
  const waiting = useRef<{ value: T } | null>(null);
  const busy = useRef(false);
  const latest = useRef({ send, done });
  latest.current = { send, done };
  return useCallback((value: T) => {
    waiting.current = { value };
    if (busy.current) return;
    busy.current = true;
    void (async () => {
      while (waiting.current) {
        const next = waiting.current.value;
        waiting.current = null;
        await latest.current.send(next).catch(() => undefined);
        await new Promise((r) => setTimeout(r, SEND_EVERY_MS));
      }
      busy.current = false;
      latest.current.done();
    })();
  }, []);
}

/**
 * The Ghost DJ's panel on its page (v0.5.1, spec 2026-10-02-ghost-dj-som-e-equalizador §2): what
 * plays (title, who asked, the position), pause/continue, skip, stop, the volume and the
 * equalizer (5 bands and the presets). Live through `dj.state`; read only for whoever is not
 * in its voice channel (the slash commands' rule, which the server checks too).
 */
export function DjPanel() {
  const t = useT();
  const locale = useSettingsStore((st) => st.settings?.locale ?? 'pt-BR');
  const serverId = useConnectionStore((st) => st.welcome?.serverId ?? null);
  const channelNames = useTextStore((st) => st.channels.byId);
  const voiceChannels = useVoiceStore((v) => viewVoice(v).channels);
  const selfUserId = useVoiceStore((v) => viewVoice(v).selfUserId);
  const [view, setView] = useState<{ state: GhostDjState; at: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [eqDraft, setEqDraft] = useState<GhostDjEq | null>(null);
  const [volumeDraft, setVolumeDraft] = useState<number | null>(null);
  const now = useNow(500);
  const volumeId = useId();

  const take = useCallback((state: GhostDjState) => setView({ state, at: Date.now() }), []);

  // The state now, again after a reconnect, and every dj.state the server sends meanwhile.
  useEffect(() => {
    if (serverId === null) return;
    let current = true;
    const load = () =>
      request('dj.state', {}, ghostDjStateSchemaClient).then(
        (state) => current && take(state),
        (e: unknown) => current && setError(errorCodeOf(e)),
      );
    void load();
    const off = window.ghostlink.onServerEvent((event, from) => {
      if (from !== serverId) return;
      if (event.t === 'welcome') void load();
      const state = djStateOf(event);
      if (state) take(state);
    });
    return () => {
      current = false;
      off();
    };
  }, [serverId, take]);

  /** A panel request: its answer is the new state; a refusal shows under the controls. */
  const act = useCallback(
    async (type: string, payload: Record<string, unknown>) => {
      try {
        setError(null);
        take(await request(type, payload, ghostDjStateSchemaClient));
      } catch (e) {
        setError(errorCodeOf(e));
      }
    },
    [take],
  );
  const sendEq = useLatestSender((eq: GhostDjEq) => act('dj.eq', { gains: eq.gains }), () => setEqDraft(null));
  const sendVolume = useLatestSender((volume: number) => act('dj.volume', { volume }), () => setVolumeDraft(null));

  if (view === null) return error ? <ErrorText code={error} /> : null;
  const { state } = view;
  const control = canControlDj(state, voiceChannels, selfUserId);
  const channelName = state.channelId !== null && Object.hasOwn(channelNames, state.channelId) ? `🔊 ${channelNames[state.channelId]!.name}` : null;
  const current = state.current;
  const position = djPosition(state, view.at, now);
  const length = current?.durationSec ?? null;
  const eq = eqDraft ?? state.eq;
  const volume = volumeDraft ?? state.volume;
  const hint = control ? null : channelName ? t('dj.control.readOnly', { channel: channelName }) : t('dj.control.readOnlyIdle');
  const button = (action: GhostDjControlAction, label: string, icon: ReactNode, enabled: boolean) => (
    <button type="button" className={d.control} disabled={!control || !enabled} aria-label={label} title={label} onClick={() => void act('dj.control', { action })} data-dj-control={action}>
      {icon}
    </button>
  );

  return (
    <>
      <section aria-labelledby="dj-now" data-dj-panel>
        <h2 id="dj-now" className={g.sectionTitle}>
          {t('dj.now.title')}
        </h2>
        <div className={d.card}>
          {current ? (
            <div className={d.track}>
              <span className={d.cover} aria-hidden="true">
                <Music size={22} />
              </span>
              <div className={d.trackText}>
                <p className={d.title} title={current.url} data-dj-title>
                  {current.title}
                </p>
                <p className={d.meta}>
                  {t('dj.now.requestedBy', { name: current.requesterName })}
                  {channelName && ` · ${t('dj.now.in', { channel: channelName })}`}
                  {state.paused && <span className={d.paused}>{t('dj.now.paused')}</span>}
                </p>
              </div>
            </div>
          ) : (
            <div className={d.nothing} data-dj-nothing>
              <p className={d.title}>{t('dj.now.nothing')}</p>
              <p className={d.meta}>{t('dj.now.nothingHint')}</p>
            </div>
          )}
          {current && (
            <div className={d.progress} aria-label={length === null ? formatClock(position) : t('dj.now.position', { at: formatClock(position), length: formatClock(length) })} role="group">
              <span className={d.clock}>{formatClock(position)}</span>
              <div className={d.bar}>
                <div className={d.fill} style={{ width: length ? `${Math.min(100, (position / length) * 100)}%` : '0%' }} />
              </div>
              <span className={d.clock}>{length === null ? '—' : formatClock(length)}</span>
            </div>
          )}
          <div className={d.controls}>
            {state.paused
              ? button('resume', t('dj.control.resume'), <Play size={18} />, current !== null)
              : button('pause', t('dj.control.pause'), <Pause size={18} />, current !== null)}
            {button('skip', t('dj.control.skip'), <SkipForward size={18} />, current !== null)}
            {button('stop', t('dj.control.stop'), <Square size={16} />, state.channelId !== null)}
            <div className={d.volume}>
              <Volume2 size={18} aria-hidden="true" />
              <label htmlFor={volumeId} className={d.srOnly}>
                {t('dj.control.volume')}
              </label>
              <input
                id={volumeId}
                className={d.range}
                type="range"
                min={0}
                max={100}
                step={1}
                value={volume}
                disabled={!control}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setVolumeDraft(v);
                  sendVolume(v);
                }}
                data-dj-volume
              />
              <span className={d.volumeValue}>{volume}</span>
            </div>
          </div>
          {state.queueLength > 0 && (
            <div className={d.next}>
              <p className={d.nextTitle}>
                <ListMusic size={14} aria-hidden="true" /> {t('dj.now.next', { count: state.queueLength })}
              </p>
              <ol className={d.nextList}>
                {state.next.map((track, i) => (
                  <li key={`${i}-${track.url}`}>
                    <span className={d.nextName}>{track.title}</span>
                    <span className={d.nextBy}>{track.requesterName}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {hint && (
            <p className={d.hint} data-dj-readonly>
              {hint}
            </p>
          )}
          {error && <ErrorText code={error} />}
        </div>
      </section>

      <section aria-labelledby="dj-eq" data-dj-eq>
        <h2 id="dj-eq" className={g.sectionTitle}>
          {t('dj.eq.title')} — {t(`dj.eq.preset.${eq.preset}`)}
        </h2>
        <div className={d.card}>
          <div className={d.presets} role="group" aria-label={t('dj.eq.presets')}>
            {GHOST_DJ_EQ_PRESET_IDS.map((preset) => (
              <button
                key={preset}
                type="button"
                className={d.preset}
                aria-pressed={eq.preset === preset}
                disabled={!control}
                onClick={() => {
                  setEqDraft(null);
                  void act('dj.eq', { preset });
                }}
                data-dj-preset={preset}
              >
                {t(`dj.eq.preset.${preset}`)}
              </button>
            ))}
            {eq.preset === 'custom' && (
              <span className={d.custom} data-dj-preset-custom>
                {t('dj.eq.preset.custom')}
              </span>
            )}
          </div>
          <div className={d.bands}>
            {GHOST_DJ_EQ_BANDS.map((freq, band) => {
              const label = bandLabel(freq, locale);
              const gain = eq.gains[band] ?? 0;
              return (
                <div key={freq} className={d.band}>
                  <span className={d.gain}>{t('dj.eq.gain', { gain: formatGain(gain) })}</span>
                  <input
                    className={d.vertical}
                    type="range"
                    min={GHOST_DJ_EQ_LIMITS.minGain}
                    max={GHOST_DJ_EQ_LIMITS.maxGain}
                    step={1}
                    value={gain}
                    disabled={!control}
                    aria-label={t('dj.eq.band', { freq: label })}
                    aria-valuetext={t('dj.eq.gain', { gain: formatGain(gain) })}
                    onChange={(e) => {
                      const next = withBand(eq, band, Number(e.target.value));
                      setEqDraft(next);
                      sendEq(next);
                    }}
                    data-dj-band={freq}
                  />
                  <span className={d.freq}>{label}</span>
                </div>
              );
            })}
          </div>
          <p className={d.hint}>{t('dj.eq.hint')}</p>
        </div>
      </section>
    </>
  );
}
