// One voice call at a time over livekit-client (spec §8.2, §8.4). Everything the
// browser provides (audio elements, gestures, WebAudio) comes in through deps, so the
// call logic is tested with a fake Room.
import {
  RoomEvent,
  Track,
  TrackEvent,
  type AudioCaptureOptions,
  type LocalAudioTrack,
  type LocalTrackPublication,
  type LocalVideoTrack,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type Room,
  type RoomOptions,
  type TrackPublication,
} from 'livekit-client';
import {
  userIdFromIdentity,
  voiceForceMoveSchemaClient,
  voiceJoinEndpointsTrusted,
  voiceJoinResponseSchemaClient,
  type Envelope,
} from '@ghostlink/shared';
import type { ConnState } from '../../../shared/ipcTypes.js';
import { errorCodeOf } from '../../i18n/index.js';
import { cameraCaptureOptions, cameraPublishOptions, canPublishCamera } from './camera.js';
import { startScreenShare, stopScreenShare, wantsSubscription, type LiveScreenShare, type ScreenShareDeps } from './screenShare.js';
import { screenVolumeKey, volumeOf, type VoiceSettings } from './settings.js';
import { selfVoice, type VoiceAction, type VoiceState } from './state.js';

/** LiveKit protocol TrackSource.MICROPHONE (livekit-server-sdk's enum; the tests check the value). */
const PROTO_MICROPHONE = 2;

/** Where remote audio plays: hidden media elements owned by the page. */
export interface AudioOutlet {
  /** `source` tells a stream's sound ('screen') from a voice (the default). */
  attach(track: RemoteTrack, userId: string, source?: 'voice' | 'screen'): void;
  detach(track: RemoteTrack): void;
  detachAll(): void;
}

/** Where screens show: the voice stage attaches them (track.attach, never a hand-made srcObject). */
export interface VideoOutlet {
  /** A watched person's screen arrived (a track) or went away (null). */
  remote(userId: string, track: RemoteTrack | null): void;
  /** My own share's picture, for the self-preview; null when it ends. */
  local(track: LocalVideoTrack | null): void;
  /** The call is over: no screens at all. */
  clear(): void;
}

export interface VoiceSessionDeps {
  /** A request to the connected GhostLink server (server.request IPC); rejects with Error(code). */
  request<T>(type: string, payload?: unknown): Promise<T>;
  createRoom(options: RoomOptions): Room;
  dispatch(action: VoiceAction): void;
  getState(): VoiceState;
  settings(): VoiceSettings;
  outlet: AudioOutlet;
  video: VideoOutlet;
  /** Where cameras show (the same shape as the screens' outlet): everyone's received camera, and my own. */
  cameras: VideoOutlet;
  /** The screen picker and window.ghostlink.screen (spec 2026-10-01 §2, §3). */
  screen: ScreenShareDeps;
  /**
   * A new microphone track, already behind the voice-activity / push-to-talk gate, so
   * nothing ungated is ever sent (LiveKit's own capture would publish before a gate).
   */
  createMicrophone(options: AudioCaptureOptions): Promise<LocalAudioTrack>;
  /** Runs `cb` once, on the user's next click or key press (autoplay recovery). */
  onUserGesture(cb: () => void): void;
  /** The "host:port" main is connected to (RendererWelcome.address), or null when not connected. */
  connectedAddress(): string | null;
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
  /** My live screen share. */
  #share: LiveScreenShare | null = null;
  /** A share between "Transmitir tela" and live (the picker is open, or capturing). */
  #shareStarting = false;
  /** My live camera track. */
  #camera: LocalVideoTrack | null = null;
  /** The camera button's state: on from the click, until turned off, failed or the call ends. */
  #cameraWanted = false;
  /** Camera changes, one at a time (opening a camera takes a while). */
  #cameraOps: Promise<void> = Promise.resolve();

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
    // spec §4, §8.2: LiveKit (and any ICE server) only on the host and port we are connected to.
    const address = this.#deps.connectedAddress();
    if (address === null || !voiceJoinEndpointsTrusted(joined, address)) {
      this.#deps.dispatch({ type: 'call', status: 'idle', channelId: null });
      this.#deps.dispatch({ type: 'notice', notice: { kind: 'error', code: 'VOICE_URL_REJECTED' } });
      void this.#deps.request('voice.leave', {}).catch(() => {});
      return;
    }

