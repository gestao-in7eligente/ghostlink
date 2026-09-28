/**
 * Voice protocol (spec §5.2, §5.3, §8): payloads, events, strict server schemas
 * and lenient client schemas, plus the LiveKit room/identity naming.
 */
import { z } from 'zod';

/** One person in a voice channel, as every viewer of the channel sees them (spec §5.3). */
export interface VoiceParticipant {
  userId: string;
  /** Self mute from voice.selfState: display only (spec §8.3). */
  muted: boolean;
  /** Self deafen from voice.selfState: display only. */
  deafened: boolean;
  /** Publishing a camera track (v0.2 UI; the flag already follows LiveKit). */
  camera: boolean;
  /** Publishing a screen share (v0.2 UI). */
  screen: boolean;
  /** Muted by a moderator: LiveKit refuses the microphone (spec §8.3). */
  serverMuted: boolean;
}

/** `voice.state` event, and one entry of the welcome's `voice` field. */
export interface VoiceChannelState {
  channelId: string;
  participants: VoiceParticipant[];
}

/** An RTCIceServer as the renderer passes it to `rtcConfig.iceServers` (empty in v0.1, spec §4). */
export interface VoiceIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** `voice.join` response (spec §8.2). */
export interface VoiceJoinResponse {
  livekitUrl: string;
  token: string;
  iceServers: VoiceIceServer[];
}

/** `voice.forceMove` event: the client joins `toChannelId` by itself (spec §8.3). */
export interface VoiceForceMoveEvent {
  toChannelId: string;
}

export const VOICE_MODERATE_ACTIONS = ['mute', 'unmute', 'disconnect', 'move'] as const;
export type VoiceModerateAction = (typeof VOICE_MODERATE_ACTIONS)[number];

export interface VoiceModeratePayload {
  userId: string;
  action: VoiceModerateAction;
  toChannelId?: string;
}

export const VOICE_LIMITS = {
  /** `voice.join`: 5 every 10 s per user (spec §13). */
  joinPerWindow: 5,
  joinWindowMs: 10_000,
  /** The join token only has to reach LiveKit; LiveKit refreshes it afterwards (spec §8.2). */
  tokenTtlSeconds: 60,
} as const;

/** Channel ids are server-generated random base32 (spec §5.3); this bounds what a client may send. */
const CHANNEL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const USER_ID = /^[0-9a-f]{32}$/;
const ROOM_PREFIX = 'ch_';
const IDENTITY_PREFIX = 'u_';

export const voiceChannelIdSchema = z.string().regex(CHANNEL_ID);
const userIdSchema = z.string().regex(USER_ID);

/** LiveKit room of a voice channel: `ch_<channelId>` (spec §8.2). */
export function voiceRoomName(channelId: string): string {
  if (!CHANNEL_ID.test(channelId)) throw new Error('invalid channel id');
  return `${ROOM_PREFIX}${channelId}`;
}

/** The channel id of one of our rooms, or null for any other name. */
export function channelIdFromRoom(room: string): string | null {
  if (!room.startsWith(ROOM_PREFIX)) return null;
  const id = room.slice(ROOM_PREFIX.length);
  return CHANNEL_ID.test(id) ? id : null;
}

/** LiveKit participant identity of a user: `u_<userId>` (spec §8.2). */
export function voiceIdentity(userId: string): string {
  if (!USER_ID.test(userId)) throw new Error('invalid user id');
  return `${IDENTITY_PREFIX}${userId}`;
}

/** The user id of one of our identities, or null for anything else. */
export function userIdFromIdentity(identity: string): string | null {
  if (!identity.startsWith(IDENTITY_PREFIX)) return null;
  const id = identity.slice(IDENTITY_PREFIX.length);
  return USER_ID.test(id) ? id : null;
}

// ---- server side: strict (spec §5.1) ----

export const voiceJoinSchema = z.strictObject({ channelId: voiceChannelIdSchema });
export const voiceLeaveSchema = z.strictObject({});
export const voiceSelfStateSchema = z.strictObject({ muted: z.boolean(), deafened: z.boolean() });
export const voiceModerateSchema = z
  .strictObject({
    userId: userIdSchema,
    action: z.enum(VOICE_MODERATE_ACTIONS),
    toChannelId: voiceChannelIdSchema.optional(),
  })
  .refine((p) => (p.action === 'move') === (p.toChannelId !== undefined), {
    message: 'toChannelId is required for move and refused otherwise',
  });

// ---- client side: z.object drops unknown keys ----

const participantSchemaClient = z.object({
  userId: userIdSchema,
  muted: z.boolean(),
  deafened: z.boolean(),
  camera: z.boolean(),
  screen: z.boolean(),
  serverMuted: z.boolean(),
});

export const voiceStateSchemaClient: z.ZodType<VoiceChannelState> = z.object({
  channelId: voiceChannelIdSchema,
  participants: z.array(participantSchemaClient).max(1_000),
});

export const voiceWelcomeSchemaClient: z.ZodType<VoiceChannelState[]> = z.array(voiceStateSchemaClient).max(1_000);

const iceServerSchemaClient = z.object({
  urls: z.union([z.string().max(512), z.array(z.string().max(512)).max(8)]),
  username: z.string().max(512).optional(),
  credential: z.string().max(512).optional(),
});

export const voiceJoinResponseSchemaClient: z.ZodType<VoiceJoinResponse> = z.object({
  livekitUrl: z.string().min(1).max(512),
  token: z.string().min(1).max(8_192),
  iceServers: z.array(iceServerSchemaClient).max(16),
});

export const voiceForceMoveSchemaClient: z.ZodType<VoiceForceMoveEvent> = z.object({ toChannelId: voiceChannelIdSchema });
