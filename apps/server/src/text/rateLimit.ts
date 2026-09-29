import { SlidingWindowLimiter } from '../ratelimit/limiter.js';

/**
 * Token bucket: `capacity` tokens, one more every `refillMs`. `msg.send` uses it
 * for "5 every 5 s with a burst of 10" (spec §13): capacity 10, refill 1 s.
 */
export class TokenBucket {
  readonly #buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillMs: number,
    private readonly now: () => number,
  ) {}

  take(key: string): boolean {
    const t = this.now();
    const b = this.#buckets.get(key) ?? { tokens: this.capacity, at: t };
    const refilled = Math.min(this.capacity, b.tokens + Math.max(0, t - b.at) / this.refillMs);
    if (refilled < 1) {
      this.#buckets.set(key, { tokens: refilled, at: t });
      return false;
    }
    this.#buckets.set(key, { tokens: refilled - 1, at: t });
    return true;
  }

  /** Forgets keys whose bucket is full again (bounded memory). */
  sweep(): void {
    const t = this.now();
    for (const [key, b] of this.#buckets) {
      if (b.tokens + (t - b.at) / this.refillMs >= this.capacity) this.#buckets.delete(key);
    }
  }
}

/** Per-user limits of the text module (spec §13). Tests may shrink them. */
export interface TextRateLimits {
  msgSendBurst: number;
  msgSendRefillMs: number;
  typingPerWindow: number;
  typingWindowMs: number;
  reactPerWindow: number;
  reactWindowMs: number;
  profilePerWindow: number;
  profileWindowMs: number;
  invitePerWindow: number;
  inviteWindowMs: number;
}

export const DEFAULT_TEXT_RATE_LIMITS: TextRateLimits = {
  msgSendBurst: 10,
  msgSendRefillMs: 1_000,
  typingPerWindow: 1,
  typingWindowMs: 3_000,
  reactPerWindow: 10,
  reactWindowMs: 5_000,
  profilePerWindow: 5,
  profileWindowMs: 60_000,
  invitePerWindow: 10,
  inviteWindowMs: 3_600_000,
};

export class TextLimiters {
  readonly msgSend: TokenBucket;
  readonly typing: SlidingWindowLimiter;
  readonly react: SlidingWindowLimiter;
  readonly profile: SlidingWindowLimiter;
  readonly invite: SlidingWindowLimiter;

  constructor(limits: TextRateLimits, now: () => number) {
    this.msgSend = new TokenBucket(limits.msgSendBurst, limits.msgSendRefillMs, now);
    this.typing = new SlidingWindowLimiter(limits.typingPerWindow, limits.typingWindowMs, now);
    this.react = new SlidingWindowLimiter(limits.reactPerWindow, limits.reactWindowMs, now);
    this.profile = new SlidingWindowLimiter(limits.profilePerWindow, limits.profileWindowMs, now);
    this.invite = new SlidingWindowLimiter(limits.invitePerWindow, limits.inviteWindowMs, now);
  }

  sweep(): void {
    this.msgSend.sweep();
    this.typing.sweep();
    this.react.sweep();
    this.profile.sweep();
    this.invite.sweep();
  }
}
