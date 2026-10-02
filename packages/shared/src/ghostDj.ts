/**
 * Ghost DJ (spec 2026-10-02-ghost-dj-design.md): the music bot every server has. It is a system
 * bot (`BotInfo.system`, `BotProfile.system`): the server creates it, it has no connection code
 * and it cannot be deleted. Its slash commands go through the ordinary `interaction.invoke`; the
 * server answers them itself. The app needs nothing else from this file but the flag.
 */

/**
 * The `features` flag of a server whose Ghost DJ can play: ffmpeg is installed and LiveKit
 * (voice) runs. Without it the DJ's member and commands may still be listed, and its commands
 * answer that it is unavailable.
 */
export const FEATURE_GHOST_DJ = 'ghostDj';

/** `BotInfo.system` / `BotProfile.system` of the Ghost DJ's member. */
export const GHOST_DJ_SYSTEM_KIND = 'ghost-dj';

export const GHOST_DJ_LIMITS = {
  /** Tracks waiting in the queue (the one playing not counted). */
  maxQueue: 100,
  /** Items taken from one playlist link. */
  maxPlaylistItems: 50,
  /** Longer videos are skipped (and a playback is cut there whatever its stated length). */
  maxTrackSeconds: 3 * 3_600,
  /** `/volume`: 0 to 100; a new session starts at 50. */
  defaultVolume: 50,
  /** It leaves after this long without playing (nothing queued, or paused). */
  idleLeaveMs: 5 * 60_000,
  /** It leaves once nobody else has been in its voice channel for this long. */
  aloneLeaveMs: 15_000,
  /** The "Tocando agora" panel lists this many of the next tracks. */
  panelNext: 3,
  /** `/play busca`: the longest text or link taken. */
  queryMax: 500,
} as const;
