import { MonitorUp, MonitorX, PhoneCall, Volume2 } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { VoiceParticipant } from '@ghostlink/shared';
import { useT } from '../../i18n/index.js';
import { useProfileCardStore } from '../profileCard/profileCardStore.js';
import { userMenuTriggers, type UserMenuRequest } from '../userMenu/triggers.js';
import { UserMenuFor } from '../userMenu/UserMenu.js';
import { CameraVideo } from './CameraParts.js';
import { useCameraTrack } from './cameraStore.js';
import { HangUpIcon, StateIcons, VoiceAvatar, hasStateIcons } from './parts.js';
import { joinVoice, leaveVoice, useVoiceDirectory, useVoiceRuntime } from './runtime.js';
import { LiveBadge } from './screenParts.js';
import { OwnStreamTile, StreamTile, StreamView, useScreenShareButton } from './ScreenStage.js';
import { isSpeaking, liveIn, participantsOf, streamLayout, useVoiceStore, viewVoice } from './state.js';
import { fitTiles, type TileLayout } from './tileLayout.js';
import { CallAudioControls } from './VoiceControls.js';
import s from './voice.module.css';

const NONE: string[] = [];

/** A person's tile: a click opens their profile card, the right click (menu key, Shift+F10) their menu. */
function Tile({ p, isSelf, speaking, receiving }: { p: VoiceParticipant; isSelf: boolean; speaking: boolean; receiving: boolean }) {
  const t = useT();
  const directory = useVoiceDirectory();
  const [menu, setMenu] = useState<UserMenuRequest | null>(null);
  const name = directory.displayName(p.userId);
  // Their camera over the photo (mine mirrored, on my screen only): spec 2026-10-01-camera §2.
  const camera = useCameraTrack(p.userId, isSelf);
  const className = [s.tile, speaking && s.tileSpeaking, camera && s.tileCamera].filter(Boolean).join(' ');
  const body = (
    <>
      <VoiceAvatar size={80} userId={p.userId} />
      {camera && <CameraVideo track={camera} userId={p.userId} mirrored={isSelf} />}
      <span className={s.tileName}>
        {p.screen && <LiveBadge />}
        <span className={s.tileNameText}>
          {name}
          {isSelf && ` (${t('voice.you')})`}
        </span>
        {speaking && <span className={s.srOnly}>, {t('voice.speaking')}</span>}
        {p.camera && <span className={s.srOnly}>, {t('voice.camera.live')}</span>}
      </span>
      {hasStateIcons(p) && (
        <span className={s.tileIcons}>
          <StateIcons p={p} size={16} />
        </span>
      )}
    </>
  );
  const data = { 'data-user': p.userId, 'data-speaking': speaking || undefined, 'data-receiving': receiving || undefined };
  return (
    <div className={s.anchor} {...data}>
      <button
        type="button"
        className={className}
        style={{ width: '100%' }}
        aria-haspopup="dialog"
        data-profile-trigger
        onClick={(e) => useProfileCardStore.getState().open(p.userId, e.currentTarget.getBoundingClientRect(), 'right', e.currentTarget)}
        {...userMenuTriggers((anchor, opener) => setMenu({ userId: p.userId, anchor, opener }))}
      >
        {body}
      </button>
      {menu && <UserMenuFor request={menu} side="right" onClose={() => setMenu(null)} />}
    </div>
  );
}

