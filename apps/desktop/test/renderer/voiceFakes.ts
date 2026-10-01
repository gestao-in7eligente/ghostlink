// A fake LiveKit room and the VoiceSession deps around it, shared by the voice session tests.
import { EventEmitter } from 'node:events';
import { RoomEvent, Track, type LocalAudioTrack, type LocalTrack, type Room, type RoomOptions } from 'livekit-client';
import { TrackSource } from 'livekit-server-sdk';
import type { VoiceParticipant } from '@ghostlink/shared';
import type { ScreenChoice, ScreenSource } from '../../src/shared/screenTypes.js';
import type { ScreenSelection } from '../../src/renderer/features/voice/screenShare.js';
import { VoiceSession, type AudioOutlet, type VideoOutlet } from '../../src/renderer/features/voice/session.js';
import { defaultVoiceSettings, type VoiceSettings } from '../../src/renderer/features/voice/settings.js';
import { initialVoiceState, voiceReducer, type VoiceAction, type VoiceState } from '../../src/renderer/features/voice/state.js';

export const ME = 'a'.repeat(32);
export const BIA = 'b'.repeat(32);
export const CAIO = 'c'.repeat(32);
export const MIC = TrackSource.MICROPHONE;
export const CAMERA = TrackSource.CAMERA;

const kindOf = (source: Track.Source) => (source === Track.Source.Microphone || source === Track.Source.ScreenShareAudio ? Track.Kind.Audio : Track.Kind.Video);

export class FakePub {
  subscribed: boolean | null = null;
  isMuted = false;
  track: unknown = null;
  constructor(
    readonly source: Track.Source,
    readonly kind: Track.Kind = kindOf(source),
  ) {}
  setSubscribed(v: boolean): void {
    this.subscribed = v;
  }
}

export class FakeRemote {
  readonly trackPublications = new Map<string, FakePub>();
  /** Microphone volume. */
  volume: number | null = null;
  /** Stream sound volume (setVolume with ScreenShareAudio). */
  screenVolume: number | null = null;
  constructor(
    readonly identity: string,
    readonly name: string,
  ) {}
  setVolume(v: number, source: Track.Source = Track.Source.Microphone): void {
    if (source === Track.Source.ScreenShareAudio) this.screenVolume = v;
    else this.volume = v;
  }
}

export class FakeTrack {
  stopped = false;
  constructor(readonly options: Record<string, unknown>) {}
  stop(): void {
    this.stopped = true;
  }
}

/** A captured screen or its sound: ends by itself like a closed window (end()). */
export class FakeScreenTrack extends EventEmitter {
  stopped = false;
  readonly mediaStreamTrack: { getSettings(): { deviceId: string } };
  constructor(
    readonly kind: Track.Kind,
    readonly source: Track.Source,
    deviceId = '',
  ) {
    super();
    this.mediaStreamTrack = { getSettings: () => ({ deviceId }) };
  }
  stop(): void {
    this.stopped = true;
  }
  /** The capture ended by itself (LocalTrack emits TrackEvent.Ended). */
  end(): void {
    this.emit('ended', this);
  }
}

export class FakeLocal {
  identity = `u_${ME}`;
  permissions: { canPublish: boolean; canPublishSources: number[] } | undefined = { canPublish: true, canPublishSources: [MIC] };
  mic: FakePub | null = null;
  readonly screenPubs = new Map<Track.Source, FakePub>();
  readonly published: Array<{ track: FakeTrack | FakeScreenTrack; options: unknown }> = [];
  readonly unpublished: unknown[] = [];
  readonly micCalls: Array<{ enabled: boolean }> = [];
  /** What the next screen capture yields: the sound's deviceId (null: none), or an error. */
  screenCapture: { audioDeviceId: string | null } | Error = { audioDeviceId: 'loopbackWithoutChrome' };
  readonly captures: unknown[] = [];
  readonly screenTracks: FakeScreenTrack[] = [];
  /** setCameraEnabled(true, capture, publish) calls, the cameras it opened, and what the next open does. */
  readonly cameraCalls: Array<{ capture: unknown; publish: unknown }> = [];
  readonly cameraTracks: FakeScreenTrack[] = [];
  cameraOpen: { fail: Error | null; wait: Promise<void> | null } = { fail: null, wait: null };
  async publishTrack(track: FakeTrack | FakeScreenTrack, options: { source?: Track.Source }): Promise<void> {
    this.published.push({ track, options });
    const pub = new FakePub(options.source ?? Track.Source.Microphone);
    pub.track = track;
    if (pub.source === Track.Source.Microphone) this.mic = pub;
    else this.screenPubs.set(pub.source, pub);
  }
  async unpublishTrack(track: unknown, stopOnUnpublish?: boolean): Promise<void> {
    this.unpublished.push(track);
    for (const [source, pub] of this.screenPubs) if (pub.track === track) this.screenPubs.delete(source);
    if (stopOnUnpublish) (track as { stop(): void }).stop();
  }
  /** LiveKit's camera: opens a track and publishes it (on); off would only mute, so the session never asks for it. */
  async setCameraEnabled(enabled: boolean, capture?: unknown, publish?: { source?: Track.Source }): Promise<FakePub | undefined> {
    if (!enabled) throw new Error('the session unpublishes the camera instead of muting it');
    this.cameraCalls.push({ capture, publish });
    const { fail, wait } = this.cameraOpen;
    if (wait) await wait;
    if (fail) throw fail;
    const track = new FakeScreenTrack(Track.Kind.Video, Track.Source.Camera);
    this.cameraTracks.push(track);
    await this.publishTrack(track, { ...publish, source: Track.Source.Camera });
    return this.screenPubs.get(Track.Source.Camera);
  }
  async createScreenTracks(options: unknown): Promise<LocalTrack[]> {
    this.captures.push(options);
    if (this.screenCapture instanceof Error) throw this.screenCapture;
    const tracks = [new FakeScreenTrack(Track.Kind.Video, Track.Source.ScreenShare)];
    if (this.screenCapture.audioDeviceId !== null) tracks.push(new FakeScreenTrack(Track.Kind.Audio, Track.Source.ScreenShareAudio, this.screenCapture.audioDeviceId));
    this.screenTracks.push(...tracks);
    return tracks as unknown as LocalTrack[];
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
    return source === Track.Source.Microphone ? (this.mic ?? undefined) : this.screenPubs.get(source);
  }
}

