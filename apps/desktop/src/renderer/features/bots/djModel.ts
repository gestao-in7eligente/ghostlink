// The Ghost DJ's panel (v0.5.1, spec 2026-10-02-ghost-dj-som-e-equalizador §2), pure: the state
// from the server's events, who may control it, the position between events and the labels; and
// (v0.5.2) the owner's YouTube cookies line.
import {
  GHOST_DJ_COOKIES_MAX_BYTES,
  GHOST_DJ_EQ_LIMITS,
  ghostDjCookiesProblem,
  ghostDjStateSchemaClient,
  type Envelope,
  type GhostDjCookiesProblem,
  type GhostDjEq,
  type GhostDjState,
  type VoiceParticipant,
} from '@ghostlink/shared';
import type { MessageKey } from '../../i18n/index.js';

/** The DJ's state from a server event; null for any other event or a malformed one. */
export function djStateOf(event: Envelope): GhostDjState | null {
  if (event.t !== 'dj.state') return null;
  const parsed = ghostDjStateSchemaClient.safeParse(event.d);
  return parsed.success ? parsed.data : null;
}

/** The slash commands' rule, as the server checks it: the DJ is in a voice channel and so am I. */
export function canControlDj(state: GhostDjState | null, channels: Readonly<Record<string, readonly VoiceParticipant[]>>, selfUserId: string | null): boolean {
  if (!state?.channelId || selfUserId === null) return false;
  const here = Object.hasOwn(channels, state.channelId) ? channels[state.channelId]! : [];
  return here.some((p) => p.userId === selfUserId);
}

/** Seconds played now: counted on from when the state arrived while it plays, never past the end. */
export function djPosition(state: GhostDjState, receivedAt: number, now: number): number {
  if (!state.current) return 0;
  const at = state.paused ? state.positionSec : state.positionSec + Math.max(0, now - receivedAt) / 1_000;
  return state.current.durationSec === null ? at : Math.min(at, state.current.durationSec);
}

/** 3:07, or 1:02:03 past an hour. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** A band's frequency as people read it: 60 Hz, 910 Hz, 3,6 kHz (in the app's language). */
export function bandLabel(freq: number, locale: string): string {
  if (freq < 1_000) return `${freq} Hz`;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(freq / 1_000)} kHz`;
}

/** +3, 0, −5: a band's gain with its sign. */
export function formatGain(gain: number): string {
  return gain > 0 ? `+${gain}` : gain < 0 ? `−${-gain}` : '0';
}

/** The equalizer after one band was moved by hand: "Personalizado". */
export function withBand(eq: GhostDjEq, band: number, gain: number): GhostDjEq {
  const g = Math.max(GHOST_DJ_EQ_LIMITS.minGain, Math.min(GHOST_DJ_EQ_LIMITS.maxGain, Math.round(gain)));
  return { preset: 'custom', gains: eq.gains.map((v, i) => (i === band ? g : v)) };
}

/** "02/10": the day the YouTube cookies were sent, in the app's language. */
export function cookiesDate(setAt: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit' }).format(new Date(setAt));
}

/** What the cookies line says about a file that is not sent. */
export const COOKIES_PROBLEM_TEXT = {
  too_large: 'dj.cookies.tooLarge',
  format: 'dj.cookies.notNetscape',
  no_youtube: 'dj.cookies.noYoutube',
} as const satisfies Record<GhostDjCookiesProblem, MessageKey>;

/**
 * Why a picked cookies file is not sent (the server checks again): too large before it is read
 * (`content` null), then as yt-dlp would read it. Null: send it.
 */
export function cookiesFileProblem(size: number, content: string | null): GhostDjCookiesProblem | null {
  if (size > GHOST_DJ_COOKIES_MAX_BYTES) return 'too_large';
  return content === null ? null : ghostDjCookiesProblem(content);
}
