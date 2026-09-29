import { EventEmitter } from 'node:events';
import { RoomEvent, Track, type LocalAudioTrack, type Room, type RoomOptions } from 'livekit-client';
import { TrackSource } from 'livekit-server-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceParticipant } from '@ghostlink/shared';
import { VoiceSession, canPublishMicrophone, type AudioOutlet } from '../../src/renderer/features/voice/session.js';
import { defaultVoiceSettings, withVolume, type VoiceSettings } from '../../src/renderer/features/voice/settings.js';
import { initialVoiceState, voiceReducer, type VoiceAction, type VoiceState } from '../../src/renderer/features/voice/state.js';

const ME = 'a'.repeat(32);
const BIA = 'b'.repeat(32);
const CAIO = 'c'.repeat(32);
const MIC = TrackSource.MICROPHONE;

class FakePub {
  subscribed: boolean | null = null;
  isMuted = false;
  track: unknown = null;
  constructor(
    readonly source: Track.Source,
    readonly kind: Track.Kind = source === Track.Source.Microphone ? Track.Kind.Audio : Track.Kind.Video,
  ) {}
  setSubscribed(v: boolean): void {
    this.subscribed = v;
  }
}

class FakeRemote {
  readonly trackPublications = new Map<string, FakePub>();
  volume: number | null = null;
  constructor(
    readonly identity: string,
    readonly name: string,
  ) {}
  setVolume(v: number): void {
    this.volume = v;
  }
}

class FakeTrack {
  stopped = false;
  constructor(readonly options: Record<string, unknown>) {}
  stop(): void {
    this.stopped = true;
  }
}

class FakeLocal {
  identity = `u_${ME}`;
  permissions: { canPublish: boolean; canPublishSources: number[] } | undefined = { canPublish: true, canPublishSources: [MIC] };
  mic: FakePub | null = null;
  readonly published: Array<{ track: FakeTrack; options: unknown }> = [];
  readonly micCalls: Array<{ enabled: boolean }> = [];
  async publishTrack(track: FakeTrack, options: unknown): Promise<void> {
    this.published.push({ track, options });
    this.mic = new FakePub(Track.Source.Microphone);
    this.mic.track = track;
  }
  /** Mute and unmute of the existing publication (without one, LiveKit would capture an ungated track). */
  async setMicrophoneEnabled(enabled: boolean): Promise<void> {
    this.micCalls.push({ enabled });
    if (!this.mic) throw new Error('the session must publish its own gated track first');
    this.mic.isMuted = !enabled;
  }
  /** What LiveKit does when the server takes the microphone away. */
  serverUnpublish(): void {
    this.mic = null;
  }
  getTrackPublication(source: Track.Source): FakePub | undefined {
    return source === Track.Source.Microphone ? (this.mic ?? undefined) : undefined;
  }
}

class FakeRoom extends EventEmitter {
  readonly localParticipant = new FakeLocal();
  readonly remoteParticipants = new Map<string, FakeRemote>();
  readonly engine = { client: { rtt: 0 } };
  canPlaybackAudio = true;
  connected: { url: string; token: string; opts: unknown } | null = null;
  disconnects = 0;
  startAudioCalls = 0;
  switched: Array<[string, string]> = [];
  failConnect = false;
  constructor(readonly options: RoomOptions) {
    super();
  }
  async connect(url: string, token: string, opts: unknown): Promise<void> {
    if (this.failConnect) throw new Error('could not establish signal connection');
    this.connected = { url, token, opts };
  }
  async disconnect(): Promise<void> {
    this.disconnects++;
  }
  async startAudio(): Promise<void> {
    this.startAudioCalls++;
    this.canPlaybackAudio = true;
  }
  async switchActiveDevice(kind: string, deviceId: string): Promise<boolean> {
    this.switched.push([kind, deviceId]);
    return true;
  }
  addRemote(userId: string, name: string, sources: Track.Source[] = []): FakeRemote {
    const p = new FakeRemote(`u_${userId}`, name);
    sources.forEach((s, i) => p.trackPublications.set(`TR_${userId}_${i}`, new FakePub(s)));
    this.remoteParticipants.set(p.identity, p);
    return p;
  }
}

const participant = (userId: string, extra: Partial<VoiceParticipant> = {}): VoiceParticipant => ({
  userId,
  muted: false,
  deafened: false,
  camera: false,
  screen: false,
  serverMuted: false,
  ...extra,
});

interface Harness {
  session: VoiceSession;
  rooms: FakeRoom[];
  requests: Array<[string, unknown]>;
  state(): VoiceState;
  dispatch(a: VoiceAction): void;
  settings: { value: VoiceSettings };
  attached: unknown[];
  gestures: Array<() => void>;
  respond: Map<string, (payload: unknown) => unknown>;
  microphones: FakeTrack[];
  failMicrophone: { next: boolean };
}

