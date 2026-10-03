// Wires the voice session to the app: server events and requests over IPC, the
// connection store, voice settings, and push-to-talk (in-app keys + the global hook).
// Started by the first mounted voice component (useVoiceRuntime), stopped by the last
// once no call is on: the call goes on while the screen moves to the Home screen or to
// another server (spec 2026-10-01-chamada-continua-design.md), and its requests and
// events always belong to the call's server, whatever is on screen.
// The store sync (welcome + voice.* events) also runs for useVoiceAvailable() alone.
import { Room, createLocalAudioTrack, type LocalAudioTrack } from 'livekit-client';
import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import type { VoiceModerateAction } from '@ghostlink/shared';
import { errorCodeOf } from '../../i18n/index.js';
import { useConnectionStore } from '../../stores/connection.js';
import { playCallSound } from './callSoundPlayer.js';
import { CallSoundWatcher } from './callSounds.js';
import { createCameraOutlet } from './cameraStore.js';
import { directoryFromWelcome, type VoiceDirectory } from './directory.js';
import { createDomOutlet, onNextUserGesture } from './dom.js';
import { GateProcessor } from './gateProcessor.js';
import { webNoiseBackend } from './noiseBackend.js';
import { NoiseSuppressors, VOICE_SAMPLE_RATE, captureFor, type ResolvedSuppression } from './noiseSuppression.js';
import { cancelScreenPicker, createScreenOutlet, pickScreen } from './screenStore.js';
import { VoiceSession } from './session.js';
import { screenVolumeKey, useVoiceSettings, withLocalMute, withVolume, type NoiseSuppression, type VoiceSettings } from './settings.js';
import { lifetime } from './lifetime.js';
import { callElsewhere, callServerId, selfVoice, useVoiceStore, viewVoice, welcomeServerId } from './state.js';

let session: VoiceSession | null = null;
let audioContext: AudioContext | null = null;
/** The call sounds while the runtime runs. */
let callSounds: CallSoundWatcher | null = null;

/** Each open microphone's gate, its track and the noise suppression it has in use. */
const gates = new Map<GateProcessor, { track: LocalAudioTrack; mode: NoiseSuppression }>();
let inAppPtt = false;
let globalPtt = false;
let capturingKey = false;

/**
 * The app's AudioContext for the microphone gate and the settings' meter, at 48 kHz whatever
 * the output device runs at: RNNoise needs it and GTCRN is silent at 44.1 kHz (Chromium
 * converts the microphone).
 */
export function voiceAudioContext(): AudioContext {
  audioContext ??= new AudioContext({ latencyHint: 'interactive', sampleRate: VOICE_SAMPLE_RATE });
  return audioContext;
}

/**
 * Noise suppression as it runs: the suppressors that failed in this session (the settings show
 * a note under the choice) and the mode the call's microphone has in use, null outside a call.
 */
export const useNoiseStatus = create<{ failed: readonly NoiseSuppression[]; inUse: NoiseSuppression | null }>()(() => ({ failed: [], inUse: null }));

function noteInUse(): void {
  const [mic] = gates.values();
  useNoiseStatus.setState({ inUse: mic?.mode ?? null });
}

const suppressors = new NoiseSuppressors(webNoiseBackend, (kind) => {
  useNoiseStatus.setState((s) => ({ failed: [...s.failed, kind] }));
  // A processor that broke during a call: move that microphone to the fallback.
  void applyNoiseSuppression();
});

/** The suppressor for the settings' microphone test; the caller owns it (the meter destroys it). */
export function resolveNoiseSuppression(mode: NoiseSuppression): Promise<ResolvedSuppression<AudioNode>> {
  return suppressors.resolve(mode, voiceAudioContext());
}

function applyPtt(): void {
  useVoiceStore.getState().dispatch({ type: 'ptt', pressed: inAppPtt || globalPtt });
  for (const gate of gates.keys()) gate.update();
}

