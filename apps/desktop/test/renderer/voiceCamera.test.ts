// The camera in calls (spec 2026-10-01-camera-design.md §3, §4): presets and layers per
// quality, everyone's camera received without asking, mine published and taken back, and
// the settings and store fields behind it.
import { RoomEvent, Track, VideoPresets } from 'livekit-client';
import { TrackSource } from 'livekit-server-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CAMERA_QUALITIES,
  CAMERA_STALL_MS,
  DEFAULT_CAMERA_QUALITY,
  FrameWatch,
  cameraCaptureOptions,
  cameraPreset,
  cameraPublishOptions,
  cameraQualityParts,
  canPublishCamera,
} from '../../src/renderer/features/voice/camera.js';
import { defaultVoiceSettings, parseVoiceSettings } from '../../src/renderer/features/voice/settings.js';
import { initialVoiceState, voiceReducer } from '../../src/renderer/features/voice/state.js';
import { BIA, CAMERA, CAIO, FakePub, FakeRoom, MIC, flush, harness, type Harness } from './voiceFakes.js';

const S = Track.Source;

describe('camera presets (spec §1: 720p30 by default, simulcast 180p, 360p and the chosen one)', () => {
  it('720p30, the default, is LiveKit’s h720', () => {
    expect(DEFAULT_CAMERA_QUALITY).toBe('720p30');
    expect(cameraPreset('720p30').video).toBe(VideoPresets.h720);
  });

  it('1080p30 is LiveKit’s h1080 (spec §3)', () => {
    expect(cameraPreset('1080p30').video).toBe(VideoPresets.h1080);
  });

  it('480p30 is 16:9 at 30 fps, between LiveKit’s h360 and h540', () => {
    const { video } = cameraPreset('480p30');
    expect([video.width, video.height, video.encoding.maxFramerate]).toEqual([854, 480, 30]);
    expect(video.encoding.maxBitrate).toBeGreaterThan(VideoPresets.h360.encoding.maxBitrate);
    expect(video.encoding.maxBitrate).toBeLessThan(VideoPresets.h540.encoding.maxBitrate);
  });

  it('every quality has LiveKit’s 180p and 360p under it: 3 layers, each smaller and cheaper', () => {
    for (const quality of CAMERA_QUALITIES) {
      const { video, layers } = cameraPreset(quality);
      expect(layers).toEqual([VideoPresets.h180, VideoPresets.h360]);
      for (const layer of layers) {
        expect(layer.height).toBeLessThan(video.height);
        expect(layer.encoding.maxBitrate).toBeLessThan(video.encoding.maxBitrate);
      }
    }
  });

  it('labels: resolution and frame rate', () => {
    expect(CAMERA_QUALITIES.map(cameraQualityParts)).toEqual([
      { resolution: '480p', fps: 30 },
      { resolution: '720p', fps: 30 },
      { resolution: '1080p', fps: 30 },
    ]);
  });

  it('the capture asks for the preset’s size and frame rate, and the chosen camera only when there is one', () => {
    expect(cameraCaptureOptions('720p30', null)).toEqual({ resolution: VideoPresets.h720.resolution });
    expect(cameraCaptureOptions('1080p30', 'cam-2')).toEqual({ resolution: VideoPresets.h1080.resolution, deviceId: 'cam-2' });
    expect(VideoPresets.h720.resolution.frameRate).toBe(30);
  });

  it('publishes as the camera, with the preset’s encoding over the two lower layers', () => {
    expect(cameraPublishOptions('1080p30')).toEqual({
      source: S.Camera,
      simulcast: true,
      videoEncoding: VideoPresets.h1080.encoding,
      videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
    });
  });
});

describe('canPublishCamera (VIDEO: the server lists the camera source, permissions.ts)', () => {
  it('reads LiveKit permissions', () => {
    expect(CAMERA).toBe(1);
    expect(canPublishCamera(undefined)).toBe(false);
    expect(canPublishCamera({ canPublish: false, canPublishSources: [CAMERA] })).toBe(false);
    expect(canPublishCamera({ canPublish: true, canPublishSources: [MIC] })).toBe(false);
    expect(canPublishCamera({ canPublish: true, canPublishSources: [MIC, CAMERA, TrackSource.SCREEN_SHARE] })).toBe(true);
    expect(canPublishCamera({ canPublish: true, canPublishSources: [] })).toBe(true);
  });
});

