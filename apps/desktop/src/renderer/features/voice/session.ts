// One voice call at a time over livekit-client (spec §8.2, §8.4). Everything the
// browser provides (audio elements, gestures, WebAudio) comes in through deps, so the
// call logic is tested with a fake Room.
import {
  RoomEvent,
  Track,
  type AudioCaptureOptions,
  type LocalAudioTrack,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type Room,
  type RoomOptions,
  type TrackPublication,
} from 'livekit-client';
import { userIdFromIdentity, voiceForceMoveSchemaClient, voiceJoinResponseSchemaClient, type Envelope } from '@ghostlink/shared';
import type { ConnState } from '../../../shared/ipcTypes.js';
import { errorCodeOf } from '../../i18n/index.js';
import { volumeOf, type VoiceSettings } from './settings.js';
import { selfVoice, type VoiceAction, type VoiceState } from './state.js';

/** LiveKit protocol TrackSource.MICROPHONE (livekit-server-sdk's enum; the tests check the value). */
const PROTO_MICROPHONE = 2;

/** Where remote audio plays: hidden media elements owned by the page. */
export interface AudioOutlet {
  attach(track: RemoteTrack, userId: string): void;
  detach(track: RemoteTrack): void;
  detachAll(): void;
}

export interface VoiceSessionDeps {
  /** A request to the connected GhostLink server (server.request IPC); rejects with Error(code). */
  request<T>(type: string, payload?: unknown): Promise<T>;
  createRoom(options: RoomOptions): Room;
  dispatch(action: VoiceAction): void;
  getState(): VoiceState;
  settings(): VoiceSettings;
  outlet: AudioOutlet;
  /**
   * A new microphone track, already behind the voice-activity / push-to-talk gate, so
   * nothing ungated is ever sent (LiveKit's own capture would publish before a gate).
   */
  createMicrophone(options: AudioCaptureOptions): Promise<LocalAudioTrack>;
  /** Runs `cb` once, on the user's next click or key press (autoplay recovery). */
  onUserGesture(cb: () => void): void;
  pingIntervalMs?: number;
}

/** Whether LiveKit lets this participant publish a microphone (same rule as livekit-client). */
export function canPublishMicrophone(permissions: { canPublish: boolean; canPublishSources: readonly number[] } | undefined): boolean {
  if (!permissions?.canPublish) return false;
  return permissions.canPublishSources.length === 0 || permissions.canPublishSources.includes(PROTO_MICROPHONE);
}

const CAPTURE: AudioCaptureOptions = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceIsolation: false };

function userIdOf(p: Pick<Participant, 'identity'>): string | null {
  return userIdFromIdentity(p.identity);
}

/**
 * The call: voice.join → LiveKit with autoSubscribe off and our ICE servers only,
 * manual microphone subscriptions, attach(), per-user volume, self mute and deafen
 * (the real mute is the local microphone), and the server's moderation events.
 */
export class VoiceSession {
  readonly #deps: VoiceSessionDeps;
  #room: Room | null = null;
  #attempt = 0;
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #mic: Promise<void> = Promise.resolve();

  constructor(deps: VoiceSessionDeps) {
    this.#deps = deps;
  }

