// The pencil's state (spec 2026-10-01-lapis-na-tela-design.md): whether the server has it, the
// shares where "Permitir desenhos" is off, and which share my pencil is on. A pure reducer; the
// voice store says who is in the call, who shares and what I watch.
import { create } from 'zustand';
import { FEATURE_SCREEN_DRAW, screenDrawWelcomeSchemaClient } from '@ghostlink/shared';
import type { VoiceState } from '../voice/state.js';

/** What the pencil reads from the voice store. */
export type VoiceView = Pick<VoiceState, 'selfUserId' | 'call' | 'channels' | 'unwatched' | 'sharing'>;

export interface DrawState {
  /** The server relays strokes (`screenDraw` in welcome.features, spec §1). */
  available: boolean;
  /** shareKey()s of the shares where drawing is off. */
  off: readonly string[];
  /** The sharer whose screen my pencil draws on, or null. */
  pencil: string | null;
}

export const initialDrawState: DrawState = { available: false, off: [], pencil: null };

export type DrawAction =
  | { type: 'welcome'; welcome: unknown }
  | { type: 'allow'; channelId: string; sharerId: string; allow: boolean }
  | { type: 'pencil'; sharerId: string | null; voice: VoiceView }
  | { type: 'voice'; voice: VoiceView };

export const shareKey = (channelId: string, sharerId: string): string => `${channelId}:${sharerId}`;

function sharing(v: VoiceView, channelId: string, userId: string): boolean {
  return (v.channels[channelId] ?? []).some((p) => p.userId === userId && p.screen);
}

/**
 * Whether I may draw on `sharerId`'s screen now (spec §2): the server has the pencil, I am in the
 * call, drawing is on for that share, and it is my own live share or one I watch.
 */
export function canDraw(d: Pick<DrawState, 'available' | 'off'>, v: VoiceView, sharerId: string): boolean {
  const channelId = v.call.channelId;
  if (!d.available || !channelId || v.call.status !== 'connected' || !v.selfUserId) return false;
  if (d.off.includes(shareKey(channelId, sharerId))) return false;
  if (sharerId === v.selfUserId) return v.sharing !== null;
  return !v.unwatched.includes(sharerId) && sharing(v, channelId, sharerId);
}

/** Whether drawing is on for my own share (the "Permitir desenhos" switch). */
export function ownShareAllowed(d: Pick<DrawState, 'off'>, v: VoiceView): boolean {
  const channelId = v.call.channelId;
  return !channelId || !v.selfUserId || !d.off.includes(shareKey(channelId, v.selfUserId));
}

function fromWelcome(welcome: unknown): DrawState {
  const w = (typeof welcome === 'object' && welcome !== null ? welcome : {}) as { features?: unknown; screenDraw?: unknown };
  const available = Array.isArray(w.features) && w.features.includes(FEATURE_SCREEN_DRAW);
  const parsed = screenDrawWelcomeSchemaClient.safeParse(w.screenDraw);
  const off = available && parsed.success ? parsed.data.disallowed.map((s) => shareKey(s.channelId, s.sharerId)) : [];
  return { available, off: [...new Set(off)], pencil: null };
}

export function drawReducer(s: DrawState, a: DrawAction): DrawState {
  switch (a.type) {
    case 'welcome':
      return fromWelcome(a.welcome);
    case 'allow': {
      const key = shareKey(a.channelId, a.sharerId);
      const has = s.off.includes(key);
      if (a.allow !== has) return s;
      // Turned off: my pencil on that share goes too ("o lápis some", spec §5).
      return a.allow
        ? { ...s, off: s.off.filter((k) => k !== key) }
        : { ...s, off: [...s.off, key], pencil: s.pencil === a.sharerId ? null : s.pencil };
    }
    case 'pencil':
      if (a.sharerId !== null && !canDraw(s, a.voice, a.sharerId)) return s.pencil === null ? s : { ...s, pencil: null };
      return s.pencil === a.sharerId ? s : { ...s, pencil: a.sharerId };
    case 'voice': {
      // A share that ended forgets "off" (the next one starts allowed); a pencil whose share I no longer show goes.
      const off = s.off.filter((key) => {
        const i = key.lastIndexOf(':');
        return sharing(a.voice, key.slice(0, i), key.slice(i + 1));
      });
      const pencil = s.pencil !== null && canDraw({ ...s, off }, a.voice, s.pencil) ? s.pencil : null;
      return off.length === s.off.length && pencil === s.pencil ? s : { ...s, off, pencil };
    }
  }
}

interface DrawStore extends DrawState {
  dispatch(action: DrawAction): void;
}

export const useDrawStore = create<DrawStore>()((set) => ({
  ...initialDrawState,
  dispatch: (action) => set((s) => drawReducer(s, action)),
}));
