// Screens on the voice stage (spec 2026-10-01 §5): a tile per live person with "Assistir";
// a watched stream large with fullscreen, its volume and "Parar de assistir"; several in a
// grid, and a click focuses one. Also the share button's logic, shared with the panel.
import { Eye, LayoutGrid, Maximize, Minimize, Monitor } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { PERMISSIONS, has } from '@ghostlink/shared';
import { useT } from '../../i18n/index.js';
import { DrawLayer, OwnTilePencil, PencilButton } from '../draw/index.js';
import { LiveBadge, StreamVolume, TrackVideo } from './screenParts.js';
import { useScreenTracks } from './screenStore.js';
import { startScreenShare, stopScreenShare, unwatchScreen, useVoiceDirectory, watchScreen } from './runtime.js';
import { useVoiceStore } from './state.js';
import s from './voice.module.css';

/**
 * "Transmitir tela" / "Parar transmissão": needs VIDEO in the channel (the same directory
 * lookup as the other voice permissions) and a connected call.
 */
export function useScreenShareButton(channelId: string) {
  const t = useT();
  const directory = useVoiceDirectory();
  const sharing = useVoiceStore((v) => v.sharing !== null);
  const connected = useVoiceStore((v) => v.call.status === 'connected' && v.call.channelId === channelId);
  const allowed = has(directory.myPermissions(channelId), PERMISSIONS.VIDEO);
  const enabled = sharing || (allowed && connected);
  return {
    sharing,
    enabled,
    label: t(sharing ? 'voice.screen.stop' : 'voice.screen.share'),
    title: !sharing && !allowed ? t('voice.screen.noPermission') : t(sharing ? 'voice.screen.stop' : 'voice.screen.share'),
    onClick: () => {
      if (!enabled) return;
      void (sharing ? stopScreenShare() : startScreenShare());
    },
  };
}

/** A watched stream: the video, its name and LIVE badge, and (unless compact) the controls. */
export function StreamView({ userId, size, onFocus, onShowAll }: { userId: string; size: 'large' | 'grid' | 'compact'; onFocus?: () => void; onShowAll?: () => void }) {
  const t = useT();
  const directory = useVoiceDirectory();
  const track = useScreenTracks((st) => (Object.hasOwn(st.remote, userId) ? st.remote[userId]! : null));
  const ref = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const name = directory.displayName(userId);

  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement !== null && document.fullscreenElement === ref.current);
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);

  const toggleFullscreen = () => {
    if (fullscreen) void document.exitFullscreen().catch(() => {});
    else void ref.current?.requestFullscreen().catch(() => {});
  };

  const className = size === 'large' ? `${s.stream} ${s.streamLarge}` : size === 'compact' ? `${s.stream} ${s.streamCompact}` : s.stream;
  return (
    <div ref={ref} className={className} role="group" aria-label={t('voice.screen.streamOf', { name })} data-screen-view={userId}>
      {track ? (
        <TrackVideo track={track} className={s.streamVideo} userId={userId} />
      ) : (
        <p className={s.streamWaiting} role="status">
          {t('voice.screen.connecting')}
        </p>
      )}
      {onFocus && <button type="button" className={s.streamFocus} aria-label={t('voice.screen.focus', { name })} title={t('voice.screen.focus', { name })} onClick={onFocus} />}
      <div className={s.streamLabel}>
        <LiveBadge />
        <span className={s.streamName}>{name}</span>
      </div>
      <DrawLayer sharerId={userId} interactive={size !== 'compact'} />
      {size !== 'compact' && (
        <div className={s.streamBar}>
          {onShowAll && (
            <button type="button" className={s.streamIcon} aria-label={t('voice.screen.showAll')} title={t('voice.screen.showAll')} onClick={onShowAll}>
              <LayoutGrid size={18} aria-hidden="true" />
            </button>
          )}
          <StreamVolume userId={userId} />
          <PencilButton sharerId={userId} className={s.streamIcon} />
          <button
            type="button"
            className={s.streamIcon}
            aria-label={t(fullscreen ? 'voice.screen.exitFullscreen' : 'voice.screen.fullscreen')}
            title={t(fullscreen ? 'voice.screen.exitFullscreen' : 'voice.screen.fullscreen')}
            onClick={toggleFullscreen}
            data-screen-fullscreen={userId}
          >
            {fullscreen ? <Minimize size={18} aria-hidden="true" /> : <Maximize size={18} aria-hidden="true" />}
          </button>
          <button type="button" className={s.streamStop} onClick={() => unwatchScreen(userId)} data-screen-unwatch={userId}>
            {t('voice.screen.stopWatching')}
          </button>
        </div>
      )}
    </div>
  );
}

/** Someone live I am not watching: their name, the LIVE badge and "Assistir". */
export function StreamTile({ userId }: { userId: string }) {
  const t = useT();
  const directory = useVoiceDirectory();
  const name = directory.displayName(userId);
  return (
    <div className={s.streamTile} role="group" aria-label={t('voice.screen.streamOf', { name })} data-screen-tile={userId}>
      <Monitor size={36} className={s.streamTileIcon} aria-hidden="true" />
      <button type="button" className={s.stageButton} onClick={() => watchScreen(userId)} data-screen-watch={userId}>
        <Eye size={18} aria-hidden="true" />
        {t('voice.screen.watch')}
      </button>
      <span className={s.streamTileName}>
        <LiveBadge />
        <span>{name}</span>
      </span>
    </div>
  );
}

/** My own share on the stage: the local preview (nothing to subscribe to). */
export function OwnStreamTile({ userId }: { userId: string }) {
  const t = useT();
  const directory = useVoiceDirectory();
  const preview = useScreenTracks((st) => st.local);
  return (
    <div className={`${s.streamTile} ${s.streamTileVideo}`} role="group" aria-label={t('voice.screen.yours')} data-screen-tile={userId}>
      <TrackVideo track={preview} className={s.streamVideo} label={t('voice.screen.preview')} />
      <DrawLayer sharerId={userId} />
      <OwnTilePencil userId={userId} />
      <span className={s.streamTileName}>
        <LiveBadge />
        <span>
          {directory.displayName(userId)} ({t('voice.you')})
        </span>
      </span>
    </div>
  );
}
