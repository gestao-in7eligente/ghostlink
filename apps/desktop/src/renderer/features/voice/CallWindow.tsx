// The call's mini window while I share my screen (spec 2026-10-02-janelinha-da-chamada-design.md),
// like Google Meet's picture-in-picture while presenting: "● Você está apresentando" and the
// channel (⤢ back to GhostLink, ✕ closes only this window), the camera of whoever speaks (or
// their photo), the people in the call, and the microphone, camera, "Parar de compartilhar",
// pencil and leave buttons. It opens with my share and closes when the share or the call ends.
// React draws it into a popup of this page (callWindowPopup.ts), so the stores and video tracks
// are the call's own: no second connection.
import { Maximize2, Mic, MicOff, MonitorX, Pencil, Volume2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import { APP_NAME } from '@ghostlink/shared';
import { useT } from '../../i18n/index.js';
import { Avatar } from '../../layout/primitives.js';
import { setAllowDrawing, useDrawRuntime } from '../draw/runtime.js';
import { ownShareAllowed, useDrawStore } from '../draw/state.js';
import { CameraIcon, CameraVideo, useCameraButton } from './CameraParts.js';
import { useCameraTracks } from './cameraStore.js';
import { CallWindowLifecycle, NO_FEATURED_MEMORY, chooseFeatured, peopleRow } from './callWindowModel.js';
import { openCallPopup, type CallPopup } from './callWindowPopup.js';
import { HangUpIcon } from './parts.js';
import { leaveVoice, stopScreenShare, toggleMute, useCallDirectory } from './runtime.js';
import { isSpeaking, participantsOf, selfVoice, useVoiceStore, type VoiceState } from './state.js';
import c from './callWindow.module.css';

const NONE: string[] = [];

/** The channel of my live share, or null: the window is wanted only then. */
function sharingChannel(v: VoiceState): string | null {
  return v.sharing !== null && v.call.status !== 'idle' ? v.call.channelId : null;
}

/** Who speaks now in the call, loudest first (LiveKit's order), me while my microphone is open. */
function speakersOf(v: VoiceState, channelId: string): string[] {
  const here = participantsOf(v, channelId).map((p) => p.userId);
  const list = v.speaking.filter((u) => here.includes(u));
  const self = v.selfUserId;
  if (self !== null && here.includes(self) && !list.includes(self) && isSpeaking(v, self)) list.push(self);
  return list.length === 0 ? NONE : list;
}

/** A person's photo from the call's server (mine is my global one), with the green ring while they speak. */
function Photo({ userId, size, speaking }: { userId: string; size: number; speaking: boolean }) {
  const directory = useCallDirectory();
  const self = useVoiceStore((v) => v.selfUserId === userId);
  return (
    <span className={speaking ? `${c.photo} ${c.photoSpeaking}` : c.photo} style={{ width: size, height: size }} data-speaking={speaking || undefined}>
      <Avatar size={size} name={directory.displayName(userId)} hash={directory.avatar(userId)} self={self} />
    </span>
  );
}

/** The video area: the camera of whoever speaks, else their photo (chooseFeatured). */
function FeaturedView({ channelId }: { channelId: string }) {
  const t = useT();
  const directory = useCallDirectory();
  const participants = useVoiceStore(useShallow((v) => participantsOf(v, channelId).map((p) => p.userId)));
  const withCamera = useVoiceStore(useShallow((v) => participantsOf(v, channelId).filter((p) => p.camera).map((p) => p.userId)));
  const speaking = useVoiceStore(useShallow((v) => speakersOf(v, channelId)));
  const self = useVoiceStore((v) => v.selfUserId);
  const remote = useCameraTracks((st) => st.remote);
  const local = useCameraTracks((st) => st.local);
  // Mine is there while it is open; someone else's while the server says it is on and its track arrived.
  const cameras = participants.filter((u) => (u === self ? local !== null : withCamera.includes(u) && Object.hasOwn(remote, u)));
  const memory = useRef(NO_FEATURED_MEMORY);
  const { featured, memory: next } = chooseFeatured({ participants, speaking, cameras, self }, memory.current);
  memory.current = next;
  if (!featured) return <div className={c.stage} />;
  const isSelf = featured.userId === self;
  const track = featured.camera ? (isSelf ? local : (remote[featured.userId] ?? null)) : null;
  const className = [c.stage, featured.camera && featured.speaking && c.stageSpeaking].filter(Boolean).join(' ');
  return (
    <div className={className} data-call-window-featured={featured.userId} data-camera={featured.camera || undefined}>
      <Photo userId={featured.userId} size={88} speaking={featured.speaking && !featured.camera} />
      {track && <CameraVideo key={featured.userId} track={track} userId={featured.userId} mirrored={isSelf} />}
      <span className={c.stageName}>
        {directory.displayName(featured.userId)}
        {isSelf && ` (${t('voice.you')})`}
      </span>
    </div>
  );
}

/** Up to six photos with the speaking ring, then "+N". */
function People({ channelId }: { channelId: string }) {
  const t = useT();
  const directory = useCallDirectory();
  const participants = useVoiceStore(useShallow((v) => participantsOf(v, channelId).map((p) => p.userId)));
  const speaking = useVoiceStore(useShallow((v) => speakersOf(v, channelId)));
  const { shown, more } = peopleRow(participants);
  return (
    <ul className={c.people} aria-label={t('voice.callWindow.people')}>
      {shown.map((u) => (
        <li key={u} className={c.person} title={directory.displayName(u)} data-user={u}>
          <Photo userId={u} size={28} speaking={speaking.includes(u)} />
          <span className={c.srOnly}>
            {directory.displayName(u)}
            {speaking.includes(u) && `, ${t('voice.speaking')}`}
          </span>
        </li>
      ))}
      {more > 0 && (
        <li className={c.more} title={t('voice.callWindow.morePeople', { count: more })}>
          <span aria-hidden="true">+{more}</span>
          <span className={c.srOnly}>{t('voice.callWindow.morePeople', { count: more })}</span>
        </li>
      )}
    </ul>
  );
}

/** The microphone, as the call bar's: crossed out while muted, locked while the server mutes me. */
function MicButton() {
  const t = useT();
  const muted = useVoiceStore((v) => v.selfMuted || v.selfDeafened);
  const serverMuted = useVoiceStore((v) => selfVoice(v)?.serverMuted ?? false);
  const label = serverMuted ? t('voice.serverMuted') : t(muted ? 'voice.unmute' : 'voice.mute');
  return (
    <button
      type="button"
      className={c.button}
      aria-pressed={muted || serverMuted}
      aria-label={label}
      title={label}
      disabled={serverMuted}
      onClick={() => void toggleMute()}
    >
      {muted || serverMuted ? <MicOff size={18} aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}
    </button>
  );
}

/** The camera, as the call bar's: highlighted while on. */
function CameraButton({ channelId }: { channelId: string }) {
  const button = useCameraButton(channelId);
  return (
    <button
      type="button"
      className={button.on ? `${c.button} ${c.buttonOn}` : c.button}
      aria-pressed={button.on}
      aria-disabled={!button.enabled || undefined}
      aria-label={button.label}
      title={button.title}
      onClick={button.onClick}
    >
      <CameraIcon on={button.on} size={18} />
    </button>
  );
}

/** "Permitir desenhos" as a pencil toggle: the same switch as the voice panel's (screen.drawAllow). */
function DrawAllowButton() {
  useDrawRuntime();
  const t = useT();
  const available = useDrawStore((st) => st.available);
  const off = useDrawStore((st) => st.off);
  const allowed = useVoiceStore((v) => ownShareAllowed({ off }, v));
  if (!available) return null;
  return (
    <button
      type="button"
      className={allowed ? `${c.button} ${c.buttonOn}` : c.button}
      aria-pressed={allowed}
      aria-label={t('draw.allow')}
      title={t('voice.callWindow.draw')}
      onClick={() => void setAllowDrawing(!allowed)}
      data-draw-allow={allowed ? 'on' : 'off'}
    >
      <Pencil size={18} aria-hidden="true" />
    </button>
  );
}

/** The window's content for my share in `channelId`. */
export function CallWindowView({ channelId, onClose }: { channelId: string; onClose(): void }) {
  const t = useT();
  const directory = useCallDirectory();
  const channel = directory.channelName(channelId) ?? '';
  return (
    <section className={c.window} aria-label={t('voice.callWindow.label')} data-call-window={channelId}>
      <header className={c.bar}>
        <div className={c.barText}>
          <span className={c.presenting}>
            <span className={c.dot} aria-hidden="true" />
            {t('voice.callWindow.presenting')}
          </span>
          <span className={c.channel}>
            <Volume2 size={12} aria-hidden="true" />
            <span className={c.channelName}>{channel}</span>
          </span>
        </div>
        <button
          type="button"
          className={c.barButton}
          aria-label={t('voice.callWindow.backToApp')}
          title={t('voice.callWindow.backToApp')}
          onClick={() => void window.ghostlink.app.showWindow().catch(() => {})}
        >
          <Maximize2 size={16} aria-hidden="true" />
        </button>
        <button type="button" className={c.barButton} aria-label={t('voice.callWindow.close')} title={t('voice.callWindow.close')} onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <FeaturedView channelId={channelId} />
      <People channelId={channelId} />
      <div className={c.controls}>
        <div className={c.group}>
          <MicButton />
          <CameraButton channelId={channelId} />
          <DrawAllowButton />
        </div>
        <button type="button" className={c.leave} aria-label={t('voice.callWindow.leave')} title={t('voice.callWindow.leave')} onClick={() => void leaveVoice()}>
          <HangUpIcon size={16} />
        </button>
      </div>
      <button type="button" className={c.stop} onClick={() => void stopScreenShare()} data-call-window-stop="">
        <MonitorX size={16} aria-hidden="true" />
        {t('voice.callWindow.stop')}
      </button>
    </section>
  );
}

/**
 * Opens the mini window while my share is live (CallWindowLifecycle) and draws it there with a
 * portal. Mounted once for the page's whole life (main.tsx), so moving between screens never
 * closes it; it closes with the page.
 */
export function CallWindowHost() {
  const channelId = useVoiceStore(sharingChannel);
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const lifecycle = useRef<CallWindowLifecycle | null>(null);

  useEffect(() => {
    let popup: CallPopup | null = null;
    const current = new CallWindowLifecycle({
      open: () => {
        popup = openCallPopup({ title: APP_NAME, className: c.root, onGone: () => current.gone() });
        setRoot(popup?.root ?? null);
        return popup !== null;
      },
      close: () => {
        popup?.close();
        popup = null;
        setRoot(null);
      },
    });
    lifecycle.current = current;
    return () => {
      current.dispose();
      if (lifecycle.current === current) lifecycle.current = null;
    };
  }, []);

  useEffect(() => {
    lifecycle.current?.update(channelId !== null);
  }, [channelId]);

  if (!root || channelId === null) return null;
  return createPortal(<CallWindowView channelId={channelId} onClose={() => lifecycle.current?.dismiss()} />, root);
}
