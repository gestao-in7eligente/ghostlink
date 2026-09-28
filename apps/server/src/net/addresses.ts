// Address detection for hosting (spec §3.5, §8.1, §8.5). Pure functions over
// os.networkInterfaces(): no packet is sent and no external service is asked.
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { LIMITS, formatHostPort } from '@ghostlink/shared';

/**
 * `public` = a routable IP sitting directly on an interface (typically a VPS).
 * `virtual` = a VM/container host adapter (VMware, Hyper-V/WSL, VirtualBox, Docker):
 * reachable only from this machine's VMs, so it is listed but never advertised.
 */
export type LocalAddressKind = 'public' | 'lan' | 'radmin' | 'tailscale' | 'zerotier' | 'virtual';

export interface LocalAddress {
  ip: string;
  interface: string;
  kind: LocalAddressKind;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function toInt(ip: string): number | null {
  const m = IPV4.exec(ip);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i]);
    if (octet > 255) return null;
    n = n * 256 + octet;
  }
  return n;
}

function inRange(n: number, base: string, bits: number): boolean {
  const size = 2 ** (32 - bits);
  const start = toInt(base)!;
  return n >= start && n < start + size;
}

function isRfc1918(n: number): boolean {
  return inRange(n, '10.0.0.0', 8) || inRange(n, '172.16.0.0', 12) || inRange(n, '192.168.0.0', 16);
}

const ZEROTIER_INTERFACE = /zerotier|^zt[0-9a-z]+$/i;
/** Loopback adapters can carry public-looking IPs (e.g. banking "Topaz Loopback"): never usable. */
const LOOPBACK_INTERFACE = /loopback|pseudo-interface/i;
const VIRTUAL_INTERFACE = /vmware|vmnet|virtualbox|vbox|hyper-v|vethernet|wsl|docker|^br-|^veth|^virbr|^lxc|^lxd|^cni|^flannel/i;

/**
 * What kind of address `ip` is, or null for addresses nobody else can use
 * (loopback, link-local, unspecified, multicast/broadcast, malformed).
 * ZeroTier is recognized by the interface name (its ranges overlap RFC 1918),
 * Radmin by 26.0.0.0/8 and Tailscale by 100.64.0.0/10.
 */
export function classifyIPv4(ip: string, interfaceName: string): LocalAddressKind | null {
  const n = toInt(ip);
  if (n === null) return null;
  if (inRange(n, '0.0.0.0', 8) || inRange(n, '127.0.0.0', 8) || inRange(n, '169.254.0.0', 16) || n >= toInt('224.0.0.0')!) return null;
  if (LOOPBACK_INTERFACE.test(interfaceName)) return null;
  if (ZEROTIER_INTERFACE.test(interfaceName)) return 'zerotier';
  if (VIRTUAL_INTERFACE.test(interfaceName)) return 'virtual';
  if (inRange(n, '26.0.0.0', 8)) return 'radmin';
  if (inRange(n, '100.64.0.0', 10)) return 'tailscale';
  if (isRfc1918(n)) return 'lan';
  return 'public';
}

const KIND_ORDER: readonly LocalAddressKind[] = ['public', 'lan', 'radmin', 'tailscale', 'zerotier', 'virtual'];

/** External IPv4 addresses of this machine, deduplicated, ordered public → LAN → Radmin → Tailscale → ZeroTier. */
export function localIPv4Addresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): LocalAddress[] {
  const found: LocalAddress[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      // Node reported family as a number (4) in some 18.x releases.
      const family: unknown = entry.family;
      if (entry.internal || (family !== 'IPv4' && family !== 4)) continue;
      const kind = classifyIPv4(entry.address, name);
      if (kind !== null && !found.some((f) => f.ip === entry.address)) found.push({ ip: entry.address, interface: name, kind });
    }
  }
  return found.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

/** A WAN IP in 100.64.0.0/10 or RFC 1918 means CGNAT or double NAT: nobody outside can reach it (spec §8.1). */
export function isCgnatOrPrivate(wanIp: string): boolean {
  const n = toInt(wanIp);
  return n !== null && (inRange(n, '100.64.0.0', 10) || isRfc1918(n));
}

function usableWan(wanIp: string | null | undefined): string | null {
  return wanIp && toInt(wanIp) !== null && classifyIPv4(wanIp, '') === 'public' ? wanIp : null;
}

/**
 * `server_meta.public_addresses` for Host mode (spec §3.5, §8.5): the WAN IP
 * first when it is really public, then the LAN, then the VPNs; canonical
 * `host:port`, deduplicated, at most LIMITS.inviteMaxAddresses.
 */
export function buildPublicAddresses(input: { port: number; wanIp?: string | null; local: readonly LocalAddress[] }): string[] {
  const ips = [usableWan(input.wanIp), ...input.local.filter((l) => l.kind !== 'virtual').map((l) => l.ip)].filter(
    (ip): ip is string => ip !== null,
  );
  const out: string[] = [];
  for (const ip of ips) {
    const address = formatHostPort(ip, input.port);
    if (!out.includes(address)) out.push(address);
  }
  return out.slice(0, LIMITS.inviteMaxAddresses);
}

/**
 * The IP LiveKit announces as `node_ip` (spec §8.1): an explicit value, else the
 * UPnP WAN IP when it is not CGNAT, else the first local address (LAN before VPNs).
 */
export function resolveNodeIp(input: { explicit?: string | null; wanIp?: string | null; local: readonly LocalAddress[] }): string | null {
  if (input.explicit) {
    if (toInt(input.explicit) === null) throw new Error(`the node IP must be an IPv4 address, got "${input.explicit}"`);
    return input.explicit;
  }
  return usableWan(input.wanIp) ?? input.local.find((l) => l.kind !== 'virtual')?.ip ?? null;
}
