import { RoomEvent, Track, type LocalAudioTrack } from 'livekit-client';
import { TrackSource } from 'livekit-server-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceSession, canPublishMicrophone } from '../../src/renderer/features/voice/session.js';
import { defaultVoiceSettings, withLocalMute, withVolume } from '../../src/renderer/features/voice/settings.js';
import { BIA, CAIO, FakePub, FakeRoom, FakeTrack, MIC, ME, flush, harness, participant, type Harness } from './voiceFakes.js';

let h: Harness;

const room = () => h.rooms.at(-1)!;

beforeEach(() => {
  h = harness();
});
afterEach(async () => {
  await h.session.dispose();
  vi.useRealTimers();
});

describe('joining a voice channel (spec §8.2)', () => {
  it('asks the server, then connects with the spec options: no auto-subscribe, only our ICE servers', async () => {
    await h.session.join('VC1');
    expect(h.requests[0]).toEqual(['voice.join', { channelId: 'VC1' }]);
    expect(room().options).toMatchObject({
      adaptiveStream: true,
      dynacast: true,
      webAudioMix: true,
      // RNNoise by default: the browser's own noise suppression stays off (noise spec §2).
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: false, autoGainControl: true, voiceIsolation: false },
    });
    expect(room().connected).toEqual({ url: 'wss://127.0.0.1:7700', token: 'token-VC1', opts: { autoSubscribe: false, rtcConfig: { iceServers: [] } } });
    expect(h.state().call).toEqual({ status: 'connected', channelId: 'VC1' });
  });

  it('uses the chosen devices', async () => {
    h.settings.value = { ...defaultVoiceSettings, inputDeviceId: 'mic-2', outputDeviceId: 'spk-3' };
    await h.session.join('VC1');
    expect(room().options.audioCaptureDefaults).toMatchObject({ deviceId: 'mic-2' });
    expect(room().options.audioOutput).toEqual({ deviceId: 'spk-3' });
  });

  it('publishes its own gated microphone track with the capture constraints, and tells the server its self state', async () => {
    h.settings.value = { ...defaultVoiceSettings, inputDeviceId: 'mic-2' };
    await h.session.join('VC1');
    expect(h.microphones.map((m) => m.options)).toEqual([
      { echoCancellation: true, noiseSuppression: false, autoGainControl: true, voiceIsolation: false, deviceId: 'mic-2' },
    ]);
    expect(room().localParticipant.published).toEqual([{ track: h.microphones[0], options: { source: Track.Source.Microphone } }]);
    expect(room().localParticipant.micCalls).toEqual([]);
    expect(h.requests).toContainEqual(['voice.selfState', { muted: false, deafened: false }]);
  });

  it('asks the browser for its own noise suppression only in the WebRTC mode (noise spec §2)', async () => {
    h.settings.value = { ...defaultVoiceSettings, noiseSuppression: 'webrtc' };
    await h.session.join('VC1');
    expect(room().options.audioCaptureDefaults).toMatchObject({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
    expect(h.microphones[0]!.options).toMatchObject({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
  });

  it('a refused join shows the error and never touches LiveKit', async () => {
    h.respond.set('voice.join', () => {
      throw new Error('CHANNEL_FULL');
    });
    await h.session.join('VC1');
    expect(h.rooms).toEqual([]);
    expect(h.state().call.status).toBe('idle');
    expect(h.state().notice).toEqual({ kind: 'error', code: 'CHANNEL_FULL' });
  });

  it.each([
    ['a livekitUrl on another host', { livekitUrl: 'wss://evil.example:7700', iceServers: [] }, '127.0.0.1:7700'],
    ['a livekitUrl on another port', { livekitUrl: 'wss://127.0.0.1:7443', iceServers: [] }, '127.0.0.1:7700'],
    ['a plain ws: livekitUrl', { livekitUrl: 'ws://127.0.0.1:7700', iceServers: [] }, '127.0.0.1:7700'],
    ['a third-party STUN server', { livekitUrl: 'wss://127.0.0.1:7700', iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }, '127.0.0.1:7700'],
    ['no connected address', { livekitUrl: 'wss://127.0.0.1:7700', iceServers: [] }, null],
  ])('refuses %s before LiveKit connects, and releases the server assignment', async (_label, answer, connected) => {
    h.address.value = connected;
    h.respond.set('voice.join', () => ({ ...answer, token: 't' }));
    await h.session.join('VC1');
    expect(h.rooms).toEqual([]);
    expect(h.state().call).toEqual({ status: 'idle', channelId: null });
    expect(h.state().notice).toEqual({ kind: 'error', code: 'VOICE_URL_REJECTED' });
    expect(h.requests.map(([t]) => t)).toEqual(['voice.join', 'voice.leave']);
  });

  it('accepts the connected host and port, and STUN/TURN on that host', async () => {
    h.address.value = '[::1]:7710';
    h.respond.set('voice.join', () => ({ livekitUrl: 'wss://[::1]:7710', token: 't', iceServers: [{ urls: 'turn:[::1]:3478?transport=udp' }] }));
    await h.session.join('VC1');
    expect(room().connected).toMatchObject({ url: 'wss://[::1]:7710', opts: { rtcConfig: { iceServers: [{ urls: 'turn:[::1]:3478?transport=udp' }] } } });
    expect(h.state().call.status).toBe('connected');
  });

  it('a LiveKit connection failure leaves the call and releases the server assignment', async () => {
    h.respond.set('voice.join', (p) => ({ livekitUrl: 'wss://127.0.0.1:7700', token: `t-${(p as { channelId: string }).channelId}`, iceServers: [] }));
    const original = FakeRoom.prototype.connect;
    FakeRoom.prototype.connect = async function () {
      throw new Error('signal failed');
    };
    try {
      await h.session.join('VC1');
    } finally {
      FakeRoom.prototype.connect = original;
    }
    expect(h.state().call.status).toBe('idle');
    expect(h.state().notice).toEqual({ kind: 'dropped' });
    expect(h.requests.map(([t]) => t)).toContain('voice.leave');
  });

  it('switching channels leaves the old room first; joining the same channel again does nothing', async () => {
    await h.session.join('VC1');
    const first = room();
    await h.session.join('VC1');
    expect(h.rooms).toHaveLength(1);
    await h.session.join('VC2');
    expect(first.disconnects).toBe(1);
    expect(h.rooms).toHaveLength(2);
    expect(h.state().call).toEqual({ status: 'connected', channelId: 'VC2' });
  });

  it('a join superseded by another never connects its room', async () => {
    let release!: () => void;
    h.respond.set('voice.join', (p) =>
      new Promise((r) => {
        const channelId = (p as { channelId: string }).channelId;
        const value = { livekitUrl: 'wss://127.0.0.1:7700', token: `t-${channelId}`, iceServers: [] };
        if (channelId === 'VC1') release = () => r(value);
        else r(value);
      }),
    );
    const slow = h.session.join('VC1');
    await flush();
    await h.session.join('VC2');
    release();
    await slow;
    expect(h.rooms.map((r) => r.connected?.token)).toEqual(['t-VC2']);
    expect(h.state().call.channelId).toBe('VC2');
  });
});

describe('media in the call (spec §8.4)', () => {
  it('subscribes to microphones, cameras and screens already there, and to new ones', async () => {
    h.respond.set('voice.join', () => {
      // Someone is already in the room when we connect.
      return { livekitUrl: 'wss://127.0.0.1:7700', token: 't', iceServers: [] };
    });
    const originalConnect = FakeRoom.prototype.connect;
    FakeRoom.prototype.connect = async function (this: FakeRoom, url: string, token: string, opts: unknown) {
      this.addRemote(BIA, 'Bia', [Track.Source.Microphone, Track.Source.Camera, Track.Source.ScreenShare]);
      return originalConnect.call(this, url, token, opts);
    };
    try {
      await h.session.join('VC1');
    } finally {
      FakeRoom.prototype.connect = originalConnect;
    }
    const bia = room().remoteParticipants.get(`u_${BIA}`)!;
    const subs = [...bia.trackPublications.values()].map((p) => [p.source, p.subscribed]);
    expect(subs).toEqual([
      [Track.Source.Microphone, true],
      [Track.Source.Camera, true],
      // A screen live when I join plays without a click (owner, 2026-10-02).
      [Track.Source.ScreenShare, true],
    ]);
    expect(h.state().names[BIA]).toBe('Bia');

    const caio = room().addRemote(CAIO, 'Caio');
    const mic = new FakePub(Track.Source.Microphone);
    const cam = new FakePub(Track.Source.Camera);
    room().emit(RoomEvent.TrackPublished, mic, caio);
    room().emit(RoomEvent.TrackPublished, cam, caio);
    expect(mic.subscribed).toBe(true);
    expect(cam.subscribed).toBe(true);
  });

  it('attaches subscribed audio with the per-user volume, and detaches it again', async () => {
    h.settings.value = withVolume(defaultVoiceSettings, 's1', BIA, 150);
    await h.session.join('VC1');
    const bia = room().addRemote(BIA, 'Bia');
    const track = { kind: Track.Kind.Audio };
    const pub = new FakePub(Track.Source.Microphone);
    room().emit(RoomEvent.TrackSubscribed, track, pub, bia);
    expect(h.attached).toEqual([{ track, userId: BIA }]);
    expect(bia.volume).toBe(1.5);
    expect(h.state().subscribed).toEqual([BIA]);
    room().emit(RoomEvent.TrackUnsubscribed, track, pub, bia);
    expect(h.attached).toEqual([]);
    expect(h.state().subscribed).toEqual([]);
  });

  it('a volume change applies at once', async () => {
    await h.session.join('VC1');
    const bia = room().addRemote(BIA, 'Bia');
    h.settings.value = withVolume(defaultVoiceSettings, 's1', BIA, 40);
    h.session.applyVolumes();
    expect(bia.volume).toBe(0.4);
  });

  it('marks who is speaking from ActiveSpeakersChanged', async () => {
    await h.session.join('VC1');
    room().emit(RoomEvent.ActiveSpeakersChanged, [{ identity: `u_${BIA}` }, { identity: 'agent' }, { identity: `u_${ME}` }]);
    expect(h.state().speaking).toEqual([BIA, ME]);
  });

  it('resumes audio playback on the next user gesture when the browser blocked it', async () => {
    await h.session.join('VC1');
    room().canPlaybackAudio = false;
    room().emit(RoomEvent.AudioPlaybackStatusChanged, false);
    expect(h.gestures).toHaveLength(1);
    h.gestures[0]!();
    await flush();
    expect(room().startAudioCalls).toBe(1);
  });

  it('reports the signal round trip as the ping', async () => {
    vi.useFakeTimers();
    await h.session.join('VC1');
    room().engine.client.rtt = 37.4;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.state().pingMs).toBe(37);
  });

  it('switches devices live', async () => {
    await h.session.join('VC1');
    await h.session.switchDevice('audioinput', 'mic-9');
    await h.session.switchDevice('audiooutput', 'spk-9');
    expect(room().switched).toEqual([['audioinput', 'mic-9'], ['audiooutput', 'spk-9']]);
  });

  it('a microphone failure is reported, and the call stays up', async () => {
    h.failMicrophone.next = true;
    await h.session.join('VC1');
    expect(h.state().notice).toEqual({ kind: 'micUnavailable' });
    expect(h.state().call.status).toBe('connected');
    expect(room().localParticipant.published).toEqual([]);
  });

  it('a microphone that opens after the call ended is stopped, never published', async () => {
    let open!: () => void;
    const slow = new Promise<void>((r) => (open = r));
    const session = new VoiceSession({
      ...h.deps,
      outlet: { attach: () => {}, detach: () => {}, detachAll: () => {} },
      createMicrophone: async (options) => {
        await slow;
        const track = new FakeTrack(options as Record<string, unknown>);
        h.microphones.push(track);
        return track as unknown as LocalAudioTrack;
      },
    });
    const joining = session.join('VC1');
    for (let i = 0; i < 5; i++) await flush();
    await session.leave();
    open();
    await joining;
    expect(h.microphones[0]!.stopped).toBe(true);
    expect(room().localParticipant.published).toEqual([]);
  });
});

describe('mute and deafen (spec §8.3: self state is display only; the real mute is the local microphone)', () => {
  it('mute turns the microphone off and tells the server; unmute turns it back on', async () => {
    await h.session.join('VC1');
    const local = room().localParticipant;
    await h.session.setMuted(true);
    expect(local.micCalls.at(-1)!.enabled).toBe(false);
    expect(h.requests.at(-1)).toEqual(['voice.selfState', { muted: true, deafened: false }]);
    await h.session.setMuted(false);
    expect(local.micCalls.at(-1)!.enabled).toBe(true);
    expect(h.requests.at(-1)).toEqual(['voice.selfState', { muted: false, deafened: false }]);
  });

  it('deafen silences everyone and the microphone; undeafen restores both', async () => {
    h.settings.value = withVolume(defaultVoiceSettings, 's1', BIA, 120);
    await h.session.join('VC1');
    const bia = room().addRemote(BIA, 'Bia');
    await h.session.setDeafened(true);
    expect(bia.volume).toBe(0);
    expect(room().localParticipant.micCalls.at(-1)!.enabled).toBe(false);
    expect(h.requests.at(-1)).toEqual(['voice.selfState', { muted: true, deafened: true }]);
    await h.session.setDeafened(false);
    expect(bia.volume).toBe(1.2);
    expect(room().localParticipant.micCalls.at(-1)!.enabled).toBe(true);
  });

  it('muting someone for myself silences their voice only, and keeps their volume for later', async () => {
    h.settings.value = withLocalMute(withVolume(defaultVoiceSettings, 's1', BIA, 150), 's1', BIA, true);
    await h.session.join('VC1');
    const bia = room().addRemote(BIA, 'Bia');
    h.session.applyVolumes();
    expect([bia.volume, bia.screenVolume]).toEqual([0, 1]);
    h.settings.value = withLocalMute(h.settings.value, 's1', BIA, false);
    h.session.applyVolumes();
    expect(bia.volume).toBe(1.5);
  });

  it('unmuting while deafened also undeafens (Discord-like)', async () => {
    await h.session.join('VC1');
    await h.session.setDeafened(true);
    await h.session.setMuted(false);
    expect([h.state().selfMuted, h.state().selfDeafened]).toEqual([false, false]);
  });

  it('muted before joining: the microphone is never opened until unmute', async () => {
    h.dispatch({ type: 'self', muted: true });
    await h.session.join('VC1');
    expect(h.microphones).toEqual([]);
    expect(room().localParticipant.published).toEqual([]);
    expect(h.requests).toContainEqual(['voice.selfState', { muted: true, deafened: false }]);
    await h.session.setMuted(false);
    expect(room().localParticipant.published).toHaveLength(1);
  });
});

describe('moderation from the server (spec §8.3)', () => {
  it('a server mute keeps the microphone off until LiveKit gives it back', async () => {
    await h.session.join('VC1');
    const local = room().localParticipant;
    h.dispatch({ type: 'serverEvent', event: { t: 'voice.state', d: { channelId: 'VC1', participants: [participant(ME, { serverMuted: true })] } } });
    local.permissions = { canPublish: false, canPublishSources: [] };
    room().emit(RoomEvent.ParticipantPermissionsChanged, undefined, local);
    await h.session.handleServerEvent({ t: 'voice.state', d: {} });
    expect(local.micCalls.at(-1)).toEqual({ enabled: false });
    // LiveKit takes the track off the air; the user's unmute changes nothing.
    local.serverUnpublish();
    await h.session.setMuted(false);
    expect(local.published).toHaveLength(1);

    h.dispatch({ type: 'serverEvent', event: { t: 'voice.state', d: { channelId: 'VC1', participants: [participant(ME)] } } });
    local.permissions = { canPublish: true, canPublishSources: [MIC] };
    room().emit(RoomEvent.ParticipantPermissionsChanged, undefined, local);
    await h.session.handleServerEvent({ t: 'voice.state', d: {} });
    expect(local.published).toHaveLength(2);
    expect(h.microphones).toHaveLength(2);
  });

  it('a server deafen plays everyone silent; after it, the app subscribes again once LiveKit allows it', async () => {
    await h.session.join('VC1');
    const local = room().localParticipant;
    const bia = room().addRemote(BIA, 'Bia', [Track.Source.Microphone]);
    const mic = [...bia.trackPublications.values()][0]!;
    h.dispatch({ type: 'serverEvent', event: { t: 'voice.state', d: { channelId: 'VC1', participants: [participant(ME, { serverDeafened: true }), participant(BIA)] } } });
    await h.session.handleServerEvent({ t: 'voice.state', d: {} });
    expect(bia.volume).toBe(0);
    // LiveKit ended the subscription (canSubscribe false).
    mic.subscribed = false;
    local.permissions = { canSubscribe: false, canPublish: true, canPublishSources: [MIC] };
    room().emit(RoomEvent.ParticipantPermissionsChanged, { canSubscribe: true }, local);
    expect(mic.subscribed).toBe(false);

    h.dispatch({ type: 'serverEvent', event: { t: 'voice.state', d: { channelId: 'VC1', participants: [participant(ME), participant(BIA)] } } });
    await h.session.handleServerEvent({ t: 'voice.state', d: {} });
    expect(bia.volume).toBe(1);
    local.permissions = { canSubscribe: true, canPublish: true, canPublishSources: [MIC] };
    room().emit(RoomEvent.ParticipantPermissionsChanged, { canSubscribe: false }, local);
    expect(mic.subscribed).toBe(true);
  });

  it('voice.forceMove joins the new channel by itself', async () => {
    await h.session.join('VC1');
    const first = room();
    await h.session.handleServerEvent({ t: 'voice.forceMove', d: { toChannelId: 'VC2' } });
    expect(first.disconnects).toBe(1);
    expect(h.requests.filter(([t]) => t === 'voice.join').map(([, p]) => p)).toEqual([{ channelId: 'VC1' }, { channelId: 'VC2' }]);
    expect(h.state().call).toEqual({ status: 'connected', channelId: 'VC2' });
  });

  it('voice.forceDisconnect ends the call and says why', async () => {
    await h.session.join('VC1');
    await h.session.handleServerEvent({ t: 'voice.forceDisconnect', d: {} });
    expect(room().disconnects).toBe(1);
    expect(h.state().call.status).toBe('idle');
    expect(h.state().notice).toEqual({ kind: 'forceDisconnect' });
    expect(h.requests.map(([t]) => t)).not.toContain('voice.leave');
  });

  it('ignores malformed moderation events', async () => {
    await h.session.join('VC1');
    await h.session.handleServerEvent({ t: 'voice.forceMove', d: { toChannelId: '../../x' } });
    expect(h.rooms).toHaveLength(1);
    expect(h.state().call.channelId).toBe('VC1');
  });
});

describe('leaving', () => {
  it('leave disconnects LiveKit and tells the server', async () => {
    await h.session.join('VC1');
    await h.session.leave();
    expect(room().disconnects).toBe(1);
    expect(h.requests.at(-1)).toEqual(['voice.leave', {}]);
    expect(h.state().call.status).toBe('idle');
  });

  it('LiveKit dropping the call (e.g. removed by the server) ends it with a notice', async () => {
    await h.session.join('VC1');
    room().emit(RoomEvent.Disconnected);
    await flush();
    expect(h.state().call.status).toBe('idle');
    expect(h.state().notice).toEqual({ kind: 'dropped' });
  });

  it('losing the GhostLink connection ends the call locally; reconnecting keeps it (spec §8.4)', async () => {
    await h.session.join('VC1');
    await h.session.handleConnection('reconnecting');
    expect(h.state().call.status).toBe('connected');
    await h.session.handleConnection('failed');
    expect(room().disconnects).toBe(1);
    expect(h.state().call.status).toBe('idle');
    expect(h.requests.map(([t]) => t)).not.toContain('voice.leave');
  });

  it('LiveKit reconnecting shows as reconnecting', async () => {
    await h.session.join('VC1');
    room().emit(RoomEvent.Reconnecting);
    expect(h.state().call.status).toBe('reconnecting');
    room().emit(RoomEvent.Reconnected);
    expect(h.state().call.status).toBe('connected');
  });
});

describe('canPublishMicrophone', () => {
  it('reads LiveKit permissions: never an empty list with canPublish (spec §6), microphone must be listed', () => {
    expect(canPublishMicrophone({ canPublish: true, canPublishSources: [TrackSource.MICROPHONE, TrackSource.CAMERA] })).toBe(true);
    expect(canPublishMicrophone({ canPublish: true, canPublishSources: [TrackSource.CAMERA] })).toBe(false);
    expect(canPublishMicrophone({ canPublish: false, canPublishSources: [] })).toBe(false);
    expect(canPublishMicrophone(undefined)).toBe(false);
  });
});