describe('FrameWatch (spec §2: a frozen or vanished camera gives the tile back to the photo)', () => {
  it('moves after a frame, freezes after CAMERA_STALL_MS without one', () => {
    const watch = new FrameWatch();
    expect(watch.live(0)).toBe(false);
    watch.frame(1_000);
    expect(watch.live(1_000)).toBe(true);
    expect(watch.live(1_000 + CAMERA_STALL_MS - 1)).toBe(true);
    expect(watch.live(1_000 + CAMERA_STALL_MS)).toBe(false);
    watch.frame(5_000);
    expect(watch.live(5_100)).toBe(true);
  });

  it('a muted camera is not live, even with a recent frame', () => {
    const watch = new FrameWatch();
    watch.frame(100);
    watch.setMuted(true);
    expect(watch.live(150)).toBe(false);
    watch.setMuted(false);
    expect(watch.live(150)).toBe(true);
  });
});

describe('camera settings', () => {
  it('no camera chosen (the system’s first) and 720p30 by default', () => {
    expect(defaultVoiceSettings).toMatchObject({ cameraDeviceId: null, cameraQuality: '720p30' });
  });

  it('keeps a valid camera and quality, drops anything else', () => {
    expect(parseVoiceSettings({ cameraDeviceId: 'cam-2', cameraQuality: '1080p30' })).toMatchObject({ cameraDeviceId: 'cam-2', cameraQuality: '1080p30' });
    expect(parseVoiceSettings({ cameraDeviceId: 'x'.repeat(600), cameraQuality: '4k' })).toMatchObject({ cameraDeviceId: null, cameraQuality: '720p30' });
    expect(parseVoiceSettings({ cameraDeviceId: 7, cameraQuality: null })).toMatchObject({ cameraDeviceId: null, cameraQuality: '720p30' });
  });
});

describe('the voice store’s camera', () => {
  it('follows the button, and ends with the call', () => {
    let s = voiceReducer(initialVoiceState, { type: 'call', status: 'connected', channelId: 'VC1' });
    expect(s.camera).toBe(false);
    s = voiceReducer(s, { type: 'camera', on: true });
    expect(s.camera).toBe(true);
    expect(voiceReducer(s, { type: 'camera', on: true })).toBe(s);
    expect(voiceReducer(s, { type: 'call', status: 'reconnecting', channelId: 'VC1' }).camera).toBe(true);
    expect(voiceReducer(s, { type: 'call', status: 'idle', channelId: null }).camera).toBe(false);
  });

  it('who else has a camera comes from voice.state (`camera` per person)', () => {
    const p = { userId: BIA, muted: false, deafened: false, camera: true, screen: false, serverMuted: false };
    const s = voiceReducer(initialVoiceState, { type: 'serverEvent', event: { t: 'voice.state', d: { channelId: 'VC1', participants: [p] } } as never });
    expect(s.channels.VC1).toEqual([p]);
  });
});

// ---- the session ----

let h: Harness;
const room = () => h.rooms.at(-1)!;
const local = () => room().localParticipant;

/** Joins VC1 with VIDEO (LiveKit lists the camera source). */
async function joinWithVideo(): Promise<void> {
  await h.session.join('VC1');
  local().permissions = { canPublish: true, canPublishSources: [MIC, CAMERA] };
}

