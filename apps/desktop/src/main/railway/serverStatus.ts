// What the owner's app asks a Railway server it created (spec 2026-10-01 §2, §3): GET /health
// (its version, public) and the signed GET /owner/status (whether anyone is in a call, owner
// only). Both go over TLS pinned to the managed record's serverKeyId (pinnedHttp.ts). The
// signed URL is never logged nor put in an error.
import { z } from 'zod';
import { ProtocolError, toBase64Url, utf8 } from '@ghostlink/shared';
import { AppError } from '../../shared/appErrors.js';
import type { ServerKey } from '../identity.js';
import { parseJson, pinnedRequest, type PinnedResponse, type PinnedTarget } from '../pinnedHttp.js';

export const STATUS_REQUEST_TIMEOUT_MS = 15_000;
/** Both answers are a few dozen bytes. */
const MAX_ANSWER_BYTES = 16 * 1024;
const B64U_32_BYTES = /^[A-Za-z0-9_-]{43}$/;

export interface ServerHealth {
  version: string;
}

export interface OwnerStatus {
  version: string;
  /** Someone is in a voice channel. */
  voiceActive: boolean;
}

const healthSchema = z.object({ version: z.string().min(1).max(64) });
const ownerStatusSchema = z.object({ version: z.string().max(64), voiceActive: z.boolean() });

/**
 * The exact bytes the owner signs for /owner/status: UTF-8 of
 * "ghostlink-owner-status-v1\n" + serverKeyId + "\n" + ts (unix seconds, decimal).
 */
export function buildOwnerStatusMessage(serverKeyId: string, ts: number): Uint8Array {
  if (!B64U_32_BYTES.test(serverKeyId)) throw new ProtocolError('BAD_REQUEST', 'serverKeyId must be base64url of 32 bytes');
  if (!Number.isSafeInteger(ts) || ts < 0) throw new ProtocolError('BAD_REQUEST', 'ts must be a non-negative integer');
  return utf8(`ghostlink-owner-status-v1\n${serverKeyId}\n${ts}`);
}

export interface StatusRequestOptions {
  timeoutMs?: number;
  /** The local clock in ms (tests). */
  now?: () => number;
}

/** GET /health: the version the server runs. */
export async function fetchHealth(server: PinnedTarget, opts: StatusRequestOptions = {}): Promise<ServerHealth> {
  const res = await pinnedRequest(server, { method: 'GET', path: '/health', maxResponseBytes: MAX_ANSWER_BYTES, timeoutMs: opts.timeoutMs ?? STATUS_REQUEST_TIMEOUT_MS });
  if (res.status !== 200) throw statusError(res);
  const health = healthSchema.safeParse(parseJson(res.body));
  if (!health.success) throw new ProtocolError('BAD_REQUEST', 'invalid /health answer');
  return { version: health.data.version };
}

/**
 * GET /owner/status?ts=&sig=, signed with my identity for this server. FORBIDDEN when the server
 * does not take the signature (not the owner any more, another identity, or the clocks differ by
 * more than 60 s).
 */
export async function fetchOwnerStatus(server: PinnedTarget, key: Pick<ServerKey, 'sign'>, opts: StatusRequestOptions = {}): Promise<OwnerStatus> {
  const ts = Math.floor((opts.now ?? Date.now)() / 1000);
  const sig = toBase64Url(key.sign(buildOwnerStatusMessage(server.serverKeyId, ts)));
  const res = await pinnedRequest(server, {
    method: 'GET',
    path: `/owner/status?ts=${ts}&sig=${sig}`,
    maxResponseBytes: MAX_ANSWER_BYTES,
    timeoutMs: opts.timeoutMs ?? STATUS_REQUEST_TIMEOUT_MS,
  });
  if (res.status !== 200) throw statusError(res);
  const status = ownerStatusSchema.safeParse(parseJson(res.body));
  if (!status.success) throw new ProtocolError('BAD_REQUEST', 'invalid /owner/status answer');
  return { version: status.data.version, voiceActive: status.data.voiceActive };
}

function statusError(res: PinnedResponse): Error {
  switch (res.status) {
    case 403:
      return new ProtocolError('FORBIDDEN');
    case 404:
      // A server older than v0.2.2 has no /owner/status.
      return new ProtocolError('NOT_FOUND');
    case 429:
      return new ProtocolError('RATE_LIMITED');
    default:
      return new AppError('UNREACHABLE', `HTTP ${res.status}`);
  }
}
