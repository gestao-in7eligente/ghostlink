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
  | { kind: 'screenAudio' }
  /** The camera could not be opened or published (spec 2026-10-01-camera). */
  | { kind: 'cameraUnavailable' };

/** My own screen share while it is live. */
export interface ScreenSharing {
  quality: ScreenQuality;
  content: ScreenContent;
  /** The PC's sound goes too. */
  audio: boolean;
  /** The screen or window's name. */
  name: string;
}

/** One server's voice as the server reports it: its welcome, then voice.* events. */
export interface ServerVoice {
  /** The saved server the snapshot belongs to (per-user volumes are stored per server). */
  serverId: string | null;
  selfUserId: string | null;
  /** The server's voice runs: `voice` in welcome.features, then voice.availability live. The voice UI shows only then. */
  available: boolean;
  /** channelId → who is in it, as the server reports (only channels this user can see). */
  channels: Readonly<Record<string, VoiceParticipant[]>>;
  /** The server's name (the call panel's "{canal} / {servidor}"). */
  serverName: string;
  /** host:port of its connection: the only place voice.join may send the call (spec §4, §8.2). */
  address: string | null;
}

/**
 * The top-level ServerVoice is the voice runtime's server: the call's while a call is on
 * (connecting included), else the one on screen. During a call the screen may show another
 * server (chamada-continua §2): its own voice lives in `view` then, and switching the screen
 * never touches the call's part.
 */
export interface VoiceState extends ServerVoice {
  /** The saved server on screen; null on the Home screen. */
  viewServerId: string | null;
  /** The voice of the server on screen while the call runs on another one; null otherwise. */
  view: ServerVoice | null;
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
  /** My camera is on (or opening). Who else has one comes from voice.state (`camera` per person). */
  camera: boolean;
}

export const initialVoiceState: VoiceState = {
  serverId: null,
  selfUserId: null,
  available: false,
  channels: {},
  serverName: '',
  address: null,
  viewServerId: null,
  view: null,
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
  camera: false,
};

export type VoiceAction =
  /** A welcome of the runtime's server (its first one, or a reconnect). */
  | { type: 'welcome'; welcome: unknown }
  /** The server on screen changed, or got a new welcome; null: the Home screen. */
  | { type: 'view'; welcome: unknown }
  /** A server event; `serverId`: where it came from (absent: the runtime's server). */
  | { type: 'serverEvent'; event: Envelope; serverId?: string }
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
  | { type: 'watch'; userId: string; watching: boolean }
  | { type: 'camera'; on: boolean };

function channelsFrom(list: VoiceChannelState[]): Record<string, VoiceParticipant[]> {
  const out: Record<string, VoiceParticipant[]> = {};
  for (const c of list) if (c.participants.length > 0) out[c.channelId] = c.participants;
  return out;
}

type WelcomeFields = { serverId?: unknown; address?: unknown; self?: { userId?: unknown }; server?: { name?: unknown }; features?: unknown; voice?: unknown };

const welcomeFields = (welcome: unknown): WelcomeFields => (typeof welcome === 'object' && welcome !== null ? welcome : {}) as WelcomeFields;

/** The saved server a welcome belongs to, or null (none, or malformed). */
export function welcomeServerId(welcome: unknown): string | null {
  const id = welcomeFields(welcome).serverId;
  return typeof id === 'string' ? id : null;
}

function fromWelcome<T extends ServerVoice>(s: T, welcome: unknown): T {
  const w = welcomeFields(welcome);
  const voice = voiceWelcomeSchemaClient.safeParse(w.voice);
  return {
    ...s,
    serverId: typeof w.serverId === 'string' ? w.serverId : s.serverId,
    selfUserId: typeof w.self?.userId === 'string' ? w.self.userId : s.selfUserId,
    available: Array.isArray(w.features) && w.features.includes('voice'),
    channels: voice.success ? channelsFrom(voice.data) : {},
    serverName: typeof w.server?.name === 'string' ? w.server.name : s.serverName,
    address: typeof w.address === 'string' ? w.address : s.address,
  };
}

const NO_VOICE: ServerVoice = { serverId: null, selfUserId: null, available: false, channels: {}, serverName: '', address: null };

/** Just the per-server part of a state (what `view` holds). */
export function serverVoiceOf(s: ServerVoice): ServerVoice {
  const { serverId, selfUserId, available, channels, serverName, address } = s;
  return { serverId, selfUserId, available, channels, serverName, address };
}

/** voice.availability and voice.state on one server's snapshot. */
function applyEvent<T extends ServerVoice>(s: T, event: Envelope): T {
  if (event.t === 'welcome') return fromWelcome(s, event.d);
  if (event.t === 'voice.availability') {
    const parsed = voiceAvailabilitySchemaClient.safeParse(event.d);
    return !parsed.success || parsed.data.available === s.available ? s : { ...s, available: parsed.data.available };
  }
  if (event.t !== 'voice.state') return s;
  const parsed = voiceStateSchemaClient.safeParse(event.d);
  if (!parsed.success) return s;
  const { channelId, participants } = parsed.data;
  const channels = { ...s.channels };
  if (participants.length > 0) channels[channelId] = participants;
  else delete channels[channelId];
  return { ...s, channels };
}

