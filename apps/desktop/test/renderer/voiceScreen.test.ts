// Screen sharing in the voice session (spec 2026-10-01-transmitir-tela-design.md §2, §4, §5):
// watching is an opt-in subscription re-applied after reconnects; sharing publishes through
// the picker flow and ends with the capture.
import { RoomEvent, Track } from 'livekit-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screenCaptureOptions, screenVideoPublishOptions, SCREEN_AUDIO_PUBLISH, type ScreenSelection } from '../../src/renderer/features/voice/screenShare.js';
import { defaultVoiceSettings, screenVolumeKey, withVolume } from '../../src/renderer/features/voice/settings.js';
import { BIA, CAIO, ME, SCREEN_SOURCE, flush, harness, type FakeRemote, type Harness } from './voiceFakes.js';

const S = Track.Source;
let h: Harness;
const room = () => h.rooms.at(-1)!;
const sourcesOf = (p: FakeRemote) => [...p.trackPublications.values()].map((pub) => [pub.source, pub.subscribed]);

beforeEach(() => {
  h = harness();
});
afterEach(async () => {
  await h.session.dispose();
});

describe('watching a screen (spec §8.4: only on "Assistir")', () => {
  it('watch subscribes that person’s screen and its sound; microphones stay as they are', async () => {
    await h.session.join('VC1');
    const bia = room().addRemote(BIA, 'Bia', [S.Microphone, S.ScreenShare, S.ScreenShareAudio]);
    const caio = room().addRemote(CAIO, 'Caio', [S.ScreenShare]);
    h.session.watch(BIA);
    expect(h.state().watching).toEqual([BIA]);
    expect(sourcesOf(bia)).toEqual([
      [S.Microphone, null],
      [S.ScreenShare, true],
      [S.ScreenShareAudio, true],
    ]);
    expect(sourcesOf(caio)).toEqual([[S.ScreenShare, null]]);
  });

  it('unwatch unsubscribes both, and the picture goes away at once', async () => {
    await h.session.join('VC1');
    const bia = room().addRemote(BIA, 'Bia', [S.ScreenShare, S.ScreenShareAudio]);
    h.session.watch(BIA);
    const [video] = [...bia.trackPublications.values()];
    room().emit(RoomEvent.TrackSubscribed, { kind: Track.Kind.Video }, video, bia);
    expect(h.videos.remote.has(BIA)).toBe(true);
    h.session.unwatch(BIA);
    expect(h.state().watching).toEqual([]);
    expect(sourcesOf(bia)).toEqual([
      [S.ScreenShare, false],
      [S.ScreenShareAudio, false],
    ]);
    expect(h.videos.remote.has(BIA)).toBe(false);
  });

  it('a TrackPublished for a watched person subscribes it; for others, nothing', async () => {
    await h.session.join('VC1');
    const bia = room().addRemote(BIA, 'Bia');
    const caio = room().addRemote(CAIO, 'Caio');
    h.session.watch(BIA);
    expect(room().publish(bia, S.ScreenShare).subscribed).toBe(true);
    expect(room().publish(bia, S.ScreenShareAudio).subscribed).toBe(true);
    expect(room().publish(caio, S.ScreenShare).subscribed).toBeNull();
    // Cameras do not wait for "Assistir" (spec 2026-10-01-camera §1).
    expect(room().publish(caio, S.Camera).subscribed).toBe(true);
  });

  it('is re-applied after a full reconnect: everyone comes back through TrackPublished', async () => {
    await h.session.join('VC1');
    let bia = room().addRemote(BIA, 'Bia', [S.ScreenShare, S.ScreenShareAudio]);
    h.session.watch(BIA);
    // LiveKit's full reconnect: participants are removed first, then their tracks unpublished.
    room().emit(RoomEvent.Reconnecting);
    room().remoteParticipants.delete(bia.identity);
    for (const pub of bia.trackPublications.values()) room().emit(RoomEvent.TrackUnpublished, pub, bia);
    room().emit(RoomEvent.Reconnected);
    expect(h.state().watching).toEqual([BIA]);
    bia = room().addRemote(BIA, 'Bia');
    expect(room().publish(bia, S.ScreenShare).subscribed).toBe(true);
    expect(room().publish(bia, S.ScreenShareAudio).subscribed).toBe(true);
  });

  it('someone who stops sharing is no longer watched; someone who drops out (or reconnects) still is', async () => {
    await h.session.join('VC1');
    const bia = room().addRemote(BIA, 'Bia', [S.ScreenShare]);
    const caio = room().addRemote(CAIO, 'Caio', [S.ScreenShare]);
    h.session.watch(BIA);
    h.session.watch(CAIO);
    // Bia stops: her screen is unpublished while she stays in the room.
    room().emit(RoomEvent.TrackUnpublished, [...bia.trackPublications.values()][0], bia);
    // Caio's connection drops: he leaves the room first.
    room().remoteParticipants.delete(caio.identity);
    room().emit(RoomEvent.TrackUnpublished, [...caio.trackPublications.values()][0], caio);
    expect(h.state().watching).toEqual([CAIO]);
  });

  it('the picture goes to the video outlet; the sound plays apart from the voice, with the stream volume', async () => {
    h.settings.value = withVolume(withVolume(defaultVoiceSettings, 's1', BIA, 50), 's1', screenVolumeKey(BIA), 160);
    await h.session.join('VC1');
    const bia = room().addRemote(BIA, 'Bia', [S.ScreenShare, S.ScreenShareAudio]);
    h.session.watch(BIA);
    const [videoPub, audioPub] = [...bia.trackPublications.values()];
    const video = { kind: Track.Kind.Video };
    const audio = { kind: Track.Kind.Audio };
    room().emit(RoomEvent.TrackSubscribed, video, videoPub, bia);
    room().emit(RoomEvent.TrackSubscribed, audio, audioPub, bia);
    expect(h.videos.remote.get(BIA)).toBe(video);
    expect(h.attached).toEqual([{ track: audio, userId: BIA, source: 'screen' }]);
    expect([bia.volume, bia.screenVolume]).toEqual([0.5, 1.6]);
    // The stream's sound is not "receiving her microphone".
    expect(h.state().subscribed).toEqual([]);

    h.settings.value = withVolume(h.settings.value, 's1', screenVolumeKey(BIA), 20);
    h.session.applyVolumes();
    expect([bia.volume, bia.screenVolume]).toEqual([0.5, 0.2]);
    await h.session.setDeafened(true);
    expect([bia.volume, bia.screenVolume]).toEqual([0, 0]);

    room().emit(RoomEvent.TrackUnsubscribed, video, videoPub, bia);
    room().emit(RoomEvent.TrackUnsubscribed, audio, audioPub, bia);
    expect(h.videos.remote.has(BIA)).toBe(false);
    expect(h.attached).toEqual([]);
  });

  it('a screen that arrives after "Parar de assistir" is not shown', async () => {
    await h.session.join('VC1');
    const bia = room().addRemote(BIA, 'Bia', [S.ScreenShare, S.ScreenShareAudio]);
    const [videoPub, audioPub] = [...bia.trackPublications.values()];
    room().emit(RoomEvent.TrackSubscribed, { kind: Track.Kind.Video }, videoPub, bia);
    room().emit(RoomEvent.TrackSubscribed, { kind: Track.Kind.Audio }, audioPub, bia);
    expect(h.videos.remote.size).toBe(0);
    expect(h.attached).toEqual([]);
  });

  it('nobody watches their own screen, and outside a call watch does nothing', async () => {
    h.session.watch(BIA);
    expect(h.state().watching).toEqual([]);
    await h.session.join('VC1');
    h.session.watch(ME);
    expect(h.state().watching).toEqual([]);
  });

  it('leaving the call forgets what was watched and drops the pictures', async () => {
    await h.session.join('VC1');
    const bia = room().addRemote(BIA, 'Bia', [S.ScreenShare]);
    h.session.watch(BIA);
    room().emit(RoomEvent.TrackSubscribed, { kind: Track.Kind.Video }, [...bia.trackPublications.values()][0], bia);
    await h.session.leave();
    expect(h.state().watching).toEqual([]);
    expect(h.videos.remote.size).toBe(0);
  });
});