async function createMicrophone(options: Parameters<typeof createLocalAudioTrack>[0]) {
  const ctx = voiceAudioContext();
  // Loaded before the microphone opens, so a failure asks for the browser's suppression instead.
  const { mode, suppressor } = await suppressors.resolve(useVoiceSettings.getState().settings.noiseSuppression, ctx);
  let track: LocalAudioTrack;
  try {
    track = await createLocalAudioTrack({ ...options, noiseSuppression: captureFor(mode).noiseSuppression });
  } catch (e) {
    suppressor?.destroy();
    throw e;
  }
  track.setAudioContext(ctx);
  const gate = new GateProcessor(
    {
      mode: () => useVoiceSettings.getState().settings.mode,
      thresholdDb: () => useVoiceSettings.getState().settings.thresholdDb,
      pttPressed: () => useVoiceStore.getState().pttPressed,
      muted: () => {
        const v = useVoiceStore.getState();
        return v.selfMuted || v.selfDeafened || selfVoice(v)?.serverMuted === true;
      },
      onLevel: (db) => useVoiceStore.getState().dispatch({ type: 'level', db }),
      onOpen: (open) => useVoiceStore.getState().dispatch({ type: 'transmitting', open }),
    },
    ctx,
    suppressor,
  );
  const destroy = gate.destroy.bind(gate);
  gate.destroy = async () => {
    gates.delete(gate);
    noteInUse();
    await destroy();
  };
  gates.set(gate, { track, mode });
  noteInUse();
  await track.setProcessor(gate);
  // The choice may have changed while the microphone was opening.
  void applyNoiseSuppression();
  return track;
}

let noiseQueue: Promise<void> = Promise.resolve();

/** Brings every open microphone to the chosen noise suppression, one change at a time. */
function applyNoiseSuppression(): Promise<void> {
  noiseQueue = noiseQueue.then(applyNoiseSuppressionNow).catch(() => {});
  return noiseQueue;
}

/**
 * Live switching (noise spec §2): the gate swaps its suppressor node, and the microphone's
 * own suppression goes on or off when the WebRTC mode starts or ends. The call goes on, and
 * the gate stays between the microphone and what is published throughout.
 */
async function applyNoiseSuppressionNow(): Promise<void> {
  const ctx = voiceAudioContext();
  for (const [gate, mic] of [...gates]) {
    const chosen = useVoiceSettings.getState().settings.noiseSuppression;
    if (suppressors.inUse(chosen) === mic.mode) continue;
    const { mode, suppressor } = await suppressors.resolve(chosen, ctx);
    if (!gates.has(gate)) {
      suppressor?.destroy();
      continue;
    }
    gate.setSuppressor(suppressor);
    if (captureFor(mode).noiseSuppression !== captureFor(mic.mode).noiseSuppression) await setBrowserSuppression(mic.track, mode);
    mic.mode = mode;
    noteInUse();
  }
}

/**
 * Turns the microphone's own noise suppression on or off for `mode`. Chromium accepts
 * applyConstraints() for it but keeps processing as before (measured in Electron 44:
 * getSettings() does not change), so then the microphone is reopened with the new
 * constraints. LiveKit hands the new track to the gate, which restarts shut.
 */
async function setBrowserSuppression(track: LocalAudioTrack, mode: NoiseSuppression): Promise<void> {
  const processing = captureFor(mode);
  await track.applyConstraints(processing).catch(() => {});
  if (track.mediaStreamTrack.getSettings().noiseSuppression === processing.noiseSuppression) return;
  await track.restartTrack({ ...processing, deviceId: track.constraints.deviceId }).catch(() => {});
}

function configureGlobalPtt(s: VoiceSettings): void {
  const enabled = s.mode === 'ptt' && s.pttCode !== null;
  const dispatch = useVoiceStore.getState().dispatch;
  window.ghostlink.ptt.configure({ enabled, code: enabled ? s.pttCode : null }).then(
    (status) => dispatch({ type: 'globalPtt', active: status.global }),
    () => dispatch({ type: 'globalPtt', active: false }),
  );
}

/**
 * Keeps the voice store in step with the servers: the screen's welcome (the connection store),
 * then voice.* events by origin — the call's server's go to the call (and the session), the
 * screen's to its own part when the call is elsewhere (chamada-continua §2).
 */
function startSync(): () => void {
  const voice = useVoiceStore;
  const dispatch = voice.getState().dispatch;
  dispatch({ type: 'view', welcome: useConnectionStore.getState().welcome });
  const offConnection = useConnectionStore.subscribe((c, prev) => {
    if (c.welcome === prev.welcome) return;
    const v = voice.getState();
    // Without a call, another server (or none) leaves nothing of the old one behind.
    if (v.call.status === 'idle' && welcomeServerId(c.welcome) !== v.serverId) void session?.dispose();
    dispatch({ type: 'view', welcome: c.welcome });
  });
  const offEvents = window.ghostlink.onServerEvent((event, serverId) => {
    const v = voice.getState();
    if (event.t === 'welcome') {
      // The screen's welcomes arrive through the connection store; the call's server's (a
      // reconnect, also in the background) here.
      if (serverId === callServerId(v)) dispatch({ type: 'serverEvent', event, serverId });
      return;
    }
    if (!event.t.startsWith('voice.')) return;
    dispatch({ type: 'serverEvent', event, serverId });
    if (serverId === v.serverId) void session?.handleServerEvent(event);
  });
  return () => {
    offEvents();
    offConnection();
  };
}