/** Measures the stage body (its content box) and keeps the best tile layout for `count` tiles in it. */
function useTileLayout(count: number): { ref: RefObject<HTMLDivElement | null>; layout: TileLayout } {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const style = getComputedStyle(el);
      const width = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const height = el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      setBox((b) => (b.width === width && b.height === height ? b : { width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, layout: fitTiles(count, box.width, box.height) };
}

/** The screen share button of the call bar (same rules as the panel's). */
function ShareButton({ channelId }: { channelId: string }) {
  const button = useScreenShareButton(channelId);
  return (
    <button
      type="button"
      className={s.callButton}
      aria-pressed={button.sharing}
      aria-disabled={!button.enabled || undefined}
      aria-label={button.label}
      title={button.title}
      onClick={button.onClick}
    >
      {button.sharing ? <MonitorX size={20} aria-hidden="true" /> : <MonitorUp size={20} aria-hidden="true" />}
    </button>
  );
}

/**
 * The center view of a voice channel, like Discord's call screen: a black stage with 16:9
 * tiles as large as it allows (a green ring while speaking), the screens (spec 2026-10-01
 * §5: a tile with "Assistir" per live person; what I watch large, or in a grid when
 * several, a click focusing one), cameras filling their tiles, and the call bar (join, or
 * [mic ⌄ camera ⌄ headphones ⌄] [share] and the red hang-up while in this channel).
 */
export function VoiceStage({ channelId, onOpenSettings }: { channelId: string; onOpenSettings?: () => void }) {
  useVoiceRuntime();
  const t = useT();
  const directory = useVoiceDirectory();
  // A channel of the server on screen; the call may run on another one (chamada-continua §2).
  const participants = useVoiceStore((v) => participantsOf(viewVoice(v), channelId));
  const call = useVoiceStore((v) => v.call);
  const here = call.channelId === channelId && call.status !== 'idle';
  const speakers = useVoiceStore(useShallow((v) => (v.call.channelId === channelId ? participantsOf(v, channelId).filter((p) => isSpeaking(v, p.userId)).map((p) => p.userId) : NONE)));
  const receiving = useVoiceStore((v) => v.subscribed);
  const selfUserId = useVoiceStore((v) => viewVoice(v).selfUserId);
  const available = useVoiceStore((v) => viewVoice(v).available);
  const name = directory.channelName(channelId) ?? '';
  // Screens are watched from inside the call only (a subscription in my room).
  const live = useVoiceStore(useShallow((v) => (here ? liveIn(v, channelId).filter((u) => u !== v.selfUserId) : NONE)));
  const watching = useVoiceStore((v) => v.watching);
  const sharing = useVoiceStore((v) => here && v.sharing !== null);
  const [focus, setFocus] = useState<string | null>(null);
  const streams = streamLayout(live, watching, focus);
  const others = streams.focused ? streams.shown.filter((u) => u !== streams.focused) : [];
  const unwatched = live.filter((u) => !streams.shown.includes(u));
  const { ref: bodyRef, layout } = useTileLayout((sharing && selfUserId ? 1 : 0) + unwatched.length + participants.length);
  const tiles = (
    <>
      {sharing && selfUserId && <OwnStreamTile userId={selfUserId} />}
      {unwatched.map((u) => (
        <StreamTile key={'screen-' + u} userId={u} />
      ))}
      {participants.map((p) => (
        <Tile
          key={p.userId}
          p={p}
          isSelf={p.userId === selfUserId}
          speaking={here && speakers.includes(p.userId)}
          receiving={here && receiving.includes(p.userId)}
        />
      ))}
    </>
  );

  return (
    <section className={s.stage} aria-label={name} data-voice-stage={channelId}>
      <header className={s.stageHeader}>
        <Volume2 size={20} className={s.stageHeaderIcon} aria-hidden="true" />
        <h2>{name}</h2>
      </header>
      <div ref={bodyRef} className={streams.shown.length > 0 ? s.stageBody + ' ' + s.stageBodyWatching : s.stageBody}>
        {participants.length === 0 ? (
          <div className={s.empty}>
            <span className={s.emptyIcon}>
              <Volume2 size={32} aria-hidden="true" />
            </span>
            <h3>{t('voice.empty')}</h3>
            <p>{t('voice.emptyHint')}</p>
          </div>
        ) : streams.shown.length > 0 ? (
          <>
            {streams.focused ? (
              <StreamView userId={streams.focused} size="large" onShowAll={streams.shown.length > 1 ? () => setFocus(null) : undefined} />
            ) : (
              <div className={s.streamGrid}>
                {streams.shown.map((u) => (
                  <StreamView key={u} userId={u} size="grid" onFocus={() => setFocus(u)} />
                ))}
              </div>
            )}
            <div className={s.strip}>
              {others.map((u) => (
                <StreamView key={u} userId={u} size="compact" onFocus={() => setFocus(u)} />
              ))}
              {tiles}
            </div>
          </>
        ) : (
          <div className={s.grid} style={{ gridTemplateColumns: `repeat(${layout.columns}, ${layout.width}px)` }}>
            {tiles}
          </div>
        )}
      </div>
      <footer className={s.stageBar}>
        {here ? (
          <>
            <div className={s.callGroup}>
              <CallAudioControls channelId={channelId} onOpenSettings={onOpenSettings} />
            </div>
            <div className={s.callGroup}>
              <ShareButton channelId={channelId} />
            </div>
            <button type="button" className={s.hangUp} aria-label={t('voice.disconnect')} title={t('voice.disconnect')} onClick={() => void leaveVoice()}>
              <HangUpIcon size={16} />
            </button>
          </>
        ) : available ? (
          <button type="button" className={s.primary} onClick={() => void joinVoice(channelId)} data-voice-join={channelId}>
            <PhoneCall size={18} aria-hidden="true" />
            {t('voice.join')}
          </button>
        ) : (
          <p className={s.unavailable} role="status">
            {t('voice.unavailable')}
          </p>
        )}
      </footer>
    </section>
  );
}
