// The owner's status query (spec 2026-10-01-servidores-acompanham-o-app-design.md §2): the
// owner's app asks a server it created on Railway whether anyone is in a voice call, so it
// updates the server only when nobody is. Signed with the owner's identity for that server.
import { z } from 'zod';
import { OWNER_STATUS_LABEL } from './constants.js';
import { toBase64Url, utf8 } from './encoding.js';
import { ProtocolError } from './errors.js';

/** GET /owner/status?ts=<unix seconds>&sig=<base64url Ed25519 signature>. */
export const OWNER_STATUS_PATH = '/owner/status';

export const OWNER_STATUS_LIMITS = {
  /** How far `ts` may be from the server's clock, either way. */
  maxSkewSeconds: 60,
  /** Requests per address per minute, answered or refused. */
  requestsPerMinute: 30,
} as const;

const B64U_32_BYTES = /^[A-Za-z0-9_-]{43}$/;

/**
 * The exact bytes the owner signs for GET /owner/status:
 * UTF-8 of "ghostlink-owner-status-v1\n" + serverKeyId + "\n" + ts (decimal unix seconds).
 * serverKeyId must be base64url of 32 bytes and ts a non-negative integer, so neither can
 * smuggle a '\n'; the serverKeyId binds the signature to one server (its TLS key).
 */
export function buildOwnerStatusMessage(serverKeyId: string, ts: number): Uint8Array {
  if (!B64U_32_BYTES.test(serverKeyId)) {
    throw new ProtocolError('BAD_REQUEST', 'serverKeyId must be base64url of 32 bytes');
  }
  if (!Number.isSafeInteger(ts) || ts < 0) throw new ProtocolError('BAD_REQUEST', 'ts must be a non-negative integer');
  return utf8(`${OWNER_STATUS_LABEL}\n${serverKeyId}\n${ts}`);
}

/** The path and query of a signed request: `/owner/status?ts=<ts>&sig=<base64url>`. */
export function ownerStatusPath(ts: number, signature: Uint8Array): string {
  if (!Number.isSafeInteger(ts) || ts < 0) throw new ProtocolError('BAD_REQUEST', 'ts must be a non-negative integer');
  return `${OWNER_STATUS_PATH}?ts=${ts}&sig=${toBase64Url(signature)}`;
}

/** The 200 answer. `voiceActive`: someone is in a voice channel (or about to connect to one). */
export interface OwnerStatus {
  version: string;
  voiceActive: boolean;
}

/** Client-side (lenient) schema of the 200 answer. */
export const ownerStatusSchemaClient = z.object({
  version: z.string().max(64),
  voiceActive: z.boolean(),
});