const sync = lifetime(startSync);

function useVoiceSync(): void {
  useEffect(() => {
    sync.retain();
    return () => sync.release();
  }, []);
}

/**
 * Whether the server's voice runs right now: `voice` in the welcome's features, then the
 * live `voice.availability` event (LiveKit started, crashed, restarted). Show voice UI
 * only while it is true. Works without any other voice component mounted.
 */
export function useVoiceAvailable(): boolean {
  useVoiceSync();
  const welcome = useConnectionStore((c) => c.welcome);
  // Until the sync has taken this welcome in, the welcome itself is the answer.
  return useVoiceStore((v) => {
    const view = viewVoice(v);
    return welcome && view.serverId !== welcome.serverId ? welcome.features.includes('voice') : view.available;
  });
}

function start(): () => void {
  const api = window.ghostlink;
  const voice = useVoiceStore;
  const dispatch = voice.getState().dispatch;
  const initial = useVoiceSettings.getState().settings;
  dispatch({ type: 'self', muted: initial.muted, deafened: initial.deafened });

  const current = new VoiceSession({
    // Always the call's server (chamada-continua §2), whatever is on screen.
    request: (type, payload, serverId) => api.server.request(type, payload, (serverId === undefined ? voice.getState().serverId : serverId) ?? undefined),
    createRoom: (options) => new Room(options),
    dispatch: (action) => voice.getState().dispatch(action),
    getState: () => voice.getState(),
    settings: () => useVoiceSettings.getState().settings,
    outlet: createDomOutlet(),
    video: createScreenOutlet(),
    cameras: createCameraOutlet(),
    screen: {
      sources: () => api.screen.sources(),
      choose: (choice) => api.screen.choose(choice),
      pick: pickScreen,
    },
    createMicrophone,
    onUserGesture: onNextUserGesture,
    connectedAddress: () => voice.getState().address,
  });
  session = current;

  // The call follows its own server's connection (also in the background), never the screen's.
  const offConnection = api.onConnectionState((event) => {
    if (event.serverId !== null && event.serverId === voice.getState().serverId) void current.handleConnection(event.state);
  });

  const offSelf = voice.subscribe((v, prev) => {
    if (v.selfMuted !== prev.selfMuted || v.selfDeafened !== prev.selfDeafened) {
      useVoiceSettings.getState().update({ muted: v.selfMuted, deafened: v.selfDeafened });
    }
    // The screen picker belongs to the call's room: it closes when the call ends or moves.
    if (v.call.channelId !== prev.call.channelId && prev.call.channelId !== null) cancelScreenPicker();
  });
  // The call sounds (v0.5.2): the store once per task, so a call that ends and goes on elsewhere at
  // once (another server's channel) plays join alone; on the chosen output device.
  const sounds = new CallSoundWatcher(voice.getState(), {
    play: (sound) => void playCallSound(sound, useVoiceSettings.getState().settings.outputDeviceId),
    enabled: () => useVoiceSettings.getState().settings.callSounds,
    now: () => Date.now(),
  });
  callSounds = sounds;
  let soundsDue: ReturnType<typeof setTimeout> | null = null;
  const offSounds = voice.subscribe(() => {
    soundsDue ??= setTimeout(() => {
      soundsDue = null;
      sounds.update(voice.getState());
    }, 0);
  });
  // The call's server connected again: its welcome resets who is in the room, which is no one joining.
  const offWelcome = api.onServerEvent((event, serverId) => {
    if (event.t === 'welcome' && serverId === callServerId(voice.getState())) sounds.settle();
  });

  configureGlobalPtt(initial);
  const offSettings = useVoiceSettings.subscribe(({ settings: s }, { settings: prev }) => {
    if (s.mode !== prev.mode || s.pttCode !== prev.pttCode) {
      inAppPtt = false;
      globalPtt = false;
      applyPtt();
      configureGlobalPtt(s);
    }
    if (s.volumes !== prev.volumes || s.localMutes !== prev.localMutes) current.applyVolumes();
    if (s.inputDeviceId !== prev.inputDeviceId) void current.switchDevice('audioinput', s.inputDeviceId ?? 'default');
    if (s.outputDeviceId !== prev.outputDeviceId) void current.switchDevice('audiooutput', s.outputDeviceId ?? 'default');
    if (s.cameraDeviceId !== prev.cameraDeviceId) void current.switchCamera(s.cameraDeviceId);
    if (s.cameraQuality !== prev.cameraQuality) void current.restartCamera();
    if (s.thresholdDb !== prev.thresholdDb) for (const gate of gates.keys()) gate.update();
    if (s.noiseSuppression !== prev.noiseSuppression) void applyNoiseSuppression();
  });

  // Push-to-talk while the window has focus; the global hook covers the rest (spec §8.4).
  const offPtt = api.onPtt(({ pressed }) => {
    globalPtt = pressed;
    applyPtt();
  });
  const onKey = (down: boolean) => (e: KeyboardEvent) => {
    const s = useVoiceSettings.getState().settings;
    if (capturingKey || s.mode !== 'ptt' || e.code !== s.pttCode || (down && e.repeat)) return;
    inAppPtt = down;
    applyPtt();
  };
  const onDown = onKey(true);
  const onUp = onKey(false);
  const onBlur = () => {
    inAppPtt = false;
    applyPtt();
  };
  window.addEventListener('keydown', onDown, true);
  window.addEventListener('keyup', onUp, true);
  window.addEventListener('blur', onBlur);

  return () => {
    window.removeEventListener('keydown', onDown, true);
    window.removeEventListener('keyup', onUp, true);
    window.removeEventListener('blur', onBlur);
    offPtt();
    offSettings();
    offSelf();
    offConnection();
    offWelcome();
    offSounds();
    if (soundsDue) clearTimeout(soundsDue);
    if (callSounds === sounds) callSounds = null;
    void api.ptt.configure({ enabled: false, code: null }).catch(() => {});
    cancelScreenPicker();
    void current.dispose();
    if (session === current) session = null;
  };
}

