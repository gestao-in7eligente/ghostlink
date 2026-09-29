import { LIMITS } from '@ghostlink/shared';

/** Limits only the server uses: the public port of proxy mode (spec §8.5, §13). */
export const SERVER_LIMITS = {
  /** A connection on the public port must send its first byte within this (TLS or ICE-TCP). */
  firstByteTimeoutMs: 5_000,
  /** ICE-TCP connections piped to LiveKit at once (a participant uses one or two). */
  maxIceTcpConnections: 1_024,
} as const;

/** Mutable copy of the shared LIMITS plus SERVER_LIMITS; tests override a few values through StartServerOptions.limits. */
export type ServerLimits = { -readonly [K in keyof typeof LIMITS | keyof typeof SERVER_LIMITS]: number };

export function resolveLimits(overrides?: Partial<ServerLimits>): ServerLimits {
  return { ...LIMITS, ...SERVER_LIMITS, ...overrides };
}
