import { isIPv4, isIPv6 } from 'node:net';

/**
 * Sliding-window counter: at most `limit` hits per `windowMs` per key, measured
 * with the injected clock. `hit` records only when allowed; `peek` never records.
 */
export class SlidingWindowLimiter {
  readonly #hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number,
  ) {}

  hit(key: string): boolean {
    const hits = this.#prune(key);
    if (hits.length >= this.limit) return false;
    hits.push(this.now());
    this.#hits.set(key, hits);
    return true;
  }

  peek(key: string): boolean {
    return this.#prune(key).length < this.limit;
  }

  /** Drops keys whose hits all left the window (call periodically to bound memory). */
  sweep(): void {
    for (const key of [...this.#hits.keys()]) this.#prune(key);
  }

  get size(): number {
    return this.#hits.size;
  }

  #prune(key: string): number[] {
    const hits = this.#hits.get(key) ?? [];
    const cutoff = this.now() - this.windowMs;
    let expired = 0;
    while (expired < hits.length && hits[expired]! <= cutoff) expired++;
    if (expired > 0) hits.splice(0, expired);
    if (hits.length === 0) this.#hits.delete(key);
    return hits;
  }
}

function ipv6Groups(address: string): number[] | null {
  let canonical: string;
  try {
    canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1); // also turns a dotted IPv4 tail into hex
  } catch {
    return null;
  }
  const [head, tail] = canonical.includes('::') ? canonical.split('::') : [canonical, undefined];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return groups.length === 8 ? groups.map((g) => parseInt(g, 16)) : null;
}

/** How the server tells clients apart for its per-address limits and IP bans (spec §13). */
export interface ClientAddressing {
  /** The rate-limit key of a socket's remote address. */
  keyOf(address: string): string;
  /** false behind a TCP proxy: the address is the proxy's, so it is neither stored (last_ip) nor banned. */
  readonly real: boolean;
}

/** The key every client shares behind a TCP proxy that hides their addresses. */
export const SHARED_ADDRESS_KEY = 'proxy';

/** Direct connections: one key per address (IPv6 per /64). */
export const PER_ADDRESS: ClientAddressing = { keyOf: (address) => ipKey(address), real: true };

/** Behind a TCP proxy (spec §8.6): everyone arrives from the proxy, so everyone shares one key. */
export const SHARED_ADDRESS: ClientAddressing = { keyOf: () => SHARED_ADDRESS_KEY, real: false };

/**
 * Rate-limit key for a remote address: IPv4 as-is, IPv4-mapped IPv6 as its IPv4,
 * and native IPv6 grouped by /64 (one subscriber usually owns a whole /64).
 */
export function ipKey(ip: string): string {
  let s = ip.trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (isIPv4(s)) return s;
  if (isIPv6(s)) {
    const g = ipv6Groups(s);
    if (g) {
      if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
        return [g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff].join('.');
      }
      return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
    }
  }
  return s;
}