const runtime = lifetime(start);

/** Keeps the voice runtime alive while at least one voice component is mounted, or a call is on. */
export function useVoiceRuntime(): void {
  useVoiceSync(); // first: the store has the welcome before the session starts
  useEffect(() => {
    runtime.retain();
    return () => runtime.release();
  }, []);
}

// ---- actions (the public voice API for the layout) ----

/** The saved server on screen, or undefined on the Home screen. */
function viewedServerId(): string | undefined {
  return useConnectionStore.getState().welcome?.serverId;
}

/** Joins a voice channel of the server on screen (the layout's onJoinVoice handler); a call elsewhere ends first. */
export function joinVoice(channelId: string): Promise<void> {
  const serverId = viewedServerId();
  const { call, serverId: callServer } = useVoiceStore.getState();
  // Moving the call: its end here is not a dropped call.
  if (call.status !== 'idle' && (call.channelId !== channelId || callServer !== (serverId ?? null))) callSounds?.expectLeave();
  return session?.join(channelId, serverId === undefined ? {} : { serverId }) ?? Promise.resolve();
}

/**
 * Back to the call's server from the Home screen or another server (the call panel's channel
 * name): main hands back the connection the call uses, without reconnecting.
 */
export async function openCallServer(): Promise<void> {
  const serverId = callServerId(useVoiceStore.getState());
  if (serverId === null || serverId === viewedServerId()) return;
  try {
    const welcome = await window.ghostlink.servers.connect(serverId);
    useConnectionStore.getState().dispatch({ type: 'joined', welcome });
  } catch (e) {
    useVoiceStore.getState().dispatch({ type: 'notice', notice: { kind: 'error', code: errorCodeOf(e) } });
  }
}

export function leaveVoice(): Promise<void> {
  if (useVoiceStore.getState().call.status !== 'idle') callSounds?.expectLeave();
  return session?.leave() ?? Promise.resolve();
}

/** The microphone button: unmuting while deafened also undeafens. */
export function toggleMute(): Promise<void> {
  const { selfMuted, selfDeafened } = useVoiceStore.getState();
  const muted = !(selfMuted || selfDeafened);
  if (!session) {
    useVoiceStore.getState().dispatch({ type: 'self', muted, deafened: muted ? selfDeafened : false });
    return Promise.resolve();
  }
  return session.setMuted(muted);
}

