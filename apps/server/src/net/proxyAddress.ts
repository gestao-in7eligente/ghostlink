// The node_ip behind a TCP proxy (spec §8.6): LiveKit announces the proxy's IPv4, so ICE-TCP
// goes to the proxy, which forwards it to our public port. The proxy is known by a host name
// (Railway: <name>.proxy.rlwy.net), resolved at start and again every few minutes; the voice
// module compares it with what LiveKit announces and restarts LiveKit once nobody is in voice.
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIPv4, isIPv6 } from 'node:net';
import type { Logger } from '../logger.js';
import type { NodeIpChoice } from './addresses.js';

/** How often the proxy's name is resolved again. */
export const PROXY_REFRESH_MS = 5 * 60_000;

export interface ProxyAddressOptions {
  /** The proxy's host (a name, or an IP literal). */
  host: string;
  /** Every IP address of `host` (test seam). Default: the system resolver, like any connection would use. */
  lookup?: (host: string) => Promise<string[]>;
  refreshMs?: number;
  logger: Logger;
}

async function systemLookup(host: string): Promise<string[]> {
  return (await dnsLookup(host, { all: true, family: 4 })).map((a) => a.address);
}

/** The IPv4 LiveKit announces behind a TCP proxy, kept up to date. */
export class ProxyAddress {
  readonly #opts: ProxyAddressOptions;
  #ip: string | null = null;
  #first: Promise<void> | null = null;
  #timer: NodeJS.Timeout | null = null;
  #warned = false;

  constructor(opts: ProxyAddressOptions) {
    this.#opts = opts;
    if (isIPv4(opts.host)) this.#ip = opts.host;
  }

  /** Resolves now, then every refreshMs until stop(). */
  start(): void {
    this.#first = this.refresh();
    if (isIPv4(this.#opts.host) || isIPv6(this.#opts.host)) return; // nothing will ever change
    this.#timer = setInterval(() => void this.refresh(), this.#opts.refreshMs ?? PROXY_REFRESH_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Settles once the first resolution finished (with or without an answer). */
  ready(): Promise<void> {
    return this.#first ?? Promise.resolve();
  }

  /** The proxy's IPv4, or null while it has none (not resolved yet, or no IPv4 at all). */
  nodeIpChoice(): NodeIpChoice | null {
    return this.#ip === null ? null : { ip: this.#ip, source: 'proxy', host: this.#opts.host };
  }

  /** Resolves the proxy's name again. A failure keeps the last good IP. */
  async refresh(): Promise<void> {
    const { host, logger } = this.#opts;
    if (isIPv4(host)) return;
    if (isIPv6(host)) {
      if (!this.#warned) logger.warn(`the TCP proxy ${host} has no IPv4 address; voice needs one to announce (use --node-ip)`);
      this.#warned = true;
      return;
    }
    let ips: string[];
    try {
      ips = (await (this.#opts.lookup ?? systemLookup)(host)).filter((ip) => isIPv4(ip));
    } catch (e) {
      logger.warn(`voice: could not resolve the TCP proxy ${host}`, { error: e instanceof Error ? e.message : String(e), keeping: this.#ip });
      return;
    }
    if (ips.length === 0) {
      logger.warn(`voice: the TCP proxy ${host} has no IPv4 address`, { keeping: this.#ip });
      return;
    }
    // A name with several addresses must not flap between them: each change restarts LiveKit.
    if (this.#ip === null || !ips.includes(this.#ip)) this.#ip = ips[0]!;
  }
}