export class FakeRoom extends EventEmitter {
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
  /** A publication someone adds while I am in the room (RoomEvent.TrackPublished). */
  publish(p: FakeRemote, source: Track.Source): FakePub {
    const pub = new FakePub(source);
    p.trackPublications.set(`TR_${p.identity}_${p.trackPublications.size}`, pub);
    this.emit(RoomEvent.TrackPublished, pub, p);
    return pub;
  }
}

export const participant = (userId: string, extra: Partial<VoiceParticipant> = {}): VoiceParticipant => ({
  userId,
  muted: false,
  deafened: false,
  camera: false,
  screen: false,
  serverMuted: false,
  ...extra,
});

export const SCREEN_SOURCE: ScreenSource = { id: 'screen:1:0', name: 'Tela 1', kind: 'screen', thumbnail: null, icon: null };

export interface Harness {
  session: VoiceSession;
  rooms: FakeRoom[];
  requests: Array<[string, unknown]>;
  state(): VoiceState;
  dispatch(a: VoiceAction): void;
  settings: { value: VoiceSettings };
  attached: Array<{ track: unknown; userId: string; source?: string }>;
  gestures: Array<() => void>;
  respond: Map<string, (payload: unknown) => unknown>;
  microphones: FakeTrack[];
  failMicrophone: { next: boolean };
  /** The host:port main is connected to (RendererWelcome.address). */
  address: { value: string | null };
  /** What the picker answers next (null: cancel), and how often it opened. */
  picker: { next: ScreenSelection | null | Promise<ScreenSelection | null>; opened: number };
  chosen: ScreenChoice[];
  /** The video outlet: watched screens by user, and my own preview. */
  videos: { remote: Map<string, unknown>; local: unknown; clears: number };
  /** The camera outlet: received cameras by user, and my own. */
  cameras: { remote: Map<string, unknown>; local: unknown; clears: number };
  deps: ConstructorParameters<typeof VoiceSession>[0];
}

export function harness(): Harness {
  let state: VoiceState = voiceReducer(initialVoiceState, {
    type: 'welcome',
    welcome: { serverId: 's1', self: { userId: ME, nickname: 'Ana', isOwner: false }, voice: [] },
  });
  const rooms: FakeRoom[] = [];
  const requests: Array<[string, unknown]> = [];
  const attached: Harness['attached'] = [];
  const gestures: Array<() => void> = [];
  const settings = { value: defaultVoiceSettings };
  const microphones: FakeTrack[] = [];
  const failMicrophone = { next: false };
  const address = { value: '127.0.0.1:7700' as string | null };
  const picker: Harness['picker'] = { next: null, opened: 0 };
  const chosen: ScreenChoice[] = [];
  const videos: Harness['videos'] = { remote: new Map(), local: null, clears: 0 };
  const cameras: Harness['cameras'] = { remote: new Map(), local: null, clears: 0 };
  const respond = new Map<string, (payload: unknown) => unknown>([
    ['voice.join', (p) => ({ livekitUrl: 'wss://127.0.0.1:7700', token: `token-${(p as { channelId: string }).channelId}`, iceServers: [] })],
  ]);
  const outlet: AudioOutlet = {
    attach: (track, userId, source) => void attached.push({ track, userId, ...(source ? { source } : {}) }),
    detach: (track) => {
      const i = attached.findIndex((a) => a.track === track);
      if (i >= 0) attached.splice(i, 1);
    },
    detachAll: () => void attached.splice(0),
  };
  const outletInto = (into: Harness['videos']): VideoOutlet => ({
    remote: (userId, track) => {
      if (track) into.remote.set(userId, track);
      else into.remote.delete(userId);
    },
    local: (track) => {
      into.local = track;
    },
    clear: () => {
      into.remote.clear();
      into.local = null;
      into.clears++;
    },
  });
  const video = outletInto(videos);
  const dispatch = (a: VoiceAction) => {
    state = voiceReducer(state, a);
  };
  const deps: Harness['deps'] = {
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
    video,
    cameras: outletInto(cameras),
    screen: {
      sources: async () => [SCREEN_SOURCE],
      choose: async (choice) => void chosen.push(choice),
      pick: async (sources) => {
        picker.opened++;
        await sources;
        return picker.next;
      },
    },
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
    connectedAddress: () => address.value,
    pingIntervalMs: 1_000,
  };
  const session = new VoiceSession(deps);
  return { session, rooms, requests, state: () => state, dispatch, settings, attached, gestures, respond, microphones, failMicrophone, address, picker, chosen, videos, cameras, deps };
}

export const flush = () => new Promise((r) => setTimeout(r, 0));
