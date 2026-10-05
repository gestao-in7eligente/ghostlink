// Screen sharing (spec 2026-10-01-transmitir-tela-design.md): the presets, the capture and
// publish options, the check that keeps GhostLink's own audio out of the PC's sound, and the
// publishing flow. LiveKit and the IPC come in as narrow interfaces, so all of it is tested
// without a browser.
import {
  AudioPresets,
  ScreenSharePresets,
  Track,
  VideoPreset,
  type AudioCaptureOptions,
  type LocalAudioTrack,
  type LocalTrack,
  type LocalVideoTrack,
  type ScreenShareCaptureOptions,
  type TrackPublishOptions,
} from 'livekit-client';
import type { ScreenChoice, ScreenSource } from '../../../shared/screenTypes.js';

export const SCREEN_QUALITIES = ['720p30', '1080p30', '1080p60'] as const;
export type ScreenQuality = (typeof SCREEN_QUALITIES)[number];
export const DEFAULT_SCREEN_QUALITY: ScreenQuality = '1080p30';

/** The content hint: "Texto e apresentações" or "Jogos e vídeo" (spec §2). */
export type ScreenContent = 'detail' | 'motion';
export const DEFAULT_SCREEN_CONTENT: ScreenContent = 'motion';

/** What the picker hands over. */
export interface ScreenSelection {
  sourceId: string;
  /** The source's name, shown in the voice panel while live. */
  name: string;
  quality: ScreenQuality;
  content: ScreenContent;
  /** "Transmitir o som do PC". */
  audio: boolean;
}

export interface ScreenPreset {
  video: VideoPreset;
  /** Simulcast: one lower layer under the preset (2 layers in all). */
  layers: VideoPreset[];
}

const LAYER_360P30 = new VideoPreset(640, 360, 600_000, 30, 'medium');

/**
 * spec §6. Without an explicit preset LiveKit caps a screen at 15 fps. The lower layer keeps
 * 30 fps, so a stream in a small grid tile (adaptiveStream picks it) still moves smoothly.
 */
export function screenPreset(quality: ScreenQuality): ScreenPreset {
  switch (quality) {
    case '720p30':
      return { video: ScreenSharePresets.h720fps30, layers: [LAYER_360P30] };
    case '1080p30':
      return { video: ScreenSharePresets.h1080fps30, layers: [ScreenSharePresets.h720fps30] };
    case '1080p60':
      return { video: new VideoPreset(1920, 1080, 8_000_000, 60), layers: [ScreenSharePresets.h720fps30] };
  }
}

/** "1080p" and 60, for the picker's labels. */
export function screenQualityParts(quality: ScreenQuality): { resolution: string; fps: number } {
  const { video } = screenPreset(quality);
  return { resolution: `${video.height}p`, fps: video.encoding.maxFramerate ?? 30 };
}

/**
 * The PC's sound without GhostLink's own playback (spec §4, measured on Electron 44 / Windows 11):
 * with restrictOwnAudio Chromium uses the Windows capture that excludes this app's audio process.
 * None of the voice processing: this is music and games.
 */
export const SCREEN_AUDIO_CONSTRAINTS = {
  restrictOwnAudio: true,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
} as const satisfies AudioCaptureOptions;

/** The capture request (LocalParticipant.createScreenTracks → getDisplayMedia). */
export function screenCaptureOptions(quality: ScreenQuality, content: ScreenContent, audio: boolean): ScreenShareCaptureOptions {
  return {
    audio: audio ? { ...SCREEN_AUDIO_CONSTRAINTS } : false,
    resolution: screenPreset(quality).video.resolution,
    contentHint: content,
  };
}

/** How the picture is published: the preset's encoding, its lower layer, and for motion the frame rate first. */
export function screenVideoPublishOptions(quality: ScreenQuality, content: ScreenContent): TrackPublishOptions {
  const { video, layers } = screenPreset(quality);
  return {
    source: Track.Source.ScreenShare,
    simulcast: true,
    screenShareEncoding: video.encoding,
    screenShareSimulcastLayers: layers,
    ...(content === 'motion' ? { degradationPreference: 'maintain-framerate' as const } : {}),
  };
}

/** The sound goes in stereo, without DTX or RED (spec §4: music and games, not voice). */
export const SCREEN_AUDIO_PUBLISH: TrackPublishOptions = {
  source: Track.Source.ScreenShareAudio,
  forceStereo: true,
  dtx: false,
  red: false,
  audioPreset: AudioPresets.musicHighQualityStereo,
};

/** The device Chromium reports for system sound that excludes this app's own (spec §4). */
export const LOOPBACK_WITHOUT_SELF = 'loopbackWithoutChrome';

/**
 * spec §4, the mandatory check: keep the sound only when it is the capture that excludes
 * GhostLink's own audio. Anything else (plain loopback on Windows 10) would send the call back.
 */
