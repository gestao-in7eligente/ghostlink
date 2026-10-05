// Local voice settings (spec §8.4, §11.1 item 7): devices, input mode and key, the
// voice-activity threshold, noise suppression, mute/deafen, per-user volume and mute per server,
// the camera with its quality, and the call sounds. They live in this app's localStorage (per
// userData profile); what is read back is never trusted.
import { create } from 'zustand';
import { DEFAULT_CAMERA_QUALITY, isCameraQuality, type CameraQuality } from './camera.js';

export type InputMode = 'vad' | 'ptt';

/**
 * Noise suppression (noise suppression spec 2026-10-01 §1): a WebAssembly suppressor in the
 * gate's graph (RNNoise, Speex, GTCRN), the browser's own (WebRTC), or none.
 */
export type NoiseSuppression = 'rnnoise' | 'speex' | 'gtcrn' | 'webrtc' | 'off';

/** In the order the settings list them. */
export const NOISE_SUPPRESSIONS: readonly NoiseSuppression[] = ['rnnoise', 'speex', 'gtcrn', 'webrtc', 'off'];

export function isNoiseSuppression(v: unknown): v is NoiseSuppression {
  return typeof v === 'string' && (NOISE_SUPPRESSIONS as readonly string[]).includes(v);
}

export interface VoiceSettings {
  /** null = the system default device. */
  inputDeviceId: string | null;
  outputDeviceId: string | null;
  /** Voice activity (default) or push-to-talk. */
  mode: InputMode;
  /** Push-to-talk key as a DOM KeyboardEvent.code (e.g. "KeyV"), null until chosen. */
  pttCode: string | null;
  /** Voice activity opens the microphone above this level (dBFS, -100..0). */
  thresholdDb: number;
  /** RNNoise by default, also for settings saved before the choice existed. */
  noiseSuppression: NoiseSuppression;
  muted: boolean;
  deafened: boolean;
  /** serverId → userId (or screenVolumeKey(userId) for their stream) → volume in percent (0–200); absent means 100. */
  volumes: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /**
   * serverId → the people I muted for myself ("Silenciar" in their menu, spec
   * 2026-10-02-menu-do-usuario §2). Apart from `volumes`, so muting keeps the chosen volume.
   */
  localMutes: Readonly<Record<string, readonly string[]>>;
  /** null = the system's first camera (spec 2026-10-01-camera §2). */
  cameraDeviceId: string | null;
  /** What my camera sends: 720p30 by default. */
  cameraQuality: CameraQuality;
  /** "Sons da chamada" (v0.5.2): joins, leaves, mute, deafen, screens and a dropped call make a sound. On by default. */
  callSounds: boolean;
}

export const defaultVoiceSettings: VoiceSettings = {
  inputDeviceId: null,
  outputDeviceId: null,
  mode: 'vad',
  pttCode: null,
  thresholdDb: -50,
  noiseSuppression: 'rnnoise',
  muted: false,
  deafened: false,
  volumes: {},
  localMutes: {},
  cameraDeviceId: null,
  cameraQuality: DEFAULT_CAMERA_QUALITY,
  callSounds: true,
};

export const VOICE_SETTINGS_KEY = 'ghostlink.voice.v1';
export const MIN_THRESHOLD_DB = -100;
export const MAX_VOLUME = 200;

/** The two Storage methods used (a Map in tests, localStorage in the app). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** A person's voice volume is under their user id; their stream's sound under "screen:<userId>". */
const VOLUME_KEY = /^(?:screen:)?[0-9a-f]{32}$/;
const USER_ID = /^[0-9a-f]{32}$/;
const SERVER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PTT_CODE = /^[A-Z][A-Za-z0-9]{0,23}$/;
const MAX_SERVERS = 100;
const MAX_USERS_PER_SERVER = 1_000;

export function isPttCode(code: unknown): code is string {
  return typeof code === 'string' && PTT_CODE.test(code);
}

function clampVolume(v: number): number {
  return Math.min(MAX_VOLUME, Math.max(0, Math.round(v)));
}

function deviceId(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= 512 ? v : null;
}

function own(o: object, key: string): unknown {
  return Object.hasOwn(o, key) ? (o as Record<string, unknown>)[key] : undefined;
}

function parseVolumes(raw: unknown): VoiceSettings['volumes'] {
  const out: Record<string, Record<string, number>> = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const serverId of Object.keys(raw).filter((k) => SERVER_ID.test(k)).slice(0, MAX_SERVERS)) {
    const users = own(raw, serverId);
    if (typeof users !== 'object' || users === null || Array.isArray(users)) continue;
    const entries: Record<string, number> = {};
    for (const userId of Object.keys(users).filter((k) => VOLUME_KEY.test(k)).slice(0, MAX_USERS_PER_SERVER)) {
      const v = own(users, userId);
      if (typeof v === 'number' && Number.isFinite(v)) entries[userId] = clampVolume(v);
    }
    if (Object.keys(entries).length > 0) out[serverId] = entries;
  }
  return out;
}

function parseLocalMutes(raw: unknown): VoiceSettings['localMutes'] {
  const out: Record<string, string[]> = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const serverId of Object.keys(raw).filter((k) => SERVER_ID.test(k)).slice(0, MAX_SERVERS)) {
    const users = own(raw, serverId);
    if (!Array.isArray(users)) continue;
    const ids = [...new Set(users.filter((u): u is string => typeof u === 'string' && USER_ID.test(u)))].slice(0, MAX_USERS_PER_SERVER);
    if (ids.length > 0) out[serverId] = ids;
  }
  return out;
}

