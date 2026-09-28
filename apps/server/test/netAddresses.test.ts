import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  buildPublicAddresses,
  classifyIPv4,
  isCgnatOrPrivate,
  localIPv4Addresses,
  resolveNodeIp,
  type LocalAddress,
} from '../src/net/addresses.js';

function v4(address: string, internal = false): NetworkInterfaceInfo {
  return { address, netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal, cidr: `${address}/24` };
}

function v6(address: string): NetworkInterfaceInfo {
  return { address, netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '00:00:00:00:00:00', internal: false, cidr: `${address}/64`, scopeid: 0 };
}

describe('classifyIPv4 (spec §8.5)', () => {
  it.each([
    ['192.168.0.10', 'Ethernet', 'lan'],
    ['10.1.2.3', 'Wi-Fi', 'lan'],
    ['172.16.0.1', 'eth0', 'lan'],
    ['172.31.255.254', 'eth0', 'lan'],
    ['26.10.20.30', 'Radmin VPN', 'radmin'],
    ['100.64.0.1', 'Tailscale', 'tailscale'],
    ['100.127.255.254', 'tailscale0', 'tailscale'],
    ['10.147.17.5', 'ZeroTier One [8056c2e21c000001]', 'zerotier'],
    ['172.22.1.1', 'ztabcdef12', 'zerotier'],
    ['203.0.113.7', 'ens3', 'public'],
  ] as const)('%s on %s is %s', (ip, iface, kind) => {
    expect(classifyIPv4(ip, iface)).toBe(kind);
  });

  it.each(['127.0.0.1', '127.1.2.3', '169.254.10.20', '0.0.0.0', '255.255.255.255', '224.0.0.1', 'not-an-ip', '300.1.1.1', '1.2.3'])(
    'skips %s (loopback, link-local, multicast or invalid)',
    (ip) => {
      expect(classifyIPv4(ip, 'eth0')).toBeNull();
    },
  );

  it.each([
    ['54.232.189.113', 'Topaz Loopback'],
    ['217.216.91.34', 'Loopback Pseudo-Interface 1'],
  ])('skips %s on %s (a loopback adapter, even with a public-looking IP)', (ip, iface) => {
    expect(classifyIPv4(ip, iface)).toBeNull();
  });

  it.each([
    ['192.168.51.1', 'VMware Network Adapter VMnet8'],
    ['172.26.160.1', 'vEthernet (WSL (Hyper-V firewall))'],
    ['192.168.56.1', 'VirtualBox Host-Only Network'],
    ['172.17.0.1', 'docker0'],
  ])('marks %s on %s as virtual (never advertised)', (ip, iface) => {
    expect(classifyIPv4(ip, iface)).toBe('virtual');
  });

  it('does not mistake 172.32/12 neighbours or 100.128 for private or Tailscale ranges', () => {
    expect(classifyIPv4('172.32.0.1', 'eth0')).toBe('public');
    expect(classifyIPv4('100.128.0.1', 'eth0')).toBe('public');
    expect(classifyIPv4('25.255.255.255', 'eth0')).toBe('public');
  });
});

describe('localIPv4Addresses', () => {
  it('keeps external IPv4 only, classified, deduplicated, LAN first', () => {
    const found = localIPv4Addresses({
      'Loopback Pseudo-Interface 1': [v4('127.0.0.1', true)],
      Tailscale: [v4('100.101.102.103'), v6('fd7a:115c:a1e0::1')],
      'Radmin VPN': [v4('26.1.2.3')],
      'VMware Network Adapter VMnet1': [v4('192.168.119.1')],
      'Topaz Loopback': [v4('54.232.189.113')],
      Ethernet: [v4('192.168.0.10'), v6('fe80::1'), v4('169.254.1.1')],
      'Wi-Fi': [v4('192.168.0.10')],
    });
    expect(found).toEqual<LocalAddress[]>([
      { ip: '192.168.0.10', interface: 'Ethernet', kind: 'lan' },
      { ip: '26.1.2.3', interface: 'Radmin VPN', kind: 'radmin' },
      { ip: '100.101.102.103', interface: 'Tailscale', kind: 'tailscale' },
      { ip: '192.168.119.1', interface: 'VMware Network Adapter VMnet1', kind: 'virtual' },
    ]);
  });

  it('accepts the numeric family some Node versions report and survives missing entries', () => {
    const numeric = { ...v4('10.0.0.5'), family: 4 } as unknown as NetworkInterfaceInfo;
    expect(localIPv4Addresses({ eth0: [numeric], empty: undefined })).toEqual([{ ip: '10.0.0.5', interface: 'eth0', kind: 'lan' }]);
  });

  it('reads the real interfaces by default without throwing', () => {
    expect(Array.isArray(localIPv4Addresses())).toBe(true);
  });
});

