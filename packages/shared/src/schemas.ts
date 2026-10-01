import { z } from 'zod';
import { ERROR_CODES } from './errors.js';
import type { AuthProofPayload, ChallengePayload, HelloPayload, WelcomePayload } from './protocol.js';

/** base64url (no padding) of exactly `bytes` bytes. */
function b64u(bytes: number) {
  return z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((bytes * 4) / 3)}}$`));
}

const errorCodeClient = z.enum(ERROR_CODES).catch('INTERNAL');

// ---- server side: strict, unknown keys are an error (spec §5.1) ----

export const helloSchema: z.ZodType<HelloPayload> = z.strictObject({
  protocol: z.number().int(),
  publicKey: b64u(32),
  nickname: z.string().min(1).max(64),
  locale: z.string().max(16).regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,3}$/),
  password: z.string().min(1).max(256).optional(),
  inviteCode: z.string().min(1).max(64).optional(),
  setupCode: z.string().min(1).max(64).optional(),
  client: z.string().min(1).max(128),
});

export const authProofSchema: z.ZodType<AuthProofPayload> = z.strictObject({
  signature: b64u(64),
});

export const envelopeSchema = z.object({
  t: z.string().max(64),
  id: z.number().int().nonnegative().optional(),
  d: z.unknown().optional(),
});

// ---- client side: z.object strips unknown keys; unknown error codes become INTERNAL ----

export const challengeSchemaClient: z.ZodType<ChallengePayload> = z.object({
  nonce: b64u(32),
  serverKeyId: b64u(32),
});

export const welcomeSchemaClient: z.ZodType<WelcomePayload> = z.object({
  self: z.object({
    userId: z.string().regex(/^[0-9a-f]{32}$/),
    nickname: z.string().min(1).max(256),
    isOwner: z.boolean(),
  }),
  sessionId: z.string().min(1).max(128),
  serverTime: z.number(),
  server: z.object({
    name: z.string().max(256),
    version: z.string().max(64),
    joinMode: z.enum(['open', 'password', 'invite']),
    serverKeyId: b64u(32),
  }),
  features: z.array(z.string().max(64)).max(256),
  fileToken: z.string().min(1).max(256),
  protocol: z.object({ min: z.number().int(), max: z.number().int() }),
});

export const resSchemaClient = z.discriminatedUnion('ok', [
  z.object({ t: z.literal('res'), id: z.number().int().nonnegative(), ok: z.literal(true), d: z.unknown() }),
  z.object({
    t: z.literal('res'),
    id: z.number().int().nonnegative(),
    ok: z.literal(false),
    error: z.object({ code: errorCodeClient, message: z.string().max(1024) }),
  }),
]);

export const errorEventSchemaClient = z.object({
  t: z.literal('error'),
  d: z.object({
    code: errorCodeClient,
    min: z.number().int().optional(),
    max: z.number().int().optional(),
    /** SERVER_DELETING: the deadline, ms epoch. */
    at: z.number().int().nonnegative().optional(),
  }),
});
