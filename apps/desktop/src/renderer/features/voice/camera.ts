// The camera in calls (spec 2026-10-01-camera-design.md): the quality presets, the capture
// and publish options, the permission rule, and the check that tells a moving picture from
// a frozen one. LiveKit comes in as values only, so all of it is tested without a browser.
import { Track, VideoPreset, VideoPresets, type TrackPublishOptions, type VideoCaptureOptions } from 'livekit-client';

export const CAMERA_QUALITIES = ['480p30', '720p30', '1080p30'] as const;
export type CameraQuality = (typeof CAMERA_QUALITIES)[number];
export const DEFAULT_CAMERA_QUALITY: CameraQuality = '720p30';

export function isCameraQuality(v: unknown): v is CameraQuality {
  return typeof v === 'string' && (CAMERA_QUALITIES as readonly string[]).includes(v);
}

export interface CameraPreset {
  video: VideoPreset;
  /** Simulcast: the two lower layers under the chosen one (3 layers in all). */
  layers: VideoPreset[];
}

/** LiveKit has no 16:9 480p preset: 854×480 at 30 fps, between its h360 (450 kbps) and h540 (800 kbps). */
const H480_30 = new VideoPreset(854, 480, 700_000, 30);

/** spec §1: 180p and 360p under the chosen quality, LiveKit's own presets. */
const LAYERS = [VideoPresets.h180, VideoPresets.h360];

/** spec §1, §3: 720p30 (the default) is VideoPresets.h720, 1080p30 is VideoPresets.h1080. */
export function cameraPreset(quality: CameraQuality): CameraPreset {
  switch (quality) {
    case '480p30':
      return { video: H480_30, layers: LAYERS };
    case '720p30':
      return { video: VideoPresets.h720, layers: LAYERS };
    case '1080p30':
      return { video: VideoPresets.h1080, layers: LAYERS };
  }
}

/** "720p" and 30, for the settings' labels. */
export function cameraQualityParts(quality: CameraQuality): { resolution: string; fps: number } {
  const { video } = cameraPreset(quality);
  return { resolution: `${video.height}p`, fps: video.encoding.maxFramerate ?? 30 };
}

/**
 * The capture request (setCameraEnabled → getUserMedia): the preset's size and frame rate,
 * and the chosen camera when there is one. A plain deviceId is a preference, so a camera
 * that was unplugged falls back to another instead of failing.
 */
export function cameraCaptureOptions(quality: CameraQuality, deviceId: string | null): VideoCaptureOptions {
  return { resolution: cameraPreset(quality).video.resolution, ...(deviceId ? { deviceId } : {}) };
}

/** How the picture is published: the preset's encoding over LiveKit's 180p and 360p layers. */
export function cameraPublishOptions(quality: CameraQuality): TrackPublishOptions {
  const { video, layers } = cameraPreset(quality);
  return { source: Track.Source.Camera, simulcast: true, videoEncoding: video.encoding, videoSimulcastLayers: layers };
}

/** LiveKit protocol TrackSource.CAMERA (livekit-server-sdk's enum; the tests check the value). */
const PROTO_CAMERA = 1;

/** Whether LiveKit lets this participant publish a camera: the server lists it for VIDEO (permissions.ts). */
export function canPublishCamera(permissions: { canPublish: boolean; canPublishSources: readonly number[] } | undefined): boolean {
  if (!permissions?.canPublish) return false;
  return permissions.canPublishSources.length === 0 || permissions.canPublishSources.includes(PROTO_CAMERA);
}

/** A camera that shows no new frame for this long is frozen or gone: its tile goes back to the photo (spec §2). */
export const CAMERA_STALL_MS = 2_000;

/** Whether a camera still moves: a frame in the last CAMERA_STALL_MS, and not muted by its sender. */
export class FrameWatch {
  #last = Number.NEGATIVE_INFINITY;
  #muted = false;

  /** A frame was shown at `now` (ms). */
  frame(now: number): void {
    this.#last = now;
  }

  /** The sender muted (or unmuted) the track: no frames are coming. */
  setMuted(muted: boolean): void {
    this.#muted = muted;
  }

  live(now: number): boolean {
    return !this.#muted && now - this.#last < CAMERA_STALL_MS;
  }
}
