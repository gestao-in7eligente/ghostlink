// The Ghost DJ's panel (v0.5.1, spec 2026-10-02-ghost-dj-som-e-equalizador §2), pure: the state
// from the server's events, who may control it, the position between events and the labels.
import { GHOST_DJ_EQ_LIMITS, ghostDjStateSchemaClient, type Envelope, type GhostDjEq, type GhostDjState, type VoiceParticipant } from '@ghostlink/shared';

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