  /** Joins `channelId`, leaving any other channel first. Joining the current channel again does nothing. */
  async join(channelId: string, opts: { force?: boolean } = {}): Promise<void> {
    const { call } = this.#deps.getState();
    if (!opts.force && call.channelId === channelId && call.status !== 'idle') return;
    const attempt = ++this.#attempt;
    await this.#teardown();
    this.#deps.dispatch({ type: 'call', status: 'connecting', channelId });
    this.#deps.dispatch({ type: 'notice', notice: null });

    let joined;
    try {
      joined = voiceJoinResponseSchemaClient.parse(await this.#deps.request('voice.join', { channelId }));
    } catch (e) {
      if (attempt !== this.#attempt) return;
      this.#deps.dispatch({ type: 'call', status: 'idle', channelId: null });
      this.#deps.dispatch({ type: 'notice', notice: { kind: 'error', code: errorCodeOf(e) } });
      return;
    }
    if (attempt !== this.#attempt) return;

    const settings = this.#deps.settings();
    const room = this.#deps.createRoom({
      adaptiveStream: true,
      dynacast: true,
      webAudioMix: true,
      audioCaptureDefaults: { ...CAPTURE, ...(settings.inputDeviceId ? { deviceId: settings.inputDeviceId } : {}) },
      ...(settings.outputDeviceId ? { audioOutput: { deviceId: settings.outputDeviceId } } : {}),
    });
    this.#room = room;
    this.#wire(room);
    try {
      // autoSubscribe off: microphones are subscribed by hand (spec §8.4); iceServers from
      // voice.join replace the list LiveKit sends, so no third-party STUN is used (spec §4).
      await room.connect(joined.livekitUrl, joined.token, { autoSubscribe: false, rtcConfig: { iceServers: joined.iceServers } });
    } catch {
      if (attempt !== this.#attempt) return;
      await this.#teardown();
      this.#deps.dispatch({ type: 'notice', notice: { kind: 'dropped' } });
      void this.#deps.request('voice.leave', {}).catch(() => {});
      return;
    }
    if (attempt !== this.#attempt || this.#room !== room) {
      void room.disconnect();
      return;
    }
    this.#deps.dispatch({ type: 'call', status: 'connected', channelId });
    this.#noteNames(room.remoteParticipants.values());
    // TrackPublished does not fire for tracks that existed before we joined (spec §8.4).
    for (const p of room.remoteParticipants.values()) for (const pub of p.trackPublications.values()) this.#maybeSubscribe(pub);
    this.#checkPlayback(room);
    this.#startPing(room);
    this.#sendSelfState();
    await this.#applyMic();
  }

  /** Leaves the call and tells the server. */
  async leave(): Promise<void> {
    const wasInCall = this.#room !== null || this.#deps.getState().call.status !== 'idle';
    this.#attempt++;
    await this.#teardown();
    if (wasInCall) await this.#deps.request('voice.leave', {}).catch(() => {});
  }

  async setMuted(muted: boolean): Promise<void> {
    const { selfDeafened } = this.#deps.getState();
    // Unmuting while deafened undeafens too (Discord-like).
    this.#deps.dispatch({ type: 'self', muted, deafened: muted ? selfDeafened : false });
    if (!muted && selfDeafened) this.applyVolumes();
    this.#sendSelfState();
    await this.#applyMic();
  }

  async setDeafened(deafened: boolean): Promise<void> {
    this.#deps.dispatch({ type: 'self', deafened });
    this.applyVolumes();
    this.#sendSelfState();
    await this.#applyMic();
  }

  /** Re-applies every remote participant's volume (after a volume or deafen change). */
  applyVolumes(): void {
    const room = this.#room;
    if (!room) return;
    for (const p of room.remoteParticipants.values()) this.#applyVolume(p);
  }

  async switchDevice(kind: 'audioinput' | 'audiooutput', deviceId: string): Promise<void> {
    await this.#room?.switchActiveDevice(kind, deviceId).catch(() => false);
  }

  /** voice.forceMove, voice.forceDisconnect, and voice.state that may change my server mute. */
  async handleServerEvent(event: Envelope): Promise<void> {
    if (event.t === 'voice.forceMove') {
      const move = voiceForceMoveSchemaClient.safeParse(event.d);
      if (move.success) await this.join(move.data.toChannelId, { force: true });
      return;
    }
    if (event.t === 'voice.forceDisconnect') {
      if (this.#deps.getState().call.status === 'idle') return;
      this.#attempt++;
      await this.#teardown();
      this.#deps.dispatch({ type: 'notice', notice: { kind: 'forceDisconnect' } });
      return;
    }
    if (event.t === 'voice.state' && this.#room) await this.#applyMic();
  }

  /** The GhostLink connection changed: within the grace the call goes on (spec §8.4). */
  async handleConnection(state: ConnState): Promise<void> {
    if (state !== 'idle' && state !== 'failed') return;
    this.#attempt++;
    await this.#teardown();
  }

  async dispose(): Promise<void> {
    this.#attempt++;
    await this.#teardown();
  }

  // ---- internals ----

  #wire(room: Room): void {
    const mine = () => this.#room === room;
    room
      .on(RoomEvent.TrackPublished, (pub: RemoteTrackPublication) => {
        if (mine()) this.#maybeSubscribe(pub);
      })
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
        const userId = userIdOf(participant);
        if (!mine() || !userId || track.kind !== Track.Kind.Audio || pub.source !== Track.Source.Microphone) return;
        this.#deps.outlet.attach(track, userId);
        this.#applyVolume(participant);
        this.#deps.dispatch({ type: 'subscribed', userId, subscribed: true });
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (!mine() || track.kind !== Track.Kind.Audio) return;
        this.#deps.outlet.detach(track);
        const userId = userIdOf(participant);
        if (userId && pub.source === Track.Source.Microphone) this.#deps.dispatch({ type: 'subscribed', userId, subscribed: false });
      })
      .on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
        if (mine()) this.#noteNames([participant]);
      })
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        if (!mine()) return;
        this.#deps.dispatch({ type: 'speaking', userIds: speakers.map(userIdOf).filter((u): u is string => u !== null) });
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => {
        if (mine()) this.#checkPlayback(room);
      })
      .on(RoomEvent.ParticipantPermissionsChanged, (_previous: unknown, participant: Participant) => {
        // A server mute or unmute arrives as new LiveKit permissions (spec §8.3).
        if (mine() && participant === (room.localParticipant as Participant)) void this.#applyMic();
      })
      .on(RoomEvent.MediaDevicesError, () => {
        if (mine()) this.#deps.dispatch({ type: 'notice', notice: { kind: 'micUnavailable' } });
      })
      .on(RoomEvent.Reconnecting, () => {
        if (mine()) this.#deps.dispatch({ type: 'call', status: 'reconnecting', channelId: this.#deps.getState().call.channelId });
      })
      .on(RoomEvent.Reconnected, () => {
        if (mine()) this.#deps.dispatch({ type: 'call', status: 'connected', channelId: this.#deps.getState().call.channelId });
      })
      .on(RoomEvent.Disconnected, () => {
        // Not ours to end (we clear #room first): LiveKit or the server dropped the call.
        if (!mine() || this.#deps.getState().call.status === 'connecting') return;
        this.#attempt++;
        void this.#teardown().then(() => this.#deps.dispatch({ type: 'notice', notice: { kind: 'dropped' } }));
      });
  }

  #maybeSubscribe(pub: TrackPublication): void {
    // Microphones only: camera and screen are v0.2 (screen is subscribed on "Watch" there).
    if (pub.source === Track.Source.Microphone && pub.kind === Track.Kind.Audio) (pub as RemoteTrackPublication).setSubscribed(true);
  }

  #applyVolume(participant: RemoteParticipant): void {
    const userId = userIdOf(participant);
    if (!userId) return;
    const state = this.#deps.getState();
    const percent = state.selfDeafened ? 0 : volumeOf(this.#deps.settings(), state.serverId, userId);
    participant.setVolume(percent / 100);
  }

  #noteNames(participants: Iterable<RemoteParticipant>): void {
    const names: Record<string, string> = {};
    for (const p of participants) {
      const userId = userIdOf(p);
      if (userId && p.name) names[userId] = p.name.slice(0, 64);
    }
    if (Object.keys(names).length > 0) this.#deps.dispatch({ type: 'names', names });
  }

  #checkPlayback(room: Room): void {
    if (room.canPlaybackAudio) return;
    this.#deps.onUserGesture(() => {
      if (this.#room === room) void room.startAudio().catch(() => {});
    });
  }

  #startPing(room: Room): void {
    this.#stopPing();
    this.#pingTimer = setInterval(() => {
      if (this.#room !== room) return;
      const rtt = room.engine?.client?.rtt ?? 0;
      this.#deps.dispatch({ type: 'ping', ms: rtt > 0 ? Math.round(rtt) : null });
    }, this.#deps.pingIntervalMs ?? 2_000);
  }

  #stopPing(): void {
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    this.#pingTimer = null;
  }

  #sendSelfState(): void {
    const { call, selfMuted, selfDeafened } = this.#deps.getState();
    if (call.status === 'idle' || !this.#room) return;
    void this.#deps.request('voice.selfState', { muted: selfMuted || selfDeafened, deafened: selfDeafened }).catch(() => {});
  }

  /** Publishes or mutes the microphone to match mute, deafen and the server's permissions. Serialized. */
  #applyMic(): Promise<void> {
    this.#mic = this.#mic.then(() => this.#applyMicNow()).catch(() => {});
    return this.#mic;
  }

  async #applyMicNow(): Promise<void> {
    const room = this.#room;
    if (!room || this.#deps.getState().call.status === 'idle') return;
    const state = this.#deps.getState();
    const local = room.localParticipant;
    const want = canPublishMicrophone(local.permissions) && !selfVoice(state)?.serverMuted && !state.selfMuted && !state.selfDeafened;
    const pub = local.getTrackPublication(Track.Source.Microphone);
    if (!want) {
      if (pub && !pub.isMuted) await local.setMicrophoneEnabled(false).catch(() => {});
      return;
    }
    if (pub?.track) {
      if (pub.isMuted) await local.setMicrophoneEnabled(true).catch(() => {});
      return;
    }
    let track: LocalAudioTrack;
    try {
      track = await this.#deps.createMicrophone({ ...CAPTURE, ...this.#deviceConstraint() });
    } catch {
      if (this.#room === room) this.#deps.dispatch({ type: 'notice', notice: { kind: 'micUnavailable' } });
      return;
    }
    if (this.#room !== room) {
      track.stop();
      return;
    }
    try {
      await local.publishTrack(track, { source: Track.Source.Microphone });
    } catch {
      track.stop();
      if (this.#room === room) this.#deps.dispatch({ type: 'notice', notice: { kind: 'micUnavailable' } });
      return;
    }
    // Muted or deafened while the device was opening: keep it published but silent.
    const now = this.#deps.getState();
    if (now.selfMuted || now.selfDeafened) await local.setMicrophoneEnabled(false).catch(() => {});
  }

  #deviceConstraint(): Pick<AudioCaptureOptions, 'deviceId'> {
    const { inputDeviceId } = this.#deps.settings();
    return inputDeviceId ? { deviceId: inputDeviceId } : {};
  }

  async #teardown(): Promise<void> {
    const room = this.#room;
    this.#room = null;
    this.#stopPing();
    if (room) {
      room.removeAllListeners();
      this.#deps.outlet.detachAll();
      await room.disconnect().catch(() => {});
    }
    if (this.#deps.getState().call.status !== 'idle') this.#deps.dispatch({ type: 'call', status: 'idle', channelId: null });
  }
}
