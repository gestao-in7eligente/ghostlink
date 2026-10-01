// The `voice` store's state and its pure reducer (spec §11.2). Server data arrives
// through lenient client schemas (spec §5.1): anything malformed is ignored.
import { create } from 'zustand';
import {
  voiceAvailabilitySchemaClient,
  voiceStateSchemaClient,
  voiceWelcomeSchemaClient,
  type Envelope,
  type VoiceChannelState,
  type VoiceParticipant,
} from '@ghostlink/shared';
import type { AppErrorCode } from '../../../shared/appErrors.js';
import type { ScreenContent, ScreenQuality } from './screenShare.js';

export type CallStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting';

/** Something the voice UI tells the user once (then dismisses). */
export type VoiceNotice =
  | { kind: 'error'; code: AppErrorCode }
  | { kind: 'forceDisconnect' }
  | { kind: 'dropped' }
  | { kind: 'micUnavailable' }
  /** The chosen screen or window could not be captured (spec 2026-10-01 §8). */
  | { kind: 'screenFailed' }
  /** The PC's sound without GhostLink's own is unavailable: picture only (spec 2026-10-01 §4). */
  | { kind: 'screenAudio' };

/** My own screen share while it is live. */
export interface ScreenSharing {
  quality: ScreenQuality;
  content: ScreenContent;
  /** The PC's sound goes too. */
  audio: boolean;
  /** The screen or window's name. */
  name: string;
}

export interface VoiceState {
  /** The saved server the snapshot belongs to (per-user volumes are stored per server). */
  serverId: string | null;
  selfUserId: string | null;
  /** The server's voice runs: `voice` in welcome.features, then voice.availability live. The voice UI shows only then. */
  available: boolean;
  /** channelId → who is in it, as the server reports (only channels this user can see). */
  channels: Readonly<Record<string, VoiceParticipant[]>>;
  /** This app's own call. */
  call: { status: CallStatus; channelId: string | null };
  selfMuted: boolean;
  selfDeafened: boolean;
  /** Users LiveKit reports as speaking in my room. */
  speaking: string[];
  /** Users whose microphone track this app receives. */
  subscribed: string[];
  /** Display names LiveKit reports for people in my room (a fallback when no member list is loaded). */
  names: Readonly<Record<string, string>>;
  /** Signal round trip to the voice server. */
  pingMs: number | null;
  /** Push-to-talk key held (in-app or global). */
  pttPressed: boolean;
  /** My microphone gate is open: my own ring lights up at once, before LiveKit reports it. */
  transmitting: boolean;
  /** Whether push-to-talk also works while another app has focus. */
  globalPtt: boolean;
  /** Live microphone level in dBFS while in a call or testing the microphone. */
  inputLevelDb: number;
  notice: VoiceNotice | null;
  /** My screen share, or null. Who else is live comes from voice.state (`screen` per person). */
  sharing: ScreenSharing | null;
  /** People whose screen I watch (spec §8.4): re-applied on TrackPublished, also after a reconnect. */
  watching: string[];
}

export const initialVoiceState: VoiceState = {
  serverId: null,
  selfUserId: null,
  available: false,
  channels: {},
  call: { status: 'idle', channelId: null },
  selfMuted: false,
  selfDeafened: false,
  speaking: [],
  subscribed: [],
  names: {},
  pingMs: null,
  pttPressed: false,
  transmitting: false,
  globalPtt: false,
  inputLevelDb: -100,
  notice: null,
  sharing: null,
  watching: [],
};

export type VoiceAction =
  | { type: 'welcome'; welcome: unknown }
  | { type: 'serverEvent'; event: Envelope }
  | { type: 'reset' }
  | { type: 'call'; status: CallStatus; channelId: string | null }
  | { type: 'self'; muted?: boolean; deafened?: boolean }
  | { type: 'speaking'; userIds: string[] }
  | { type: 'subscribed'; userId: string; subscribed: boolean }
  | { type: 'names'; names: Readonly<Record<string, string>> }
  | { type: 'ping'; ms: number | null }
  | { type: 'ptt'; pressed: boolean }
  | { type: 'transmitting'; open: boolean }
  | { type: 'globalPtt'; active: boolean }
  | { type: 'level'; db: number }
  | { type: 'notice'; notice: VoiceNotice | null }
  | { type: 'sharing'; sharing: ScreenSharing | null }
  | { type: 'watch'; userId: string; watching: boolean };

function channelsFrom(list: VoiceChannelState[]): Record<string, VoiceParticipant[]> {
  const out: Record<string, VoiceParticipant[]> = {};
  for (const c of list) if (c.participants.length > 0) out[c.channelId] = c.participants;
  return out;
}

function fromWelcome(s: VoiceState, welcome: unknown): VoiceState {
  const w = (typeof welcome === 'object' && welcome !== null ? welcome : {}) as { serverId?: unknown; self?: { userId?: unknown }; features?: unknown; voice?: unknown };
  const voice = voiceWelcomeSchemaClient.safeParse(w.voice);
  return {
    ...s,
    serverId: typeof w.serverId === 'string' ? w.serverId : s.serverId,
    selfUserId: typeof w.self?.userId === 'string' ? w.self.userId : s.selfUserId,
    available: Array.isArray(w.features) && w.features.includes('voice'),
    channels: voice.success ? channelsFrom(voice.data) : {},
  };
}

