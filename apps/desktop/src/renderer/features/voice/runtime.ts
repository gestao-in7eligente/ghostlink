// Wires the voice session to the app: server events and requests over IPC, the
// connection store, voice settings, and push-to-talk (in-app keys + the global hook).
// Started by the first mounted voice component (useVoiceRuntime), stopped by the last.
// The store sync (welcome + voice.* events) also runs for useVoiceAvailable() alone.
import { Room, createLocalAudioTrack } from 'livekit-client';
import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import type { VoiceModerateAction } from '@ghostlink/shared';
import { errorCodeOf } from '../../i18n/index.js';
import { useConnectionStore } from '../../stores/connection.js';
import { createCameraOutlet } from './cameraStore.js';
import { directoryFromWelcome, type VoiceDirectory } from './directory.js';
import { createDomOutlet, onNextUserGesture } from './dom.js';
import { GateProcessor } from './gateProcessor.js';
import { cancelScreenPicker, createScreenOutlet, pickScreen } from './screenStore.js';
import { VoiceSession } from './session.js';
import { screenVolumeKey, useVoiceSettings, withVolume, type VoiceSettings } from './settings.js';
import { useVoiceStore } from './state.js';

let session: VoiceSession | null = null;
let users = 0;
let stopRuntime: (() => void) | null = null;
let syncUsers = 0;
let stopSync: (() => void) | null = null;
let audioContext: AudioContext | null = null;
const gates = new Set<GateProcessor>();
let inAppPtt = false;
let globalPtt = false;
let capturingKey = false;

/** The app's AudioContext for the microphone gate and the settings' meter. */
export function voiceAudioContext(): AudioContext {
  audioContext ??= new AudioContext({ latencyHint: 'interactive' });
  return audioContext;
}

function applyPtt(): void {
  useVoiceStore.getState().dispatch({ type: 'ptt', pressed: inAppPtt || globalPtt });
  for (const gate of gates) gate.update();
}

async function createMicrophone(options: Parameters<typeof createLocalAudioTrack>[0]) {
  const track = await createLocalAudioTrack(options);
  const ctx = voiceAudioContext();
  track.setAudioContext(ctx);
  const gate = new GateProcessor(
    {
      mode: () => useVoiceSettings.getState().settings.mode,
      thresholdDb: () => useVoiceSettings.getState().settings.thresholdDb,
      pttPressed: () => useVoiceStore.getState().pttPressed,
      onLevel: (db) => useVoiceStore.getState().dispatch({ type: 'level', db }),
      onOpen: (open) => useVoiceStore.getState().dispatch({ type: 'transmitting', open }),
    },
    ctx,
  );
  const destroy = gate.destroy.bind(gate);
  gate.destroy = async () => {
    gates.delete(gate);
    await destroy();
  };
  gates.add(gate);
  await track.setProcessor(gate);
  return track;
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
    cameras: createCameraOutlet(),
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
    if (s.cameraDeviceId !== prev.cameraDeviceId) void current.switchCamera(s.cameraDeviceId);
    if (s.cameraQuality !== prev.cameraQuality) void current.restartCamera();
    if (s.thresholdDb !== prev.thresholdDb) for (const gate of gates) gate.update();
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

/** The camera button: on or off (spec 2026-10-01-camera §2). */
export function toggleCamera(): Promise<void> {
  return session?.setCamera(!useVoiceStore.getState().camera) ?? Promise.resolve();
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
