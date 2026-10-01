import { EventEmitter } from 'node:events';
import { AudioPresets, ScreenSharePresets, Track, VideoPreset, type LocalTrack } from 'livekit-client';
import { describe, expect, it } from 'vitest';
import type { ScreenChoice, ScreenSource } from '../../src/shared/screenTypes.js';
import {
  SCREEN_AUDIO_PUBLISH,
  keepScreenAudio,
  screenCaptureOptions,
  screenPreset,
  screenVideoPublishOptions,
  startScreenShare,
  stopScreenShare,
  wantsSubscription,
  type ScreenPublisher,
  type ScreenSelection,
} from '../../src/renderer/features/voice/screenShare.js';

const BIA = 'b'.repeat(32);
const CAIO = 'c'.repeat(32);

describe('screen presets (spec §6)', () => {
  it('720p30 is LiveKit’s h720fps30 with one lower 360p layer', () => {
    const p = screenPreset('720p30');
    expect(p.video).toBe(ScreenSharePresets.h720fps30);
    expect(p.layers.map((l) => [l.width, l.height, l.encoding.maxFramerate])).toEqual([[640, 360, 30]]);
  });

  it('1080p30 (the default) is LiveKit’s h1080fps30 with one lower 720p layer', () => {
    const p = screenPreset('1080p30');
    expect(p.video).toBe(ScreenSharePresets.h1080fps30);
    expect(p.layers).toEqual([ScreenSharePresets.h720fps30]);
  });

  it('1080p60 is 1920×1080 at 8 Mbps and 60 fps, with one lower 720p30 layer', () => {
    const p = screenPreset('1080p60');
    expect(p.video).toEqual(new VideoPreset(1920, 1080, 8_000_000, 60));
    expect(p.layers).toEqual([ScreenSharePresets.h720fps30]);
  });

  it('every lower layer is smaller and cheaper than its preset (simulcast with 2 layers)', () => {
    for (const q of ['720p30', '1080p30', '1080p60'] as const) {
      const { video, layers } = screenPreset(q);
      expect(layers).toHaveLength(1);
      expect(layers[0]!.height).toBeLessThan(video.height);
      expect(layers[0]!.encoding.maxBitrate).toBeLessThan(video.encoding.maxBitrate);
    }
  });
});