    const settings = this.#deps.settings();
    const room = this.#deps.createRoom({
      adaptiveStream: true,
      dynacast: true,
      webAudioMix: true,
      audioCaptureDefaults: { ...CAPTURE, ...(settings.inputDeviceId ? { deviceId: settings.inputDeviceId } : {}) },
      ...(settings.outputDeviceId ? { audioOutput: { deviceId: settings.outputDeviceId } } : {}),
    });
    this.#room = room;
    // A camera change still waiting on the old room must not hold up this one.
    this.#cameraOps = Promise.resolve();
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
    for (const p of room.remoteParticipants.values()) for (const pub of p.trackPublications.values()) this.#maybeSubscribe(pub, p);
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

  /**
   * "Assistir": subscribes that person's screen and its sound (spec §8.4). The watched set
   * lives in the store and is re-applied on every TrackPublished, also after a reconnect.
   */
  watch(userId: string): void {
    const state = this.#deps.getState();
    if (!this.#room || state.call.status === 'idle' || userId === state.selfUserId) return;
    this.#deps.dispatch({ type: 'watch', userId, watching: true });
    for (const [pub, p] of this.#screenPublications(userId)) this.#maybeSubscribe(pub, p);
  }

  /** "Parar de assistir": unsubscribes both; the picture goes away at once. */
  unwatch(userId: string): void {
    this.#deps.dispatch({ type: 'watch', userId, watching: false });
    this.#deps.video.remote(userId, null);
    for (const [pub] of this.#screenPublications(userId)) pub.setSubscribed(false);
  }

  /** "Transmitir tela": the picker, then capture and publish (spec 2026-10-01 §2). One share at a time. */
  async startScreenShare(): Promise<void> {
    const room = this.#room;
    if (!room || this.#deps.getState().call.status !== 'connected' || this.#share || this.#shareStarting) return;
    this.#shareStarting = true;
    let outcome;
    try {
      outcome = await startScreenShare(room.localParticipant, this.#deps.screen, () => this.#room === room);
    } finally {
      this.#shareStarting = false;
    }
    if (this.#room !== room) {
      // The call ended just as the share went live: the room is gone, stop the capture.
      if (outcome.kind === 'live') for (const track of [outcome.share.video, outcome.share.audio]) track?.stop();
      return;
    }
    if (outcome.kind === 'failed') this.#deps.dispatch({ type: 'notice', notice: { kind: 'screenFailed' } });
    if (outcome.kind !== 'live') return;
    const { share } = outcome;
    this.#share = share;
    // The window closed or the screen went away: the share ends with it (spec §2).
    share.video.once(TrackEvent.Ended, () => {
      if (this.#share === share) void this.stopScreenShare();
    });
    this.#deps.video.local(share.video);
    const { quality, content, name } = share.selection;
    this.#deps.dispatch({ type: 'sharing', sharing: { quality, content, name, audio: share.audio !== null } });
    if (outcome.audioDropped) this.#deps.dispatch({ type: 'notice', notice: { kind: 'screenAudio' } });
  }

  /** "Parar transmissão". */
  async stopScreenShare(): Promise<void> {
    const share = this.#share;
    if (!share) return;
    this.#share = null;
    this.#deps.video.local(null);
    this.#deps.dispatch({ type: 'sharing', sharing: null });
    const room = this.#room;
    if (room) await stopScreenShare(room.localParticipant, share);
    else for (const track of [share.video, share.audio]) track?.stop();
  }

  /**
   * The camera button (spec 2026-10-01-camera §3): on publishes my camera with the chosen
   * quality and device, everyone in the call receives it; off takes it back. Only in a
   * connected call, and only with VIDEO (LiveKit lists the camera source for it).
   */
  setCamera(on: boolean): Promise<void> {
    const room = this.#room;
    if (on && (!room || this.#deps.getState().call.status !== 'connected' || !canPublishCamera(room.localParticipant.permissions))) return Promise.resolve();
    if (on !== this.#cameraWanted) {
      this.#cameraWanted = on;
      this.#deps.dispatch({ type: 'camera', on });
    }
    return this.#applyCamera();
  }

  /** Another camera was chosen: switched live while mine is on (null, the system default, reopens it). */
  switchCamera(deviceId: string | null): Promise<void> {
    if (deviceId === null) return this.#applyCamera(true);
    const room = this.#room;
    this.#cameraOps = this.#cameraOps
      .then(async () => {
        if (!room || this.#room !== room || !this.#camera) return;
        const switched = await room.switchActiveDevice('videoinput', deviceId).catch(() => false);
        // That camera is gone: reopen with it as a preference (another one is used instead).
        if (!switched) await this.#applyCameraNow(true);
      })
      .catch(() => {});
    return this.#cameraOps;
  }

  /** Another quality: a live camera is published again with the new preset and layers. */
  restartCamera(): Promise<void> {
    return this.#applyCamera(true);
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
      .on(RoomEvent.TrackPublished, (pub: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (mine()) this.#maybeSubscribe(pub, participant);
      })
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
        const userId = userIdOf(participant);
        if (!mine() || !userId) return;
        if (pub.source === Track.Source.Microphone) {
          if (track.kind !== Track.Kind.Audio) return;
          this.#deps.outlet.attach(track, userId);
          this.#applyVolume(participant);
          this.#deps.dispatch({ type: 'subscribed', userId, subscribed: true });
          return;
        }
        if (pub.source === Track.Source.Camera) {
          if (track.kind === Track.Kind.Video) this.#deps.cameras.remote(userId, track);
          return;
        }
        // A screen that arrives after "Parar de assistir" is on its way out: not shown.
        if (!wantsSubscription(pub.source, track.kind, userId, this.#deps.getState().watching)) return;
        if (track.kind === Track.Kind.Video) {
          this.#deps.video.remote(userId, track);
        } else {
          this.#deps.outlet.attach(track, userId, 'screen');
          this.#applyVolume(participant);
        }
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (!mine()) return;
        const userId = userIdOf(participant);
        if (track.kind === Track.Kind.Video) {
          if (userId && pub.source === Track.Source.ScreenShare) this.#deps.video.remote(userId, null);
          if (userId && pub.source === Track.Source.Camera) this.#deps.cameras.remote(userId, null);
          return;
        }
        this.#deps.outlet.detach(track);
        if (userId && pub.source === Track.Source.Microphone) this.#deps.dispatch({ type: 'subscribed', userId, subscribed: false });
      })
      .on(RoomEvent.TrackUnpublished, (pub: RemoteTrackPublication, participant: RemoteParticipant) => {
        // Stopped sharing while still in the room: no longer watched. Someone who left (or
        // is coming back through a reconnect) was removed from the room first, and stays watched.
        if (!mine() || pub.source !== Track.Source.ScreenShare || room.remoteParticipants.get(participant.identity) !== participant) return;
        const userId = userIdOf(participant);
        if (userId) this.#deps.dispatch({ type: 'watch', userId, watching: false });
      })
      .on(RoomEvent.LocalTrackUnpublished, (pub: LocalTrackPublication) => {
        // LiveKit took my screen off the air (the capture ended, or VIDEO was taken away).
        if (mine() && this.#share && pub.track === this.#share.video) void this.stopScreenShare();
        // The same for my camera (VIDEO taken away): the button goes off.
        if (mine() && this.#camera && pub.track === this.#camera) {
          this.#camera.stop();
          this.#camera = null;
          this.#deps.cameras.local(null);
          this.#cameraWanted = false;
          this.#deps.dispatch({ type: 'camera', on: false });
        }
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
        // A server mute or unmute arrives as new LiveKit permissions (spec §8.3); so does VIDEO.
        if (!mine() || participant !== (room.localParticipant as Participant)) return;
        void this.#applyMic();
        void this.#applyCamera();
      })
      .on(RoomEvent.MediaDevicesError, (_error: unknown, kind?: string) => {
        // A camera failure has its own notice (#applyCameraNow).
        if (mine() && kind !== 'videoinput') this.#deps.dispatch({ type: 'notice', notice: { kind: 'micUnavailable' } });
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

  /** Microphones and cameras always; a screen and its sound while watched (spec §8.4). */
  #maybeSubscribe(pub: TrackPublication, participant: Pick<Participant, 'identity'>): void {
    if (wantsSubscription(pub.source, pub.kind, userIdOf(participant), this.#deps.getState().watching)) (pub as RemoteTrackPublication).setSubscribed(true);
  }

  /** Someone's ScreenShare and ScreenShareAudio publications in my room. */
  #screenPublications(userId: string): Array<[RemoteTrackPublication, RemoteParticipant]> {
    const out: Array<[RemoteTrackPublication, RemoteParticipant]> = [];
    for (const p of this.#room?.remoteParticipants.values() ?? []) {
      if (userIdOf(p) !== userId) continue;
      for (const pub of p.trackPublications.values()) {
        if (pub.source === Track.Source.ScreenShare || pub.source === Track.Source.ScreenShareAudio) out.push([pub, p]);
      }
    }
    return out;
  }

  /** Voice and stream sound, each with its own saved volume; deafen silences both. */
  #applyVolume(participant: RemoteParticipant): void {
    const userId = userIdOf(participant);
    if (!userId) return;
    const state = this.#deps.getState();
    const settings = this.#deps.settings();
    const percent = (key: string) => (state.selfDeafened ? 0 : volumeOf(settings, state.serverId, key));
    participant.setVolume(percent(userId) / 100);
    participant.setVolume(percent(screenVolumeKey(userId)) / 100, Track.Source.ScreenShareAudio);
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

  /** Turns my camera on or off to match the button, the call and VIDEO. Serialized. */
  #applyCamera(restart = false): Promise<void> {
    this.#cameraOps = this.#cameraOps.then(() => this.#applyCameraNow(restart)).catch(() => {});
    return this.#cameraOps;
  }

  /** `restart`: a live camera is taken back and published again (another quality or device). */
  async #applyCameraNow(restart: boolean): Promise<void> {
    const room = this.#room;
    if (!room) return;
    const local = room.localParticipant;
    if (this.#cameraWanted && !canPublishCamera(local.permissions)) {
      this.#cameraWanted = false;
      this.#deps.dispatch({ type: 'camera', on: false });
    }
    const want = this.#cameraWanted && this.#deps.getState().call.status !== 'idle';
    const live = this.#camera;
    if (live && (!want || restart)) {
      this.#camera = null;
      this.#deps.cameras.local(null);
      // Unpublished, not just muted (setCameraEnabled(false) would only mute): the server's
      // voice.state drops `camera` for everyone, and stopping the track turns the light off.
      await local.unpublishTrack(live, true).catch(() => live.stop());
    }
    if (!want || (live && !restart) || this.#room !== room) return;

    const { cameraQuality, cameraDeviceId } = this.#deps.settings();
    let track: LocalVideoTrack | undefined;
    try {
      const pub = await local.setCameraEnabled(true, cameraCaptureOptions(cameraQuality, cameraDeviceId), cameraPublishOptions(cameraQuality));
      track = pub?.track as LocalVideoTrack | undefined;
    } catch {
      if (this.#room === room) this.#cameraFailed();
      return;
    }
    if (this.#room !== room) {
      // The call ended while the camera was opening.
      track?.stop();
      return;
    }
    if (!track) {
      this.#cameraFailed();
      return;
    }
    this.#camera = track;
    this.#deps.cameras.local(track);
  }

  #cameraFailed(): void {
    this.#cameraWanted = false;
    this.#deps.dispatch({ type: 'camera', on: false });
    this.#deps.dispatch({ type: 'notice', notice: { kind: 'cameraUnavailable' } });
  }

  #deviceConstraint(): Pick<AudioCaptureOptions, 'deviceId'> {
    const { inputDeviceId } = this.#deps.settings();
    return inputDeviceId ? { deviceId: inputDeviceId } : {};
  }

  async #teardown(): Promise<void> {
    const room = this.#room;
    this.#room = null;
    this.#stopPing();
    const share = this.#share;
    this.#share = null;
    if (share) {
      this.#deps.video.local(null);
      for (const track of [share.video, share.audio]) track?.stop();
    }
    // Leaving the call turns the camera off (spec 2026-10-01-camera §3).
    const camera = this.#camera;
    this.#camera = null;
    this.#cameraWanted = false;
    if (camera) {
      this.#deps.cameras.local(null);
      camera.stop();
    }
    if (room) {
      room.removeAllListeners();
      this.#deps.outlet.detachAll();
      this.#deps.video.clear();
      this.#deps.cameras.clear();
      await room.disconnect().catch(() => {});
    }
    if (this.#deps.getState().call.status !== 'idle') this.#deps.dispatch({ type: 'call', status: 'idle', channelId: null });
  }
}