export function keepScreenAudio(track: { getSettings(): { deviceId?: string } }): boolean {
  return track.getSettings().deviceId === LOOPBACK_WITHOUT_SELF;
}

/**
 * Microphones and cameras always; a screen and its sound too, without a click (owner, 2026-10-02),
 * unless I stopped watching that person's share ("Parar de assistir").
 */
export function wantsSubscription(source: Track.Source, kind: Track.Kind, userId: string | null, unwatched: readonly string[]): boolean {
  if (source === Track.Source.Microphone) return kind === Track.Kind.Audio;
  if (source === Track.Source.Camera) return kind === Track.Kind.Video;
  const screen = (source === Track.Source.ScreenShare && kind === Track.Kind.Video) || (source === Track.Source.ScreenShareAudio && kind === Track.Kind.Audio);
  return screen && userId !== null && !unwatched.includes(userId);
}

// ---- the publishing flow ----

/** The window.ghostlink.screen calls and the picker. */
export interface ScreenShareDeps {
  sources(): Promise<ScreenSource[]>;
  choose(choice: ScreenChoice): Promise<void>;
  /** Shows the picker over the (still loading) sources; null when cancelled. */
  pick(sources: Promise<ScreenSource[]>): Promise<ScreenSelection | null>;
}

/** The part of LiveKit's LocalParticipant the flow uses. */
export interface ScreenPublisher {
  createScreenTracks(options: ScreenShareCaptureOptions): Promise<LocalTrack[]>;
  publishTrack(track: LocalTrack, options: TrackPublishOptions): Promise<unknown>;
  unpublishTrack(track: LocalTrack): Promise<unknown>;
}

export interface LiveScreenShare {
  selection: ScreenSelection;
  video: LocalVideoTrack;
  /** null: picture only (not asked for, or dropped by the check). */
  audio: LocalAudioTrack | null;
}

export type ScreenShareOutcome =
  | { kind: 'cancelled' }
  | { kind: 'failed' }
  /** audioDropped: sound was asked for but is not sent (the Windows 11 notice). */
  | { kind: 'live'; share: LiveScreenShare; audioDropped: boolean };

async function takeBack(publisher: ScreenPublisher, published: readonly LocalTrack[], tracks: readonly LocalTrack[]): Promise<void> {
  for (const track of published) await publisher.unpublishTrack(track).catch(() => {});
  for (const track of tracks) track.stop();
}

/**
 * Lists the sources for the picker, waits for the choice, tells main which source it is
 * (screen.choose), captures (main's display-media handler answers with exactly that source),
 * checks the sound and publishes. `stillWanted` turns false once the call this share belongs
 * to is over: whatever was captured by then is stopped and taken back.
 */
export async function startScreenShare(publisher: ScreenPublisher, deps: ScreenShareDeps, stillWanted: () => boolean): Promise<ScreenShareOutcome> {
  const selection = await deps.pick(deps.sources());
  if (!selection || !stillWanted()) return { kind: 'cancelled' };

  let tracks: LocalTrack[];
  try {
    await deps.choose({ sourceId: selection.sourceId, audio: selection.audio });
    tracks = await publisher.createScreenTracks(screenCaptureOptions(selection.quality, selection.content, selection.audio));
  } catch {
    // main refused (the source vanished, the choice expired): getDisplayMedia rejects.
    return { kind: 'failed' };
  }
  const video = tracks.find((t) => t.kind === Track.Kind.Video) as LocalVideoTrack | undefined;
  let audio = tracks.find((t) => t.kind === Track.Kind.Audio) as LocalAudioTrack | undefined;
  if (!video) {
    for (const t of tracks) t.stop();
    return { kind: 'failed' };
  }
  if (!stillWanted()) {
    await takeBack(publisher, [], tracks);
    return { kind: 'cancelled' };
  }
  if (audio && !keepScreenAudio(audio.mediaStreamTrack)) {
    audio.stop();
    audio = undefined;
  }

  const published: LocalTrack[] = [];
  const kept = audio ? [video, audio] : [video];
  try {
    await publisher.publishTrack(video, screenVideoPublishOptions(selection.quality, selection.content));
    published.push(video);
    if (audio) {
      await publisher.publishTrack(audio, SCREEN_AUDIO_PUBLISH);
      published.push(audio);
    }
  } catch {
    await takeBack(publisher, published, kept);
    return { kind: 'failed' };
  }
  if (!stillWanted()) {
    await takeBack(publisher, published, kept);
    return { kind: 'cancelled' };
  }
  return { kind: 'live', share: { selection, video, audio: audio ?? null }, audioDropped: selection.audio && !audio };
}

/** Unpublishes and stops the picture and the sound. */
export async function stopScreenShare(publisher: ScreenPublisher, share: LiveScreenShare): Promise<void> {
  const tracks = share.audio ? [share.video, share.audio] : [share.video];
  await takeBack(publisher, tracks, tracks);
}
