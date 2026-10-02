import { z } from 'zod';

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

// ---- the Ghost DJ's panel (spec 2026-10-02-ghost-dj-som-e-equalizador-design.md §2, v0.5.1) ----

/**
 * welcome.features: this server answers `dj.state`, `dj.eq`, `dj.volume` and `dj.control` and
 * sends the `dj.state` event (the panel on the Ghost DJ's page). Older servers have no panel.
 */
export const FEATURE_GHOST_DJ_PANEL = 'ghostDjPanel';

/** The equalizer's bands (Hz), low to high. */
export const GHOST_DJ_EQ_BANDS = [60, 230, 910, 3_600, 14_000] as const;

/** Each band's gain: whole dB from -12 to +12. */
export const GHOST_DJ_EQ_LIMITS = { minGain: -12, maxGain: 12 } as const;

/** The presets, in the order the panel shows them; gains per band, low to high. */
export const GHOST_DJ_EQ_PRESETS = {
  default: [0, 0, 0, 0, 0],
  bass: [6, 4, 0, 0, 0],
  pop: [-1, 2, 4, 2, -1],
  rock: [4, 2, -2, 2, 4],
  voice: [-3, -1, 3, 4, 1],
  electronic: [5, 3, 0, 2, 4],
} as const satisfies Record<string, readonly number[]>;

export type GhostDjEqPreset = keyof typeof GHOST_DJ_EQ_PRESETS;
export const GHOST_DJ_EQ_PRESET_IDS = Object.keys(GHOST_DJ_EQ_PRESETS) as GhostDjEqPreset[];

/** The equalizer: a preset, or `custom` once a band was moved by hand. Saved per server. */
export interface GhostDjEq {
  preset: GhostDjEqPreset | 'custom';
  /** One gain per band of GHOST_DJ_EQ_BANDS. */
  gains: number[];
}

/** A track as the panel shows it. */
export interface GhostDjTrackView {
  title: string;
  url: string;
  durationSec: number | null;
  /** Who asked for it (a member id) and their name then. */
  requestedBy: string;
  requesterName: string;
}

export type GhostDjLoop = 'off' | 'track' | 'queue';

/**
 * What the Ghost DJ is doing: the `dj.state` answer and event. Whoever cannot see its voice
 * channel gets it without the channel and the tracks (as if it were in none); the equalizer is
 * the server's.
 */
export interface GhostDjState {
  /** The voice channel it is in, or null. */
  channelId: string | null;
  current: GhostDjTrackView | null;
  /** Seconds of `current` played when this state was sent (the app counts on while it plays). */
  positionSec: number;
  paused: boolean;
  /** 0 to 100. */
  volume: number;
  loop: GhostDjLoop;
  /** The next tracks (the first GHOST_DJ_PANEL_NEXT) and how many wait in all. */
  next: GhostDjTrackView[];
  queueLength: number;
  eq: GhostDjEq;
}

/** How many of the next tracks the state lists. */
export const GHOST_DJ_PANEL_NEXT = 10;

export const GHOST_DJ_CONTROL_ACTIONS = ['pause', 'resume', 'skip', 'stop'] as const;
export type GhostDjControlAction = (typeof GHOST_DJ_CONTROL_ACTIONS)[number];

/**
 * Requests (each answers the new GhostDjState). Changing anything follows the slash commands'
 * rule: only someone in the DJ's voice channel (FORBIDDEN otherwise, and while it is in none);
 * NOT_FOUND for pause, resume or skip with nothing playing.
 * - `dj.state` {}: read it (anyone).
 * - `dj.eq` { preset } or { gains }: a preset, or the five gains by hand (the preset becomes `custom`).
 * - `dj.volume` { volume }: 0 to 100 (as /volume).
 * - `dj.control` { action }: pause, resume, skip or stop (stop: it leaves the channel).
 */
export type GhostDjEqPayload = { preset: GhostDjEqPreset } | { gains: number[] };
export interface GhostDjVolumePayload {
  volume: number;
}
export interface GhostDjControlPayload {
  action: GhostDjControlAction;
}

const eqGainSchema = z.number().int().min(GHOST_DJ_EQ_LIMITS.minGain).max(GHOST_DJ_EQ_LIMITS.maxGain);
const eqGainsSchema = z.array(eqGainSchema).length(GHOST_DJ_EQ_BANDS.length);
const presetSchema = z.enum(GHOST_DJ_EQ_PRESET_IDS as [GhostDjEqPreset, ...GhostDjEqPreset[]]);

// ---- server side: strict ----

export const ghostDjStateRequestSchema = z.strictObject({});
export const ghostDjEqSchema = z.union([z.strictObject({ preset: presetSchema }), z.strictObject({ gains: eqGainsSchema })]);
export const ghostDjVolumeSchema = z.strictObject({ volume: z.number().int().min(0).max(100) });
export const ghostDjControlSchema = z.strictObject({ action: z.enum(GHOST_DJ_CONTROL_ACTIONS) });
/** The stored equalizer (the server's own data, read back). */
export const ghostDjEqStoredSchema = z.strictObject({ preset: z.union([presetSchema, z.literal('custom')]), gains: eqGainsSchema });

// ---- client side: lenient ----

const clampedGain = z
  .number()
  .catch(0)
  .transform((g) => Math.max(GHOST_DJ_EQ_LIMITS.minGain, Math.min(GHOST_DJ_EQ_LIMITS.maxGain, Math.round(g))));

export const ghostDjEqSchemaClient: z.ZodType<GhostDjEq> = z.object({
  preset: z.union([presetSchema, z.literal('custom')]).catch('custom'),
  gains: z
    .array(clampedGain)
    .max(16)
    .transform((g) => GHOST_DJ_EQ_BANDS.map((_, i) => g[i] ?? 0)),
});

export const ghostDjTrackViewSchemaClient: z.ZodType<GhostDjTrackView> = z.object({
  title: z.string().max(1_000),
  url: z.string().max(2_048),
  durationSec: z.number().nonnegative().nullable().catch(null),
  requestedBy: z.string().max(64),
  requesterName: z.string().max(200),
});

export const ghostDjStateSchemaClient: z.ZodType<GhostDjState> = z.object({
  channelId: z.string().max(64).nullable(),
  current: ghostDjTrackViewSchemaClient.nullable().catch(null),
  positionSec: z.number().nonnegative().catch(0),
  paused: z.boolean().catch(false),
  volume: z.number().min(0).max(100).catch(50),
  loop: z.enum(['off', 'track', 'queue']).catch('off'),
  next: z.array(ghostDjTrackViewSchemaClient).max(100).catch([]),
  queueLength: z.number().int().nonnegative().catch(0),
  eq: ghostDjEqSchemaClient,
});