describe('receiving cameras (spec §1: everyone, automatically)', () => {
  beforeEach(() => {
    h = harness();
  });
  afterEach(async () => {
    await h.session.dispose();
  });

  it('subscribes the cameras already there, new ones, and again after a full reconnect', async () => {
    const originalConnect = FakeRoom.prototype.connect;
    FakeRoom.prototype.connect = async function (this: FakeRoom, url: string, token: string, opts: unknown) {
      this.addRemote(BIA, 'Bia', [S.Microphone, S.Camera]);
      return originalConnect.call(this, url, token, opts);
    };
    try {
      await h.session.join('VC1');
    } finally {
      FakeRoom.prototype.connect = originalConnect;
    }
    const bia = room().remoteParticipants.get(`u_${BIA}`)!;
    expect([...bia.trackPublications.values()].map((p) => p.subscribed)).toEqual([true, true]);

    const caio = room().addRemote(CAIO, 'Caio');
    expect(room().publish(caio, S.Camera).subscribed).toBe(true);

    // LiveKit's full reconnect: everyone comes back through TrackPublished.
    room().emit(RoomEvent.Reconnecting);
    room().remoteParticipants.delete(caio.identity);
    room().emit(RoomEvent.Reconnected);
    const back = room().addRemote(CAIO, 'Caio');
    expect(room().publish(back, S.Camera).subscribed).toBe(true);
  });

  it('a received camera goes to the camera outlet (never the audio one), and leaves with its track', async () => {
    await h.session.join('VC1');
    const bia = room().addRemote(BIA, 'Bia');
    const pub = new FakePub(S.Camera);
    const track = { kind: Track.Kind.Video };
    room().emit(RoomEvent.TrackSubscribed, track, pub, bia);
    expect(h.cameras.remote.get(BIA)).toBe(track);
    expect(h.videos.remote.size).toBe(0);
    expect(h.attached).toEqual([]);
    expect(h.state().subscribed).toEqual([]);
    room().emit(RoomEvent.TrackUnsubscribed, track, pub, bia);
    expect(h.cameras.remote.has(BIA)).toBe(false);
  });

  it('leaving the call drops every camera', async () => {
    await h.session.join('VC1');
    const bia = room().addRemote(BIA, 'Bia');
    room().emit(RoomEvent.TrackSubscribed, { kind: Track.Kind.Video }, new FakePub(S.Camera), bia);
    await h.session.leave();
    expect(h.cameras.remote.size).toBe(0);
    expect(h.cameras.clears).toBe(1);
  });
});