/** Field by field: every valid value is kept, everything else falls back to the default. */
export function parseVoiceSettings(raw: unknown): VoiceSettings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return defaultVoiceSettings;
  const mode = own(raw, 'mode');
  const threshold = own(raw, 'thresholdDb');
  const muted = own(raw, 'muted');
  const deafened = own(raw, 'deafened');
  const pttCode = own(raw, 'pttCode');
  const cameraQuality = own(raw, 'cameraQuality');
  const noise = own(raw, 'noiseSuppression');
  const callSounds = own(raw, 'callSounds');
  return {
    inputDeviceId: deviceId(own(raw, 'inputDeviceId')),
    outputDeviceId: deviceId(own(raw, 'outputDeviceId')),
    mode: mode === 'ptt' || mode === 'vad' ? mode : defaultVoiceSettings.mode,
    pttCode: isPttCode(pttCode) ? pttCode : null,
    thresholdDb:
      typeof threshold === 'number' && Number.isFinite(threshold)
        ? Math.min(0, Math.max(MIN_THRESHOLD_DB, Math.round(threshold)))
        : defaultVoiceSettings.thresholdDb,
    noiseSuppression: isNoiseSuppression(noise) ? noise : defaultVoiceSettings.noiseSuppression,
    muted: typeof muted === 'boolean' ? muted : false,
    deafened: typeof deafened === 'boolean' ? deafened : false,
    volumes: parseVolumes(own(raw, 'volumes')),
    localMutes: parseLocalMutes(own(raw, 'localMutes')),
    cameraDeviceId: deviceId(own(raw, 'cameraDeviceId')),
    cameraQuality: isCameraQuality(cameraQuality) ? cameraQuality : DEFAULT_CAMERA_QUALITY,
    callSounds: typeof callSounds === 'boolean' ? callSounds : true,
  };
}

export function loadVoiceSettings(storage: KeyValueStorage | null): VoiceSettings {
  try {
    const text = storage?.getItem(VOICE_SETTINGS_KEY);
    return text ? parseVoiceSettings(JSON.parse(text)) : defaultVoiceSettings;
  } catch {
    return defaultVoiceSettings;
  }
}

export function saveVoiceSettings(storage: KeyValueStorage | null, settings: VoiceSettings): void {
  try {
    storage?.setItem(VOICE_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage full or blocked: the settings still apply for this run.
  }
}

/** Where a person's stream volume is saved: apart from their voice (spec 2026-10-01 §5). */
export function screenVolumeKey(userId: string): string {
  return `screen:${userId}`;
}

/** Volume in percent for a user (or a screenVolumeKey) on a server (100 by default). */
export function volumeOf(settings: VoiceSettings, serverId: string | null, userId: string): number {
  if (!serverId || !Object.hasOwn(settings.volumes, serverId)) return 100;
  const users = settings.volumes[serverId]!;
  return Object.hasOwn(users, userId) ? users[userId]! : 100;
}

/** Sets a user's volume (clamped to 0–200 %); 100 % removes the entry. */
export function withVolume(settings: VoiceSettings, serverId: string, userId: string, percent: number): VoiceSettings {
  const users = { ...(Object.hasOwn(settings.volumes, serverId) ? settings.volumes[serverId] : {}) };
  const v = clampVolume(percent);
  if (v === 100) delete users[userId];
  else users[userId] = v;
  const volumes = { ...settings.volumes };
  if (Object.keys(users).length > 0) volumes[serverId] = users;
  else delete volumes[serverId];
  return { ...settings, volumes };
}

/** Whether I muted `userId` for myself on a server. */
export function isLocallyMuted(settings: VoiceSettings, serverId: string | null, userId: string): boolean {
  return serverId !== null && Object.hasOwn(settings.localMutes, serverId) && settings.localMutes[serverId]!.includes(userId);
}

/** Mutes or unmutes `userId` for me on a server; their volume stays as it was. */
export function withLocalMute(settings: VoiceSettings, serverId: string, userId: string, muted: boolean): VoiceSettings {
  const current = Object.hasOwn(settings.localMutes, serverId) ? settings.localMutes[serverId]! : [];
  if (current.includes(userId) === muted) return settings;
  const users = muted ? [...current, userId] : current.filter((u) => u !== userId);
  const localMutes = { ...settings.localMutes };
  if (users.length > 0) localMutes[serverId] = users;
  else delete localMutes[serverId];
  return { ...settings, localMutes };
}

function browserStorage(): KeyValueStorage | null {
  try {
    return (globalThis as { localStorage?: KeyValueStorage }).localStorage ?? null;
  } catch {
    return null;
  }
}

interface VoiceSettingsStore {
  settings: VoiceSettings;
  update(patch: Partial<VoiceSettings> | ((s: VoiceSettings) => VoiceSettings)): void;
}

/** The voice settings, loaded once and saved on every change. */
export const useVoiceSettings = create<VoiceSettingsStore>()((set, get) => ({
  settings: loadVoiceSettings(browserStorage()),
  update: (patch) => {
    const current = get().settings;
    const next = typeof patch === 'function' ? patch(current) : parseVoiceSettings({ ...current, ...patch });
    saveVoiceSettings(browserStorage(), next);
    set({ settings: next });
  },
}));