export function toggleDeafen(): Promise<void> {
  const deafened = !useVoiceStore.getState().selfDeafened;
  if (!session) {
    useVoiceStore.getState().dispatch({ type: 'self', deafened });
    return Promise.resolve();
  }
  return session.setDeafened(deafened);
}

/** Per-user volume in percent (0–200), saved per server (the one on screen) and user (spec §8.4). */
export function setUserVolume(userId: string, percent: number): void {
  const serverId = viewVoice(useVoiceStore.getState()).serverId;
  if (serverId) useVoiceSettings.getState().update((s) => withVolume(s, serverId, userId, percent));
}

/**
 * "Silenciar" in someone's menu: their voice off for me only, saved per server (the one on
 * screen) and user like the volume, which it leaves as it was.
 */
export function setLocalMute(userId: string, muted: boolean): void {
  const serverId = viewVoice(useVoiceStore.getState()).serverId;
  if (serverId) useVoiceSettings.getState().update((s) => withLocalMute(s, serverId, userId, muted));
}

/** A person's stream volume (0–200 %), saved apart from their voice (spec 2026-10-01 §5). */
export function setScreenVolume(userId: string, percent: number): void {
  setUserVolume(screenVolumeKey(userId), percent);
}

/** "Transmitir tela": opens the picker, then captures and publishes. */
export function startScreenShare(): Promise<void> {
  return session?.startScreenShare() ?? Promise.resolve();
}

/** "Parar transmissão". */
export function stopScreenShare(): Promise<void> {
  return session?.stopScreenShare() ?? Promise.resolve();
}

/** The camera button: on or off (spec 2026-10-01-camera §2). */
export function toggleCamera(): Promise<void> {
  return session?.setCamera(!useVoiceStore.getState().camera) ?? Promise.resolve();
}

/** "Assistir": a screen I stopped watching comes back (every other one is watched without a click). */
export function watchScreen(userId: string): void {
  session?.watch(userId);
}

/** "Parar de assistir": until that share ends. */
export function unwatchScreen(userId: string): void {
  session?.unwatch(userId);
}

/** voice.moderate on the server on screen (its sidebar or stage); a refusal (FORBIDDEN, HIERARCHY…) shows as a voice notice. */
export async function moderateVoice(userId: string, action: VoiceModerateAction, toChannelId?: string): Promise<void> {
  try {
    await window.ghostlink.server.request('voice.moderate', { userId, action, ...(toChannelId ? { toChannelId } : {}) }, viewedServerId());
  } catch (e) {
    useVoiceStore.getState().dispatch({ type: 'notice', notice: { kind: 'error', code: errorCodeOf(e) } });
  }
}

/** While the settings record a push-to-talk key, that key must not transmit. */
export function setKeyCapture(active: boolean): void {
  capturingKey = active;
  if (active && inAppPtt) {
    inAppPtt = false;
    applyPtt();
  }
}

// ---- directory ----

const useDirectoryOverride = create<{ directory: VoiceDirectory | null }>()(() => ({ directory: null }));

/**
 * Integration seam: the main layout may provide names, channels and permissions from its
 * live stores. Call again with a new object when they change; null restores the default.
 */
export function provideVoiceDirectory(directory: VoiceDirectory | null): void {
  useDirectoryOverride.setState({ directory });
}

/** Names, channels and permissions of the server on screen. */
export function useVoiceDirectory(): VoiceDirectory {
  const override = useDirectoryOverride((s) => s.directory);
  const welcome = useConnectionStore((c) => c.welcome);
  const names = useVoiceStore((v) => v.names);
  return useMemo(() => override ?? directoryFromWelcome(welcome, names), [override, welcome, names]);
}

const useCallDirectoryOverride = create<{ directory: VoiceDirectory | null }>()(() => ({ directory: null }));

/**
 * Integration seam (chamada-continua §2): the call's server's names, photos and channels while
 * it is not on screen, kept live by its connection's events. Null: none kept.
 */
export function provideCallDirectory(directory: VoiceDirectory | null): void {
  useCallDirectoryOverride.setState({ directory });
}

/** Names, channels and permissions of the call's server: the screen's while it is on screen, else the kept ones. */
export function useCallDirectory(): VoiceDirectory {
  const screen = useVoiceDirectory();
  const kept = useCallDirectoryOverride((s) => s.directory);
  const elsewhere = useVoiceStore(callElsewhere);
  const names = useVoiceStore((v) => v.names);
  return useMemo(() => (elsewhere ? (kept ?? directoryFromWelcome(null, names)) : screen), [elsewhere, kept, names, screen]);
}