describe('isCgnatOrPrivate (spec §8.1: CGNAT or double NAT)', () => {
  it.each(['100.64.0.1', '100.100.1.1', '10.0.0.1', '192.168.1.1', '172.20.0.1'])('%s means CGNAT or double NAT', (ip) => {
    expect(isCgnatOrPrivate(ip)).toBe(true);
  });
  it.each(['203.0.113.7', '8.8.8.8', '100.128.0.1', '26.1.2.3'])('%s is a usable public WAN', (ip) => {
    expect(isCgnatOrPrivate(ip)).toBe(false);
  });
});

const local: LocalAddress[] = [
  { ip: '192.168.0.10', interface: 'Ethernet', kind: 'lan' },
  { ip: '26.1.2.3', interface: 'Radmin VPN', kind: 'radmin' },
  { ip: '100.101.102.103', interface: 'Tailscale', kind: 'tailscale' },
];

describe('buildPublicAddresses (spec §3.5)', () => {
  it('never advertises virtual adapters', () => {
    const withVirtual: LocalAddress[] = [{ ip: '192.168.51.1', interface: 'VMware Network Adapter VMnet8', kind: 'virtual' }, ...local];
    expect(buildPublicAddresses({ port: 7700, local: withVirtual })).toEqual(['192.168.0.10:7700', '26.1.2.3:7700', '100.101.102.103:7700']);
    expect(resolveNodeIp({ local: withVirtual })).toBe('192.168.0.10');
    expect(resolveNodeIp({ local: withVirtual.slice(0, 1) })).toBeNull();
  });

  it('puts a real WAN first, then LAN, then VPNs', () => {
    expect(buildPublicAddresses({ port: 7700, wanIp: '203.0.113.7', local })).toEqual([
      '203.0.113.7:7700',
      '192.168.0.10:7700',
      '26.1.2.3:7700',
      '100.101.102.103:7700',
    ]);
  });

  it('leaves a CGNAT or double-NAT WAN out', () => {
    expect(buildPublicAddresses({ port: 7710, wanIp: '100.72.1.1', local })).toEqual(['192.168.0.10:7710', '26.1.2.3:7710', '100.101.102.103:7710']);
    expect(buildPublicAddresses({ port: 7710, wanIp: '192.168.100.2', local: [] })).toEqual([]);
  });

  it('puts an interface that holds a public IP (a VPS) before the LAN, deduplicates and keeps at most 8', () => {
    const many: LocalAddress[] = [
      ...Array.from({ length: 10 }, (_, i) => ({ ip: `10.0.0.${i + 1}`, interface: `eth${i}`, kind: 'lan' as const })),
      { ip: '198.51.100.4', interface: 'ens3', kind: 'public' },
    ];
    const out = buildPublicAddresses({ port: 7700, wanIp: '198.51.100.4', local: many });
    expect(out).toHaveLength(8);
    expect(out[0]).toBe('198.51.100.4:7700');
    expect(new Set(out).size).toBe(8);
  });

  it('ignores a malformed WAN answer', () => {
    expect(buildPublicAddresses({ port: 7700, wanIp: '<html>', local: local.slice(0, 1) })).toEqual(['192.168.0.10:7700']);
  });
});

describe('resolveNodeIp (spec §8.1: explicit > UPnP WAN > LAN)', () => {
  it('prefers the explicit value, then a public WAN, then the LAN', () => {
    expect(resolveNodeIp({ explicit: '198.51.100.9', wanIp: '203.0.113.7', local })).toBe('198.51.100.9');
    expect(resolveNodeIp({ wanIp: '203.0.113.7', local })).toBe('203.0.113.7');
    expect(resolveNodeIp({ wanIp: null, local })).toBe('192.168.0.10');
  });

  it('falls back to the LAN when the WAN is CGNAT, and to a VPN when there is no LAN', () => {
    expect(resolveNodeIp({ wanIp: '100.64.3.3', local })).toBe('192.168.0.10');
    expect(resolveNodeIp({ local: local.slice(1) })).toBe('26.1.2.3');
    expect(resolveNodeIp({ local: [] })).toBeNull();
  });

  it('rejects an explicit value that is not an IPv4 address', () => {
    expect(() => resolveNodeIp({ explicit: 'example.com', local })).toThrow(/node IP/);
  });
});
