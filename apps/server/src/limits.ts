import { LIMITS } from '@ghostlink/shared';

/** Mutable copy of the shared LIMITS; tests override a few values through StartServerOptions.limits. */
export type ServerLimits = { -readonly [K in keyof typeof LIMITS]: number };

export function resolveLimits(overrides?: Partial<ServerLimits>): ServerLimits {
  return { ...LIMITS, ...overrides };
}
