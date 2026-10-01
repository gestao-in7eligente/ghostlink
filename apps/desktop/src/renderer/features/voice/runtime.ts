// Wires the voice session to the app: server events and requests over IPC, the
// connection store, voice settings, and push-to-talk (in-app keys + the global hook).
// Started by the first mounted voice component (useVoiceRuntime), stopped by the last.
// The store sync (welcome + voice.* events) also runs for useVoiceAvailable() alone.
import { Room, createLocalAudioTrack, type LocalAudioTrack } from 'livekit-client';
import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import type { VoiceModerateAction } from '@ghostlink/shared';
import { errorCodeOf } from '../../i18n/index.js';
import { useConnectionStore } from '../../stores/connection.js';
import { directoryFromWelcome, type VoiceDirectory } from './directory.js';
import { createDomOutlet, onNextUserGesture } from './dom.js';
import { GateProcessor } from './gateProcessor.js';
import { webNoiseBackend } from './noiseBackend.js';
import { NoiseSuppressors, VOICE_SAMPLE_RATE, captureFor, type ResolvedSuppression } from './noiseSuppression.js';
import { cancelScreenPicker, createScreenOutlet, pickScreen } from './screenStore.js';
import { VoiceSession } from './session.js';
import { screenVolumeKey, useVoiceSettings, withVolume, type NoiseSuppression, type VoiceSettings } from './settings.js';
import { selfVoice, useVoiceStore } from './state.js';

let session: VoiceSession | null = null;
let users = 0;
let stopRuntime: (() => void) | null = null;
let syncUsers = 0;
let stopSync: (() => void) | null = null;
let audioContext: AudioContext | null = null;
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

/** Keeps the voice store in step with the server: the welcome snapshot, then voice.* events (also to the session, when one runs). */
function startSync(): () => void {
  const voice = useVoiceStore;
  const dispatch = voice.getState().dispatch;
  const welcome = useConnectionStore.getState().welcome;
  if (welcome) dispatch({ type: 'welcome', welcome });
  const offConnection = useConnectionStore.subscribe((c, prev) => {
    if (c.welcome === prev.welcome) return;
    // Another server (or none): the call and the snapshot belong to the old one.
    if (!c.welcome || c.welcome.serverId !== voice.getState().serverId) {
      void session?.dispose();
      dispatch({ type: 'reset' });
    }
    if (c.welcome) dispatch({ type: 'welcome', welcome: c.welcome });
  });
  const offEvents = window.ghostlink.onServerEvent((event) => {
    if (!event.t.startsWith('voice.')) return;
    dispatch({ type: 'serverEvent', event });
    void session?.handleServerEvent(event);
  });
  return () => {
    offEvents();
    offConnection();
  };
}

function useVoiceSync(): void {
  useEffect(() => {
    if (syncUsers++ === 0) stopSync = startSync();
    return () => {
      if (--syncUsers === 0) {
        stopSync?.();
        stopSync = null;
      }
    };
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
  return useVoiceStore((v) => (welcome && v.serverId !== welcome.serverId ? welcome.features.includes('voice') : v.available));
}

function start(): () => void {
  const api = window.ghostlink;
  const voice = useVoiceStore;
  const dispatch = voice.getState().dispatch;
  const initial = useVoiceSettings.getState().settings;
  dispatch({ type: 'self', muted: initial.muted, deafened: initial.deafened });

  const current = new VoiceSession({
    request: (type, payload) => api.server.request(type, payload),
    createRoom: (options) => new Room(options),
    dispatch: (action) => voice.getState().dispatch(action),
    getState: () => voice.getState(),
    settings: () => useVoiceSettings.getState().settings,
    outlet: createDomOutlet(),
    video: createScreenOutlet(),
    screen: {
      sources: () => api.screen.sources(),
      choose: (choice) => api.screen.choose(choice),
      pick: pickScreen,
    },
    createMicrophone,
    onUserGesture: onNextUserGesture,
    connectedAddress: () => useConnectionStore.getState().welcome?.address ?? null,
  });
  session = current;

  const offConnection = useConnectionStore.subscribe((c, prev) => {
    if (c.state !== prev.state) void current.handleConnection(c.state);
  });

  const offSelf = voice.subscribe((v, prev) => {
    if (v.selfMuted !== prev.selfMuted || v.selfDeafened !== prev.selfDeafened) {
      useVoiceSettings.getState().update({ muted: v.selfMuted, deafened: v.selfDeafened });
    }
    // The screen picker belongs to the call: it closes when the call ends.
    if (v.call.status === 'idle' && prev.call.status !== 'idle') cancelScreenPicker();
  });
  configureGlobalPtt(initial);
  const offSettings = useVoiceSettings.subscribe(({ settings: s }, { settings: prev }) => {
    if (s.mode !== prev.mode || s.pttCode !== prev.pttCode) {
      inAppPtt = false;
      globalPtt = false;
      applyPtt();
      configureGlobalPtt(s);
    }
    if (s.volumes !== prev.volumes) current.applyVolumes();
    if (s.inputDeviceId !== prev.inputDeviceId) void current.switchDevice('audioinput', s.inputDeviceId ?? 'default');
    if (s.outputDeviceId !== prev.outputDeviceId) void current.switchDevice('audiooutput', s.outputDeviceId ?? 'default');
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
    void api.ptt.configure({ enabled: false, code: null }).catch(() => {});
    cancelScreenPicker();
    void current.dispose();
    if (session === current) session = null;
  };
}

/** Keeps the voice runtime alive while at least one voice component is mounted. */
export function useVoiceRuntime(): void {
  useVoiceSync(); // first: the store has the welcome before the session starts
  useEffect(() => {
    if (users++ === 0) stopRuntime = start();
    return () => {
      if (--users === 0) {
        stopRuntime?.();
        stopRuntime = null;
      }
    };
  }, []);
}

// ---- actions (the public voice API for the layout) ----

/** Joins a voice channel (the layout's onJoinVoice handler). */
export function joinVoice(channelId: string): Promise<void> {
  return session?.join(channelId) ?? Promise.resolve();
}

export function leaveVoice(): Promise<void> {
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

/** Per-user volume in percent (0–200), saved per server and user (spec §8.4). */
export function setUserVolume(userId: string, percent: number): void {
  const serverId = useVoiceStore.getState().serverId;
  if (serverId) useVoiceSettings.getState().update((s) => withVolume(s, serverId, userId, percent));
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

/** "Assistir" (spec §8.4: a screen is received only on demand). */
export function watchScreen(userId: string): void {
  session?.watch(userId);
}

/** "Parar de assistir". */
export function unwatchScreen(userId: string): void {
  session?.unwatch(userId);
}

/** voice.moderate; a refusal (FORBIDDEN, HIERARCHY…) shows as a voice notice. */
export async function moderateVoice(userId: string, action: VoiceModerateAction, toChannelId?: string): Promise<void> {
  try {
    await window.ghostlink.server.request('voice.moderate', { userId, action, ...(toChannelId ? { toChannelId } : {}) });
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

export function useVoiceDirectory(): VoiceDirectory {
  const override = useDirectoryOverride((s) => s.directory);
  const welcome = useConnectionStore((c) => c.welcome);
  const names = useVoiceStore((v) => v.names);
  return useMemo(() => override ?? directoryFromWelcome(welcome, names), [override, welcome, names]);
}