const selection = (extra: Partial<ScreenSelection> = {}): ScreenSelection => ({
  sourceId: SCREEN_SOURCE.id,
  name: SCREEN_SOURCE.name,
  quality: '1080p30',
  content: 'motion',
  audio: true,
  ...extra,
});

describe('sharing my screen (spec §2, §4)', () => {
  it('the picker’s choice goes to main, then the screen and its sound are published, with a preview', async () => {
    await h.session.join('VC1');
    h.picker.next = selection({ quality: '1080p60' });
    await h.session.startScreenShare();
    const local = room().localParticipant;
    expect(h.picker.opened).toBe(1);
    expect(h.chosen).toEqual([{ sourceId: SCREEN_SOURCE.id, audio: true }]);
    expect(local.captures).toEqual([screenCaptureOptions('1080p60', 'motion', true)]);
    expect(local.published.slice(-2).map((p) => [p.track, p.options])).toEqual([
      [local.screenTracks[0], screenVideoPublishOptions('1080p60', 'motion')],
      [local.screenTracks[1], SCREEN_AUDIO_PUBLISH],
    ]);
    expect(h.state().sharing).toEqual({ quality: '1080p60', content: 'motion', audio: true, name: 'Tela 1' });
    expect(h.videos.local).toBe(local.screenTracks[0]);
    expect(h.state().notice).toBeNull();
  });

  it('cancelling the picker changes nothing and says nothing', async () => {
    await h.session.join('VC1');
    h.picker.next = null;
    await h.session.startScreenShare();
    expect(room().localParticipant.captures).toEqual([]);
    expect(h.state().sharing).toBeNull();
    expect(h.state().notice).toBeNull();
  });

  it('a capture main refused (the window closed meanwhile) says so', async () => {
    await h.session.join('VC1');
    room().localParticipant.screenCapture = new DOMException('refused', 'AbortError');
    h.picker.next = selection();
    await h.session.startScreenShare();
    expect(h.state().sharing).toBeNull();
    expect(h.state().notice).toEqual({ kind: 'screenFailed' });
  });

  it('without the sound exclusion (Windows 10): picture only, with the notice', async () => {
    await h.session.join('VC1');
    room().localParticipant.screenCapture = { audioDeviceId: 'loopback' };
    h.picker.next = selection();
    await h.session.startScreenShare();
    const local = room().localParticipant;
    expect(local.screenTracks[1]!.stopped).toBe(true);
    expect(local.screenPubs.has(S.ScreenShareAudio)).toBe(false);
    expect(h.state().sharing).toMatchObject({ audio: false });
    expect(h.state().notice).toEqual({ kind: 'screenAudio' });
  });

  it('"Parar transmissão" unpublishes and stops both, and the panel goes back to normal', async () => {
    await h.session.join('VC1');
    h.picker.next = selection();
    await h.session.startScreenShare();
    const local = room().localParticipant;
    await h.session.stopScreenShare();
    expect(local.unpublished).toEqual(local.screenTracks);
    expect(local.screenTracks.map((t) => t.stopped)).toEqual([true, true]);
    expect(h.state().sharing).toBeNull();
    expect(h.videos.local).toBeNull();
  });

  it('the capture ending by itself (the window closed) stops the share', async () => {
    await h.session.join('VC1');
    h.picker.next = selection();
    await h.session.startScreenShare();
    const local = room().localParticipant;
    local.screenTracks[0]!.end();
    await flush();
    expect(h.state().sharing).toBeNull();
    expect(local.screenTracks.map((t) => t.stopped)).toEqual([true, true]);
  });

  it('LiveKit taking the screen off the air (VIDEO permission removed) stops the share', async () => {
    await h.session.join('VC1');
    h.picker.next = selection({ audio: false });
    room().localParticipant.screenCapture = { audioDeviceId: null };
    await h.session.startScreenShare();
    const local = room().localParticipant;
    room().emit(RoomEvent.LocalTrackUnpublished, local.screenPubs.get(S.ScreenShare), local);
    await flush();
    expect(h.state().sharing).toBeNull();
    expect(local.screenTracks[0]!.stopped).toBe(true);
  });

  it('leaving the call ends the share', async () => {
    await h.session.join('VC1');
    h.picker.next = selection();
    await h.session.startScreenShare();
    const local = room().localParticipant;
    await h.session.leave();
    expect(local.screenTracks.map((t) => t.stopped)).toEqual([true, true]);
    expect(h.state().sharing).toBeNull();
    expect(h.videos.local).toBeNull();
  });

  it('one share at a time: a second start while one is starting or live does nothing', async () => {
    await h.session.join('VC1');
    let release!: (s: ScreenSelection) => void;
    h.picker.next = new Promise((r) => (release = r));
    const first = h.session.startScreenShare();
    await flush();
    await h.session.startScreenShare();
    release(selection());
    await first;
    await h.session.startScreenShare();
    expect(h.picker.opened).toBe(1);
    expect(room().localParticipant.captures).toHaveLength(1);
  });

  it('the call ending while the picker is open: nothing is captured; outside a call nothing opens', async () => {
    await h.session.startScreenShare();
    expect(h.picker.opened).toBe(0);
    await h.session.join('VC1');
    let release!: (s: ScreenSelection) => void;
    h.picker.next = new Promise((r) => (release = r));
    const sharing = h.session.startScreenShare();
    await flush();
    const local = room().localParticipant;
    await h.session.leave();
    release(selection());
    await sharing;
    expect(local.captures).toEqual([]);
    expect(h.state().sharing).toBeNull();
  });
});
