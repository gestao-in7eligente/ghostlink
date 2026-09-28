import { createHmac, timingSafeEqual } from 'node:crypto';
import { channelIdFromRoom, userIdFromIdentity } from '@ghostlink/shared';

/** What the /rtc proxy needs from a LiveKit access token. */
export interface VoiceTokenClaims {
  userId: string;
  channelId: string;
}

/** Largest token we are willing to look at (LiveKit tokens are well under 2 KB). */
const MAX_TOKEN_LENGTH = 8_192;
/** Clock skew tolerated on exp/nbf, in seconds. */
const LEEWAY_SECONDS = 10;

function decodeJson(part: string): Record<string, unknown> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Verifies a LiveKit access token for the /rtc proxy (spec §4): HS256 only, signed with
 * our apiSecret, issued for our apiKey, inside exp/nbf, joining one of our rooms as one
 * of our identities. Accepts LiveKit's own refresh tokens (same sub and video.room,
 * signed with the same secret); no GhostLink-specific claim is required.
 * Returns null for anything else — never throws.
 */
export function verifyVoiceToken(token: string, opts: { apiKey: string; apiSecret: string; nowMs: number }): VoiceTokenClaims | null {
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = decodeJson(headerPart);
  if (!header || header.alg !== 'HS256' || (header.typ !== undefined && header.typ !== 'JWT') || header.crit !== undefined) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(signaturePart)) return null;
  const expected = createHmac('sha256', opts.apiSecret).update(`${headerPart}.${payloadPart}`).digest();
  const given = Buffer.from(signaturePart, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  const claims = decodeJson(payloadPart);
  if (!claims || claims.iss !== opts.apiKey) return null;
  const now = Math.floor(opts.nowMs / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + LEEWAY_SECONDS <= now) return null;
  if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf - LEEWAY_SECONDS > now)) return null;
  const video = claims.video;
  if (typeof video !== 'object' || video === null) return null;
  const { roomJoin, room } = video as { roomJoin?: unknown; room?: unknown };
  if (roomJoin !== true || typeof room !== 'string' || typeof claims.sub !== 'string') return null;
  const userId = userIdFromIdentity(claims.sub);
  const channelId = channelIdFromRoom(room);
  if (!userId || !channelId) return null;
  return { userId, channelId };
}
