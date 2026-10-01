// The camera's UI pieces (spec 2026-10-01-camera §2): the button's rules (shared by the call
// bar and the "Voz conectada" row), the panel's square button, and a camera in a tile.
import { TrackEvent, type LocalVideoTrack, type RemoteTrack } from 'livekit-client';
import { Video, VideoOff } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { PERMISSIONS, has } from '@ghostlink/shared';
import { useT } from '../../i18n/index.js';
import { FrameWatch } from './camera.js';
import { toggleCamera, useCallDirectory } from './runtime.js';
import { useVoiceStore } from './state.js';
import s from './voice.module.css';

/**
 * "Ligar câmera" / "Desligar câmera": needs VIDEO in the channel (the same directory lookup
 * as the screen share button) and a connected call. Turning it off always works.
 */
export function useCameraButton(channelId: string) {
  const t = useT();
  // The call's channel: its server's permissions, also while another server is on screen.
  const directory = useCallDirectory();
  const on = useVoiceStore((v) => v.camera);
  const connected = useVoiceStore((v) => v.call.status === 'connected' && v.call.channelId === channelId);
  const allowed = has(directory.myPermissions(channelId), PERMISSIONS.VIDEO);
  const enabled = on || (allowed && connected);
  const label = t(on ? 'voice.camera.off' : 'voice.camera.on');
  return {
    on,
    enabled,
    label,
    title: !on && !allowed ? t('voice.camera.noPermission') : label,
    onClick: () => {
      if (enabled) void toggleCamera();
    },
  };
}

/** The camera icon: crossed out while off, like the microphone's. */
export function CameraIcon({ on, size }: { on: boolean; size: number }) {
  return on ? <Video size={size} aria-hidden="true" /> : <VideoOff size={size} aria-hidden="true" />;
}

/** The camera in the panel's row of square buttons, before "Transmitir tela" (spec §2). */
export function PanelCameraButton({ channelId }: { channelId: string }) {
  const button = useCameraButton(channelId);
  return (
    <button
      type="button"
      className={button.on ? `${s.panelAction} ${s.panelActionOn}` : s.panelAction}
      aria-pressed={button.on}
      aria-disabled={!button.enabled || undefined}
      aria-label={button.label}
      title={button.title}
      onClick={button.onClick}
      data-camera-control="panel"
    >
      <CameraIcon on={button.on} size={20} />
    </button>
  );
}

const POLL_MS = 250;

/**
 * Whether the video shows a moving picture: frames keep arriving (counted by the element,
 * so it works while the video is still transparent) and the sender has not muted it.
 */
function useMovingPicture(ref: RefObject<HTMLVideoElement | null>, track: RemoteTrack | LocalVideoTrack): boolean {
  const [live, setLive] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    const watch = new FrameWatch();
    watch.setMuted(track.isMuted);
    let frames = -1;
    const check = () => {
      const now = performance.now();
      const n = el.getVideoPlaybackQuality().totalVideoFrames;
      if (n !== frames && el.videoWidth > 0) watch.frame(now);
      frames = n;
      setLive(watch.live(now));
    };
    const onMuted = () => {
      watch.setMuted(true);
      setLive(false);
    };
    const onUnmuted = () => watch.setMuted(false);
    track.on(TrackEvent.Muted, onMuted).on(TrackEvent.Unmuted, onUnmuted);
    el.addEventListener('loadeddata', check);
    const timer = setInterval(check, POLL_MS);
    return () => {
      clearInterval(timer);
      el.removeEventListener('loadeddata', check);
      track.off(TrackEvent.Muted, onMuted).off(TrackEvent.Unmuted, onUnmuted);
      track.detach(el);
      setLive(false);
    };
  }, [ref, track]);
  return live;
}

/**
 * A camera filling its tile (object-fit: cover) over the person's photo: attach() on mount,
 * detach() on unmount (spec §8.4). It shows only while the picture moves; frozen, muted or
 * gone, the photo underneath is back (spec §2). My own is mirrored, on my screen only.
 */
export function CameraVideo({ track, userId, mirrored = false }: { track: RemoteTrack | LocalVideoTrack; userId?: string; mirrored?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const live = useMovingPicture(ref, track);
  const className = [s.cameraVideo, live && s.cameraVideoLive, mirrored && s.cameraVideoMirrored].filter(Boolean).join(' ');
  return (
    <video
      ref={ref}
      className={className}
      autoPlay
      playsInline
      muted
      aria-hidden="true"
      data-camera-video={userId}
      data-camera-live={live || undefined}
    />
  );
}