/** Pure reducer behind the voice store. */
export function voiceReducer(s: VoiceState, a: VoiceAction): VoiceState {
  switch (a.type) {
    case 'welcome':
      return fromWelcome(s, a.welcome);
    case 'serverEvent': {
      if (a.event.t === 'welcome') return fromWelcome(s, a.event.d);
      if (a.event.t === 'voice.availability') {
        const parsed = voiceAvailabilitySchemaClient.safeParse(a.event.d);
        return !parsed.success || parsed.data.available === s.available ? s : { ...s, available: parsed.data.available };
      }
      if (a.event.t !== 'voice.state') return s;
      const parsed = voiceStateSchemaClient.safeParse(a.event.d);
      if (!parsed.success) return s;
      const { channelId, participants } = parsed.data;
      const channels = { ...s.channels };
      if (participants.length > 0) channels[channelId] = participants;
      else delete channels[channelId];
      return { ...s, channels };
    }
    case 'reset':
      // Mute and deafen are the user's preference, kept across servers (Discord-like).
      return { ...initialVoiceState, selfMuted: s.selfMuted, selfDeafened: s.selfDeafened, globalPtt: s.globalPtt };
    case 'call':
      if (a.status === 'idle') {
        return { ...s, call: { status: 'idle', channelId: null }, speaking: [], subscribed: [], pingMs: null, transmitting: false, sharing: null, watching: [] };
      }
      return { ...s, call: { status: a.status, channelId: a.channelId } };
    case 'self':
      return { ...s, selfMuted: a.muted ?? s.selfMuted, selfDeafened: a.deafened ?? s.selfDeafened };
    case 'speaking':
      return { ...s, speaking: a.userIds };
    case 'subscribed': {
      const rest = s.subscribed.filter((u) => u !== a.userId);
      return { ...s, subscribed: a.subscribed ? [...rest, a.userId] : rest };
    }
    case 'names':
      return { ...s, names: { ...s.names, ...a.names } };
    case 'ping':
      return { ...s, pingMs: a.ms };
    case 'ptt':
      return s.pttPressed === a.pressed ? s : { ...s, pttPressed: a.pressed };
    case 'transmitting':
      return s.transmitting === a.open ? s : { ...s, transmitting: a.open };
    case 'globalPtt':
      return { ...s, globalPtt: a.active };
    case 'level':
      return { ...s, inputLevelDb: a.db };
    case 'notice':
      return { ...s, notice: a.notice };
    case 'sharing':
      return { ...s, sharing: a.sharing };
    case 'watch': {
      if (s.watching.includes(a.userId) === a.watching) return s;
      return { ...s, watching: a.watching ? [...s.watching, a.userId] : s.watching.filter((u) => u !== a.userId) };
    }
  }
}

const NOBODY: VoiceParticipant[] = [];

/** Who is in a voice channel (a stable empty list when nobody is). */
export function participantsOf(s: VoiceState, channelId: string): VoiceParticipant[] {
  return s.channels[channelId] ?? NOBODY;
}

/** My own entry in the channel I am in, as the server reports it (server mute lives here). */
export function selfVoice(s: VoiceState): VoiceParticipant | null {
  const { channelId } = s.call;
  if (!channelId || !s.selfUserId) return null;
  return participantsOf(s, channelId).find((p) => p.userId === s.selfUserId) ?? null;
}

const NOBODY_LIVE: string[] = [];

/** Who shares a screen in a voice channel, in the channel's order (from voice.state). */
export function liveIn(s: VoiceState, channelId: string): string[] {
  const live = participantsOf(s, channelId).filter((p) => p.screen);
  return live.length === 0 ? NOBODY_LIVE : live.map((p) => p.userId);
}

/**
 * The voice stage while watching: the streams shown (live and watched, in the channel's
 * order) and the one shown large: the one clicked, or the only one. With several and
 * none clicked they form a grid.
 */
export function streamLayout(live: readonly string[], watching: readonly string[], focus: string | null): { shown: string[]; focused: string | null } {
  const shown = live.filter((u) => watching.includes(u));
  const focused = focus !== null && shown.includes(focus) ? focus : shown.length === 1 ? shown[0]! : null;
  return { shown, focused };
}

/** Whether `userId` shows as speaking: LiveKit's report, or my own open gate for me. */
export function isSpeaking(s: VoiceState, userId: string): boolean {
  return s.speaking.includes(userId) || (userId === s.selfUserId && s.transmitting && s.call.status === 'connected');
}

interface VoiceStore extends VoiceState {
  dispatch(action: VoiceAction): void;
}

/** The renderer's `voice` store (spec §11.2). */
export const useVoiceStore = create<VoiceStore>()((set) => ({
  ...initialVoiceState,
  dispatch: (action) => set((s) => voiceReducer(s, action)),
}));