let h: Harness;

function harness(): Harness {
  let state: VoiceState = voiceReducer(initialVoiceState, {
    type: 'welcome',
    welcome: { serverId: 's1', self: { userId: ME, nickname: 'Ana', isOwner: false }, voice: [] },
  });
  const rooms: FakeRoom[] = [];
  const requests: Array<[string, unknown]> = [];
  const attached: unknown[] = [];
  const gestures: Array<() => void> = [];
  const settings = { value: defaultVoiceSettings };
  const microphones: FakeTrack[] = [];
  const failMicrophone = { next: false };
  const respond = new Map<string, (payload: unknown) => unknown>([
    ['voice.join', (p) => ({ livekitUrl: 'wss://127.0.0.1:7700', token: `token-${(p as { channelId: string }).channelId}`, iceServers: [] })],
  ]);
  const outlet: AudioOutlet = {
    attach: (track, userId) => void attached.push({ track, userId }),
    detach: (track) => {
      const i = attached.findIndex((a) => (a as { track: unknown }).track === track);
      if (i >= 0) attached.splice(i, 1);
    },
    detachAll: () => void attached.splice(0),
  };
  const dispatch = (a: VoiceAction) => {
    state = voiceReducer(state, a);
  };
  const session = new VoiceSession({
    request: async <T,>(type: string, payload?: unknown): Promise<T> => {
      requests.push([type, payload]);
      const r = respond.get(type);
      return (r ? await r(payload) : {}) as T;
    },
    createRoom: (options) => {
      const room = new FakeRoom(options);
      rooms.push(room);
      return room as unknown as Room;
    },
    dispatch,
    getState: () => state,
    settings: () => settings.value,
    outlet,
    createMicrophone: async (options) => {
      if (failMicrophone.next) {
        failMicrophone.next = false;
        throw new Error('NotAllowedError');
      }
      const track = new FakeTrack(options as Record<string, unknown>);
      microphones.push(track);
      return track as unknown as LocalAudioTrack;
    },
    onUserGesture: (cb) => void gestures.push(cb),
    pingIntervalMs: 1_000,
  });
  return { session, rooms, requests, state: () => state, dispatch, settings, attached, gestures, respond, microphones, failMicrophone };
}

const room = () => h.rooms.at(-1)!;
const flush = () => new Promise((r) => setTimeout(r, 0));

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
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceIsolation: false },
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
      { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceIsolation: false, deviceId: 'mic-2' },
    ]);
    expect(room().localParticipant.published).toEqual([{ track: h.microphones[0], options: { source: Track.Source.Microphone } }]);
    expect(room().localParticipant.micCalls).toEqual([]);
    expect(h.requests).toContainEqual(['voice.selfState', { muted: false, deafened: false }]);
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

  it('a LiveKit connection failure leaves the call and releases the server assignment', async () => {
    h.respond.set('voice.join', (p) => ({ livekitUrl: 'wss://x:1', token: `t-${(p as { channelId: string }).channelId}`, iceServers: [] }));
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
        const value = { livekitUrl: 'wss://x:1', token: `t-${channelId}`, iceServers: [] };
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
  it('subscribes to microphones already there and to new ones, never to camera or screen', async () => {
    h.respond.set('voice.join', () => {
      // Someone is already in the room when we connect.
      return { livekitUrl: 'wss://x:1', token: 't', iceServers: [] };
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
      [Track.Source.Camera, null],
      [Track.Source.ScreenShare, null],
    ]);
    expect(h.state().names[BIA]).toBe('Bia');

    const caio = room().addRemote(CAIO, 'Caio');
    const mic = new FakePub(Track.Source.Microphone);
    const cam = new FakePub(Track.Source.Camera);
    room().emit(RoomEvent.TrackPublished, mic, caio);
    room().emit(RoomEvent.TrackPublished, cam, caio);
    expect(mic.subscribed).toBe(true);
    expect(cam.subscribed).toBeNull();
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
      request: async <T,>(type: string): Promise<T> => (type === 'voice.join' ? { livekitUrl: 'wss://x:1', token: 't', iceServers: [] } : {}) as T,
      createRoom: (options) => {
        const r = new FakeRoom(options);
        h.rooms.push(r);
        return r as unknown as Room;
      },
      dispatch: h.dispatch,
      getState: h.state,
      settings: () => defaultVoiceSettings,
      outlet: { attach: () => {}, detach: () => {}, detachAll: () => {} },
      createMicrophone: async (options) => {
        await slow;
        const track = new FakeTrack(options as Record<string, unknown>);
        h.microphones.push(track);
        return track as unknown as LocalAudioTrack;
      },
      onUserGesture: () => {},
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
