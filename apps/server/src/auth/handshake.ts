import { randomBytes } from 'node:crypto';
import {
  PROTOCOL,
  ProtocolError,
  authProofSchema,
  buildAuthMessage,
  fromBase64Url,
  helloSchema,
  negotiateProtocol,
  normalizeNickname,
  type Envelope,
  type ErrorCode,
  type HelloPayload,
} from '@ghostlink/shared';
import type { Db } from '../db/database.js';
import type { ServerLimits } from '../limits.js';
import type { Logger } from '../logger.js';
import type { SlidingWindowLimiter } from '../ratelimit/limiter.js';
import { ConnectionClosedError, type Connection } from '../ws/connection.js';
import { admit } from './admission.js';
import type { ChallengeStore } from './challenges.js';
import { isWeakPublicKey, userIdFromPublicKey, verifyAuthSignature } from './identity.js';

export interface AuthedSession {
  userId: string;
  sessionId: string;
  nickname: string;
  isOwner: boolean;
  fileToken: string;
  locale: string;
}

export interface HandshakeDeps {
  db: Db;
  dataDir: string;
  serverKeyId: string;
  limits: ServerLimits;
  now: () => number;
  challenges: ChallengeStore;
  authFailures: SlidingWindowLimiter;
  newIdentities: SlidingWindowLimiter;
  logger: Logger;
}

/** Thrown after the connection was already closed with `code`. */
export class HandshakeFailed extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
    this.name = 'HandshakeFailed';
  }
}

/**
 * hello → challenge → auth.proof → admission (spec §3.3). Resolves with the
 * session once the identity is admitted; otherwise closes the connection with
 * the matching error code and rejects with HandshakeFailed. Credential failures
 * (bad input, bad signature, expired challenge, bad password/invite/setup code,
 * ban, deadline) count toward the per-IP auth-failure limit; successes never do.
 */
export async function runHandshake(conn: Connection, deps: HandshakeDeps): Promise<AuthedSession> {
  const fail = (code: ErrorCode, opts: { counts: boolean; extra?: { min: number; max: number } }): HandshakeFailed => {
    if (opts.counts) {
      deps.authFailures.hit(conn.ipKey);
      deps.logger.warn('authentication failed', { ip: conn.ip, code }); // spec §7: IPs are logged only for auth failures
    }
    deps.challenges.drop(conn.id);
    conn.close(code, opts.extra);
    return new HandshakeFailed(code);
  };

  const next = async (): Promise<Envelope> => {
    try {
      return await conn.nextEnvelope();
    } catch (e) {
      if (e instanceof ProtocolError) throw fail('BAD_REQUEST', { counts: true });
      if (e instanceof ConnectionClosedError) throw new HandshakeFailed('BAD_REQUEST');
      throw e;
    }
  };

  // ---- hello ----
  conn.setDeadline(deps.limits.helloTimeoutMs, () => fail('BAD_REQUEST', { counts: true }));
  const helloEnvelope = await next();
  if (!deps.authFailures.peek(conn.ipKey)) throw fail('RATE_LIMITED', { counts: false });
  if (helloEnvelope.t !== 'hello') throw fail('BAD_REQUEST', { counts: true });
  const parsed = helloSchema.safeParse(helloEnvelope.d);
  if (!parsed.success) throw fail('BAD_REQUEST', { counts: true });
  const hello: HelloPayload = parsed.data;
  if (!negotiateProtocol(hello.protocol, PROTOCOL)) {
    throw fail('PROTOCOL_UNSUPPORTED', { counts: false, extra: { min: PROTOCOL.min, max: PROTOCOL.max } });
  }
  let publicKey: Uint8Array;
  let nickname: { display: string; norm: string };
  try {
    publicKey = fromBase64Url(hello.publicKey);
    nickname = normalizeNickname(hello.nickname);
  } catch {
    throw fail('BAD_REQUEST', { counts: true });
  }
  if (publicKey.length !== 32 || isWeakPublicKey(publicKey)) throw fail('BAD_REQUEST', { counts: true });

  const nonce = deps.challenges.issue(conn.id, conn.ipKey);
  if (nonce === null) throw fail('RATE_LIMITED', { counts: false });
  conn.state = 'awaiting-proof';
  conn.send({ t: 'challenge', d: { nonce, serverKeyId: deps.serverKeyId } });

  // ---- auth.proof ----
  conn.setDeadline(deps.limits.proofTimeoutMs, () => fail('CHALLENGE_EXPIRED', { counts: true }));
  const proofEnvelope = await next();
  if (proofEnvelope.t !== 'auth.proof') throw fail('BAD_REQUEST', { counts: true });
  const proof = authProofSchema.safeParse(proofEnvelope.d);
  if (!proof.success) throw fail('BAD_REQUEST', { counts: true });
  const challenge = deps.challenges.take(conn.id);
  if (!challenge.ok) throw fail('CHALLENGE_EXPIRED', { counts: true });
  const message = buildAuthMessage(deps.serverKeyId, challenge.nonce);
  if (!verifyAuthSignature(publicKey, message, fromBase64Url(proof.data.signature))) {
    throw fail('BAD_SIGNATURE', { counts: true });
  }

  // ---- membership ----
  // The proof arrived in time; admission is server-side work (bounded by the scrypt queue).
  conn.clearDeadline();
  const userId = userIdFromPublicKey(publicKey);
  const result = await admit(
    {
      userId,
      publicKey,
      nickname,
      locale: hello.locale,
      ip: conn.ip,
      ipKey: conn.ipKey,
      password: hello.password,
      inviteCode: hello.inviteCode,
      setupCode: hello.setupCode,
    },
    { db: deps.db, dataDir: deps.dataDir, now: deps.now, newIdentities: deps.newIdentities },
  );
  // Re-check after the await (spec §5.1): the socket may have closed while scrypt ran.
  if (conn.closed) throw new HandshakeFailed('BAD_REQUEST');
  if (!result.ok) throw fail(result.code, { counts: result.countsAsFailure });

  conn.state = 'authenticated';
  return {
    userId: result.user.id,
    sessionId: randomBytes(16).toString('base64url'),
    nickname: result.user.nickname,
    isOwner: result.user.isOwner,
    fileToken: randomBytes(32).toString('base64url'),
    locale: hello.locale,
  };
}