/** Mute and deafen are the user's preference, kept across servers (Discord-like). */
function reset(s: VoiceState): VoiceState {
  return { ...initialVoiceState, selfMuted: s.selfMuted, selfDeafened: s.selfDeafened, globalPtt: s.globalPtt };
}

/**
 * The screen moved (chamada-continua §2). Without a call the runtime follows it, as before.
 * During one, the call's part stays as it is: another server's voice goes to `view`; coming
 * back to the call's server just drops `view` (its live state is never replaced by the
 * welcome the screen gets back).
 */
function onView(s: VoiceState, welcome: unknown): VoiceState {
  const id = welcomeServerId(welcome);
  if (s.call.status === 'idle') {
    if (id === null) return { ...reset(s), viewServerId: null };
    return { ...fromWelcome(id === s.serverId ? s : reset(s), welcome), view: null, viewServerId: id };
  }
  if (id === null || id === s.serverId) return s.view === null && s.viewServerId === id ? s : { ...s, view: null, viewServerId: id };
  return { ...s, view: fromWelcome(s.view?.serverId === id ? s.view : NO_VOICE, welcome), viewServerId: id };
}

/** The call ended: the runtime follows the screen again (the server on screen, or nothing on the Home screen). */
function afterCall(s: VoiceState): VoiceState {
  if (s.view !== null) return { ...s, ...serverVoiceOf(s.view), view: null };
  if (s.viewServerId === null && s.serverId !== null) return { ...reset(s), notice: s.notice };
  return s;
}

/** Pure reducer behind the voice store. */
export function voiceReducer(s: VoiceState, a: VoiceAction): VoiceState {
  switch (a.type) {
    case 'welcome': {
      // Outside a call the runtime's server is the one on screen.
      const next = fromWelcome(s, a.welcome);
      return s.call.status === 'idle' ? { ...next, viewServerId: next.serverId } : next;
    }
    case 'view':
      return onView(s, a.welcome);
    case 'serverEvent': {
      if (a.serverId === undefined || a.serverId === s.serverId) {
        return a.event.t === 'welcome' ? fromWelcome(s, a.event.d) : applyEvent(s, a.event);
      }
      if (s.view === null || a.serverId !== s.view.serverId) return s;
      const view = applyEvent(s.view, a.event);
      return view === s.view ? s : { ...s, view };
    }
    case 'reset':
      return reset(s);
    case 'call': {
      if (a.status === 'idle') {
        return afterCall({ ...s, call: { status: 'idle', channelId: null }, ...ROOM_CLEARED });
      }
      // A move to another channel (voice.forceMove, or a click) does not pass through idle:
      // the call stays on its server, only what belonged to the old room goes.
      const moved = s.call.channelId !== null && s.call.channelId !== a.channelId;
      return { ...s, call: { status: a.status, channelId: a.channelId }, ...(moved ? ROOM_CLEARED : {}) };
    }
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
    case 'camera':
      return s.camera === a.on ? s : { ...s, camera: a.on };
  }
}

/** What belongs to one LiveKit room and goes with it. */
const ROOM_CLEARED = { speaking: [], subscribed: [], pingMs: null, transmitting: false, sharing: null, watching: [], camera: false } satisfies Partial<VoiceState>;

const NOBODY: VoiceParticipant[] = [];

/** Who is in a voice channel (a stable empty list when nobody is). */
export function participantsOf(s: Pick<ServerVoice, 'channels'>, channelId: string): VoiceParticipant[] {
  return s.channels[channelId] ?? NOBODY;
}

/** The voice of the server on screen: its own during a call on another server, else the runtime's. */
export function viewVoice(s: VoiceState): ServerVoice {
  return s.view ?? s;
}

/** The saved server of the call (connecting included), or null without one. */
export function callServerId(s: VoiceState): string | null {
  return s.call.status === 'idle' ? null : s.serverId;
}

/** The call runs on a server that is not on screen (another one, or the Home screen). */
export function callElsewhere(s: VoiceState): boolean {
  return s.call.status !== 'idle' && s.serverId !== s.viewServerId;
}

/** My own entry in the channel I am in, as the server reports it (server mute lives here). */
export function selfVoice(s: VoiceState): VoiceParticipant | null {
  const { channelId } = s.call;
  if (!channelId || !s.selfUserId) return null;
  return participantsOf(s, channelId).find((p) => p.userId === s.selfUserId) ?? null;
}

const NOBODY_LIVE: string[] = [];

/** Who shares a screen in a voice channel, in the channel's order (from voice.state). */
export function liveIn(s: Pick<ServerVoice, 'channels'>, channelId: string): string[] {
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