describe('screenCaptureOptions (what reaches getDisplayMedia)', () => {
  it('asks for the preset’s size and frame rate and the content hint', () => {
    expect(screenCaptureOptions('1080p60', 'motion', false)).toEqual({
      audio: false,
      resolution: { width: 1920, height: 1080, frameRate: 60, aspectRatio: 1920 / 1080 },
      contentHint: 'motion',
    });
    expect(screenCaptureOptions('720p30', 'detail', false)).toMatchObject({ resolution: { width: 1280, height: 720, frameRate: 30 }, contentHint: 'detail' });
  });

  it('with sound: the PC’s sound without GhostLink’s own, and none of the voice processing (spec §4)', () => {
    expect(screenCaptureOptions('1080p30', 'motion', true).audio).toEqual({
      restrictOwnAudio: true,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
  });
});

describe('publish options', () => {
  it('video: ScreenShare with the preset’s encoding and its lower layer', () => {
    expect(screenVideoPublishOptions('1080p30', 'detail')).toEqual({
      source: Track.Source.ScreenShare,
      simulcast: true,
      screenShareEncoding: ScreenSharePresets.h1080fps30.encoding,
      screenShareSimulcastLayers: [ScreenSharePresets.h720fps30],
    });
  });

  it('games and video keep the frame rate when the connection struggles', () => {
    expect(screenVideoPublishOptions('1080p60', 'motion')).toMatchObject({
      screenShareEncoding: { maxBitrate: 8_000_000, maxFramerate: 60 },
      degradationPreference: 'maintain-framerate',
    });
    expect(screenVideoPublishOptions('1080p60', 'detail')).not.toHaveProperty('degradationPreference');
  });

  it('sound: ScreenShareAudio in stereo, without DTX or RED (music and games, not voice)', () => {
    expect(SCREEN_AUDIO_PUBLISH).toEqual({
      source: Track.Source.ScreenShareAudio,
      forceStereo: true,
      dtx: false,
      red: false,
      audioPreset: AudioPresets.musicHighQualityStereo,
    });
  });
});

describe('keepScreenAudio (spec §4: the mandatory check)', () => {
  const track = (deviceId: string | undefined) => ({ getSettings: () => (deviceId === undefined ? {} : { deviceId }) });

  it('keeps only the capture that excludes GhostLink’s own audio', () => {
    expect(keepScreenAudio(track('loopbackWithoutChrome'))).toBe(true);
  });

  it('drops plain loopback (the call would echo back) and anything unknown', () => {
    for (const id of ['loopback', 'default', '', 'LOOPBACKWITHOUTCHROME', undefined]) expect(keepScreenAudio(track(id)), String(id)).toBe(false);
  });
});

describe('wantsSubscription (spec §8.4: microphones and cameras always, a screen only while watched)', () => {
  const S = Track.Source;
  const K = Track.Kind;

  it('always the microphones', () => {
    expect(wantsSubscription(S.Microphone, K.Audio, BIA, [])).toBe(true);
    expect(wantsSubscription(S.Microphone, K.Audio, null, [])).toBe(true);
  });

  it('a screen and its sound only for someone being watched', () => {
    expect(wantsSubscription(S.ScreenShare, K.Video, BIA, [])).toBe(false);
    expect(wantsSubscription(S.ScreenShareAudio, K.Audio, BIA, [])).toBe(false);
    expect(wantsSubscription(S.ScreenShare, K.Video, BIA, [BIA])).toBe(true);
    expect(wantsSubscription(S.ScreenShareAudio, K.Audio, BIA, [BIA])).toBe(true);
    expect(wantsSubscription(S.ScreenShare, K.Video, CAIO, [BIA])).toBe(false);
    expect(wantsSubscription(S.ScreenShare, K.Video, null, [BIA])).toBe(false);
  });

  it('always the cameras, watched or not (spec 2026-10-01-camera §1: everyone sees them, like Discord)', () => {
    expect(wantsSubscription(S.Camera, K.Video, BIA, [])).toBe(true);
    expect(wantsSubscription(S.Camera, K.Video, BIA, [BIA])).toBe(true);
    expect(wantsSubscription(S.Camera, K.Video, null, [])).toBe(true);
  });

  it('never odd source/kind pairs', () => {
    expect(wantsSubscription(S.Camera, K.Audio, BIA, [BIA])).toBe(false);
    expect(wantsSubscription(S.Microphone, K.Video, BIA, [BIA])).toBe(false);
    expect(wantsSubscription(S.ScreenShare, K.Audio, BIA, [BIA])).toBe(false);
    expect(wantsSubscription(S.Unknown, K.Audio, BIA, [BIA])).toBe(false);
  });
});

// ---- the publishing flow, with a fake LocalParticipant ----

class FakeScreenTrack extends EventEmitter {
  stopped = false;
  constructor(
    readonly kind: Track.Kind,
    readonly source: Track.Source,
    readonly deviceId = '',
  ) {
    super();
  }
  readonly mediaStreamTrack = { getSettings: () => ({ deviceId: this.deviceId }) };
  stop(): void {
    this.stopped = true;
  }
}

class FakePublisher implements ScreenPublisher {
  /** What the next capture yields: the sound's deviceId, null for no sound track, or an error. */
  capture: { audioDeviceId: string | null } | Error = { audioDeviceId: 'loopbackWithoutChrome' };
  failPublish: Track.Source | null = null;
  readonly captured: unknown[] = [];
  readonly tracks: FakeScreenTrack[] = [];
  readonly published: Array<{ track: FakeScreenTrack; options: unknown }> = [];
  readonly unpublished: FakeScreenTrack[] = [];
  async createScreenTracks(options: unknown): Promise<LocalTrack[]> {
    this.captured.push(options);
    if (this.capture instanceof Error) throw this.capture;
    const tracks = [new FakeScreenTrack(Track.Kind.Video, Track.Source.ScreenShare)];
    if (this.capture.audioDeviceId !== null) tracks.push(new FakeScreenTrack(Track.Kind.Audio, Track.Source.ScreenShareAudio, this.capture.audioDeviceId));
    this.tracks.push(...tracks);
    return tracks as unknown as LocalTrack[];
  }
  async publishTrack(track: LocalTrack, options: { source?: Track.Source }): Promise<unknown> {
    if (options.source === this.failPublish) throw new Error('failed to publish track, insufficient permissions');
    this.published.push({ track: track as unknown as FakeScreenTrack, options });
    return {};
  }
  async unpublishTrack(track: LocalTrack): Promise<unknown> {
    this.unpublished.push(track as unknown as FakeScreenTrack);
    return undefined;
  }
}

const SCREEN: ScreenSource = { id: 'screen:1:0', name: 'Tela 1', kind: 'screen', thumbnail: null, icon: null };
const pick = (extra: Partial<ScreenSelection> = {}): ScreenSelection => ({ sourceId: SCREEN.id, name: 'Tela 1', quality: '1080p30', content: 'motion', audio: true, ...extra });

function flowDeps(selection: ScreenSelection | null, opts: { failChoose?: boolean } = {}) {
  const log: string[] = [];
  const chosen: ScreenChoice[] = [];
  let listed: Promise<ScreenSource[]> | null = null;
  return {
    log,
    chosen,
    listed: () => listed,
    deps: {
      sources: async () => {
        log.push('sources');
        return [SCREEN];
      },
      pick: async (sources: Promise<ScreenSource[]>) => {
        listed = sources;
        log.push('pick');
        return selection;
      },
      choose: async (choice: ScreenChoice) => {
        log.push('choose');
        if (opts.failChoose) throw new Error('BAD_REQUEST');
        chosen.push(choice);
      },
    },
  };
}

describe('startScreenShare (the publishing flow)', () => {
  it('lists the sources for the picker, tells main the choice, then captures and publishes video and sound', async () => {
    const pub = new FakePublisher();
    const f = flowDeps(pick());
    const outcome = await startScreenShare(pub, f.deps, () => true);
    expect(f.log).toEqual(['sources', 'pick', 'choose']);
    expect(await f.listed()).toEqual([SCREEN]);
    expect(f.chosen).toEqual([{ sourceId: SCREEN.id, audio: true }]);
    expect(pub.captured).toEqual([screenCaptureOptions('1080p30', 'motion', true)]);
    expect(pub.published.map((p) => p.options)).toEqual([screenVideoPublishOptions('1080p30', 'motion'), SCREEN_AUDIO_PUBLISH]);
    expect(outcome).toMatchObject({ kind: 'live', audioDropped: false, share: { selection: pick(), video: pub.tracks[0], audio: pub.tracks[1] } });
  });

  it('without sound: asks main for no sound and captures none', async () => {
    const pub = new FakePublisher();
    pub.capture = { audioDeviceId: null };
    const f = flowDeps(pick({ audio: false }));
    const outcome = await startScreenShare(pub, f.deps, () => true);
    expect(f.chosen).toEqual([{ sourceId: SCREEN.id, audio: false }]);
    expect(pub.captured).toEqual([screenCaptureOptions('1080p30', 'motion', false)]);
    expect(pub.published).toHaveLength(1);
    expect(outcome).toMatchObject({ kind: 'live', audioDropped: false, share: { audio: null } });
  });

  it('a sound track that would include GhostLink’s own audio is stopped, never published: picture only, with the notice', async () => {
    const pub = new FakePublisher();
    pub.capture = { audioDeviceId: 'loopback' };
    const outcome = await startScreenShare(pub, flowDeps(pick()).deps, () => true);
    expect(pub.tracks[1]!.stopped).toBe(true);
    expect(pub.published.map((p) => p.track)).toEqual([pub.tracks[0]]);
    expect(outcome).toMatchObject({ kind: 'live', audioDropped: true, share: { audio: null } });
  });

  it('sound asked for but none captured: picture only, with the notice', async () => {
    const pub = new FakePublisher();
    pub.capture = { audioDeviceId: null };
    const outcome = await startScreenShare(pub, flowDeps(pick()).deps, () => true);
    expect(outcome).toMatchObject({ kind: 'live', audioDropped: true, share: { audio: null } });
  });

  it('cancelling the picker does nothing at all', async () => {
    const pub = new FakePublisher();
    const f = flowDeps(null);
    expect(await startScreenShare(pub, f.deps, () => true)).toEqual({ kind: 'cancelled' });
    expect(f.log).toEqual(['sources', 'pick']);
    expect(pub.captured).toEqual([]);
  });

  it('a refused capture (the source vanished: AbortError) or a refused choice fails', async () => {
    const pub = new FakePublisher();
    pub.capture = new DOMException('Could not start video source', 'AbortError');
    expect(await startScreenShare(pub, flowDeps(pick()).deps, () => true)).toEqual({ kind: 'failed' });
    const other = new FakePublisher();
    expect(await startScreenShare(other, flowDeps(pick(), { failChoose: true }).deps, () => true)).toEqual({ kind: 'failed' });
    expect(other.captured).toEqual([]);
  });

  it('a refused publish stops both tracks and takes back what was published', async () => {
    const pub = new FakePublisher();
    pub.failPublish = Track.Source.ScreenShareAudio;
    expect(await startScreenShare(pub, flowDeps(pick()).deps, () => true)).toEqual({ kind: 'failed' });
    expect(pub.tracks.map((t) => t.stopped)).toEqual([true, true]);
    expect(pub.unpublished).toEqual([pub.tracks[0]]);
  });

  it('the call ended while picking or capturing: nothing stays captured or published', async () => {
    const afterPick = new FakePublisher();
    expect(await startScreenShare(afterPick, flowDeps(pick()).deps, () => false)).toEqual({ kind: 'cancelled' });
    expect(afterPick.captured).toEqual([]);

    let checks = 0;
    const afterCapture = new FakePublisher();
    expect(await startScreenShare(afterCapture, flowDeps(pick()).deps, () => ++checks < 2)).toEqual({ kind: 'cancelled' });
    expect(afterCapture.tracks.map((t) => t.stopped)).toEqual([true, true]);
    expect(afterCapture.published).toEqual([]);

    checks = 0;
    const afterPublish = new FakePublisher();
    expect(await startScreenShare(afterPublish, flowDeps(pick()).deps, () => ++checks < 3)).toEqual({ kind: 'cancelled' });
    expect(afterPublish.tracks.map((t) => t.stopped)).toEqual([true, true]);
    expect(afterPublish.unpublished).toEqual(afterPublish.tracks);
  });
});

describe('stopScreenShare', () => {
  it('unpublishes and stops the picture and the sound', async () => {
    const pub = new FakePublisher();
    const outcome = await startScreenShare(pub, flowDeps(pick()).deps, () => true);
    if (outcome.kind !== 'live') throw new Error('not live');
    await stopScreenShare(pub, outcome.share);
    expect(pub.unpublished).toEqual(pub.tracks);
    expect(pub.tracks.map((t) => t.stopped)).toEqual([true, true]);
  });

  it('still stops the tracks when unpublishing fails (e.g. the room is gone)', async () => {
    const pub = new FakePublisher();
    const outcome = await startScreenShare(pub, flowDeps(pick()).deps, () => true);
    if (outcome.kind !== 'live') throw new Error('not live');
    pub.unpublishTrack = async () => {
      throw new Error('not connected');
    };
    await stopScreenShare(pub, outcome.share);
    expect(pub.tracks.map((t) => t.stopped)).toEqual([true, true]);
  });
});
