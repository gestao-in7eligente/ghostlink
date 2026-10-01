import type { ErrorCode } from './errors.js';

export type Envelope = { t: string; id?: number; d?: unknown };
export type ResOk<T = unknown> = { t: 'res'; id: number; ok: true; d: T };
export type ResErr = { t: 'res'; id: number; ok: false; error: { code: ErrorCode; message: string } };
/**
 * Extra fields of an `error` event: `min`/`max` with PROTOCOL_UNSUPPORTED, `at` (the deletion
 * deadline, ms epoch) with SERVER_DELETING.
 */
export interface ErrorEventExtra {
  min?: number;
  max?: number;
  at?: number;
}
export type ServerErrorEvent = { t: 'error'; d: { code: ErrorCode } & ErrorEventExtra };
export type JoinMode = 'open' | 'password' | 'invite';

export interface HelloPayload {
  protocol: number;
  publicKey: string; // b64url raw 32B
  nickname: string;
  locale: string;
  password?: string;
  inviteCode?: string;
  setupCode?: string;
  client: string;
}

export interface ChallengePayload {
  nonce: string; // b64url 32B
  serverKeyId: string;
}

export interface AuthProofPayload {
  signature: string; // b64url 64B
}

export interface WelcomePayload {
  self: { userId: string; nickname: string; isOwner: boolean };
  sessionId: string;
  serverTime: number; // ms epoch
  server: { name: string; version: string; joinMode: JoinMode; serverKeyId: string };
  features: string[];
  fileToken: string; // main process strips it before forwarding to the renderer
  protocol: { min: number; max: number };
}