describe('my camera (spec §3)', () => {
  beforeEach(() => {
    h = harness();
  });
  afterEach(async () => {
    await h.session.dispose();
  });

  it('joining does not turn it on', async () => {
    await joinWithVideo();
    expect(local().cameraCalls).toEqual([]);
    expect(h.state().camera).toBe(false);
  });

  it('on: setCameraEnabled with the chosen quality and camera; my own track goes to the self-view', async () => {
    h.settings.value = { ...defaultVoiceSettings, cameraQuality: '1080p30', cameraDeviceId: 'cam-2' };
    await joinWithVideo();
    await h.session.setCamera(true);
    expect(local().cameraCalls).toEqual([{ capture: cameraCaptureOptions('1080p30', 'cam-2'), publish: cameraPublishOptions('1080p30') }]);
    expect(h.state().camera).toBe(true);
    expect(h.cameras.local).toBe(local().cameraTracks[0]);
    // On twice publishes once.
    await h.session.setCamera(true);
    expect(local().cameraCalls).toHaveLength(1);
  });

  it('off: unpublished and stopped (not just muted), so voice.state drops it and the light goes off', async () => {
    await joinWithVideo();
    await h.session.setCamera(true);
    const [track] = local().cameraTracks;
    await h.session.setCamera(false);
    expect(local().unpublished).toEqual([track]);
    expect(track!.stopped).toBe(true);
    expect(local().getTrackPublication(S.Camera)).toBeUndefined();
    expect(h.state().camera).toBe(false);
    expect(h.cameras.local).toBeNull();
  });

  it('without VIDEO, or outside a connected call, nothing opens', async () => {
    await h.session.setCamera(true);
    await h.session.join('VC1'); // the default fake permissions: the microphone only
    await h.session.setCamera(true);
    expect(h.rooms.flatMap((r) => r.localParticipant.cameraCalls)).toEqual([]);
    expect(h.state().camera).toBe(false);
  });

  it('a camera that cannot open (none, busy, refused) says so, and the button goes back off', async () => {
    await joinWithVideo();
    local().cameraOpen.fail = new Error('NotReadableError');
    await h.session.setCamera(true);
    expect(h.state().notice).toEqual({ kind: 'cameraUnavailable' });
    expect(h.state().camera).toBe(false);
    expect(h.state().call.status).toBe('connected');
    // LiveKit's MediaDevicesError for the camera is not the microphone's notice.
    room().emit(RoomEvent.MediaDevicesError, new Error('NotReadableError'), 'videoinput');
    expect(h.state().notice).toEqual({ kind: 'cameraUnavailable' });
  });

  it('turned off while it was opening: stopped as soon as it opens', async () => {
    await joinWithVideo();
    let open!: () => void;
    local().cameraOpen.wait = new Promise<void>((r) => (open = r));
    const on = h.session.setCamera(true);
    await flush();
    expect(local().cameraCalls).toHaveLength(1);
    const off = h.session.setCamera(false);
    expect(h.state().camera).toBe(false);
    open();
    await on;
    await off;
    expect(local().cameraTracks[0]!.stopped).toBe(true);
    expect(local().getTrackPublication(S.Camera)).toBeUndefined();
    expect(h.cameras.local).toBeNull();
  });

  it('a camera that opens after the call ended is stopped, never kept', async () => {
    await joinWithVideo();
    let open!: () => void;
    local().cameraOpen.wait = new Promise<void>((r) => (open = r));
    const first = local();
    const on = h.session.setCamera(true);
    await flush();
    await h.session.leave();
    open();
    await on;
    expect(first.cameraTracks[0]!.stopped).toBe(true);
    expect(h.cameras.local).toBeNull();
    expect(h.state().camera).toBe(false);
  });

  it('leaving the call turns it off; the next call starts with it off', async () => {
    await joinWithVideo();
    await h.session.setCamera(true);
    const [track] = local().cameraTracks;
    await h.session.leave();
    expect(track!.stopped).toBe(true);
    expect(h.state().camera).toBe(false);
    expect(h.cameras.local).toBeNull();
    await joinWithVideo();
    expect(local().cameraCalls).toEqual([]);
  });

  it('VIDEO taken away: LiveKit unpublishes it and the button goes off', async () => {
    await joinWithVideo();
    await h.session.setCamera(true);
    const pub = local().getTrackPublication(S.Camera)!;
    local().permissions = { canPublish: true, canPublishSources: [MIC] };
    room().emit(RoomEvent.LocalTrackUnpublished, pub, local());
    room().emit(RoomEvent.ParticipantPermissionsChanged, undefined, local());
    await flush();
    expect(h.state().camera).toBe(false);
    expect(h.cameras.local).toBeNull();
    expect(local().cameraTracks[0]!.stopped).toBe(true);
  });

  it('VIDEO taken away before LiveKit acts: the camera is taken back by itself', async () => {
    await joinWithVideo();
    await h.session.setCamera(true);
    local().permissions = { canPublish: true, canPublishSources: [MIC] };
    room().emit(RoomEvent.ParticipantPermissionsChanged, undefined, local());
    for (let i = 0; i < 5; i++) await flush();
    expect(h.state().camera).toBe(false);
    expect(local().cameraTracks[0]!.stopped).toBe(true);
  });

  it('another quality republishes a live camera with the new preset; off, it waits for the next time', async () => {
    await joinWithVideo();
    await h.session.restartCamera();
    expect(local().cameraCalls).toEqual([]);
    await h.session.setCamera(true);
    h.settings.value = { ...defaultVoiceSettings, cameraQuality: '480p30' };
    await h.session.restartCamera();
    expect(local().cameraTracks[0]!.stopped).toBe(true);
    expect(local().cameraCalls.map((c) => c.publish)).toEqual([cameraPublishOptions('720p30'), cameraPublishOptions('480p30')]);
    expect(h.cameras.local).toBe(local().cameraTracks[1]);
    expect(h.state().camera).toBe(true);
  });

  it('another camera is switched live with switchActiveDevice; the system default reopens it', async () => {
    await joinWithVideo();
    await h.session.switchCamera('cam-9');
    expect(room().switched).toEqual([]);
    await h.session.setCamera(true);
    await h.session.switchCamera('cam-9');
    expect(room().switched).toEqual([['videoinput', 'cam-9']]);
    await h.session.switchCamera(null);
    expect(local().cameraCalls).toHaveLength(2);
    expect(local().cameraTracks[0]!.stopped).toBe(true);
  });
});
