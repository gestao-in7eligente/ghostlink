import { randomBytes } from 'node:crypto';

export type ChallengeTake =
  | { ok: true; nonce: string }
  | { ok: false; reason: 'missing' | 'expired' };

interface Pending {
  nonce: string;
  ipKey: string;
  expiresAt: number;
}

/**
 * One nonce per connection: 32 random bytes, single use, expires after `ttlMs`
 * of the injected clock. Also enforces the pending-challenges-per-IP limit.
 */
export class ChallengeStore {
  readonly #byConnection = new Map<string, Pending>();
  readonly #pendingPerIp = new Map<string, number>();

  constructor(private readonly opts: { ttlMs: number; maxPendingPerIp: number; now: () => number }) {}

  /** Returns the new nonce, or null when this IP already has too many pending challenges. */
  issue(connectionId: string, ipKey: string): string | null {
    if (this.#byConnection.has(connectionId)) throw new Error(`connection ${connectionId} already has a challenge`);
    const pending = this.#pendingPerIp.get(ipKey) ?? 0;
    if (pending >= this.opts.maxPendingPerIp) return null;
    const nonce = randomBytes(32).toString('base64url');
    this.#byConnection.set(connectionId, { nonce, ipKey, expiresAt: this.opts.now() + this.opts.ttlMs });
    this.#pendingPerIp.set(ipKey, pending + 1);
    return nonce;
  }

  /** Removes and returns the connection's nonce; a nonce can be taken at most once. */
  take(connectionId: string): ChallengeTake {
    const entry = this.#byConnection.get(connectionId);
    if (!entry) return { ok: false, reason: 'missing' };
    this.drop(connectionId);
    if (this.opts.now() > entry.expiresAt) return { ok: false, reason: 'expired' };
    return { ok: true, nonce: entry.nonce };
  }

  /** Forgets the connection's challenge (called when the socket closes). */
  drop(connectionId: string): void {
    const entry = this.#byConnection.get(connectionId);
    if (!entry) return;
    this.#byConnection.delete(connectionId);
    const left = (this.#pendingPerIp.get(entry.ipKey) ?? 1) - 1;
    if (left > 0) this.#pendingPerIp.set(entry.ipKey, left);
    else this.#pendingPerIp.delete(entry.ipKey);
  }

  pendingFor(ipKey: string): number {
    return this.#pendingPerIp.get(ipKey) ?? 0;
  }

  get size(): number {
    return this.#byConnection.size;
  }
}
