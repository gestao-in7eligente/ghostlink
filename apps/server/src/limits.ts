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

/**
 * spec §13 behind a TCP proxy that hides client addresses (spec §8.6): every client arrives
 * from the proxy, so the per-address limits act on the whole server and are sized for it.
 * Brute force stays impractical: invite codes have 50 bits, scrypt runs two at a time, and
 * members sign in with their key alone (never locked out by the failure limit).
 */
export const SHARED_ADDRESS_LIMITS = {
  maxSocketsPerIp: LIMITS.maxSockets,
  maxConnectionsPerIp: LIMITS.maxUnauthenticatedConnections,
  pendingChallengesPerIp: LIMITS.maxUnauthenticatedConnections,
  authFailuresPerIpPerMinute: 100,
  newIdentitiesPerIpPerHour: 30,
} as const satisfies Partial<ServerLimits>;

export function resolveLimits(overrides?: Partial<ServerLimits>, o: { sharedAddress?: boolean } = {}): ServerLimits {
  return { ...LIMITS, ...SERVER_LIMITS, ...(o.sharedAddress ? SHARED_ADDRESS_LIMITS : {}), ...overrides };
}
