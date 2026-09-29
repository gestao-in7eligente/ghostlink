import { describe, expect, it } from 'vitest';
import type { HostNetwork } from '../../src/shared/hostTypes.js';
import { firewallLine, networkLines } from '../../src/renderer/features/host/hostNetworkModel.js';

function net(patch: Partial<Omit<HostNetwork, 'upnp'>> & { upnp?: Partial<HostNetwork['upnp']> } = {}): HostNetwork {
  return {
    cgnat: false,
    nodeIp: '192.168.0.10',
    lanIp: '192.168.0.10',
    ...patch,
    upnp: { state: 'mapped', wanIp: '203.0.113.7', mappings: [], ...patch.upnp },
  };
}

const keys = (lines: ReturnType<typeof networkLines>) => lines.map((l) => l.key);

describe('networkLines (spec §8.5)', () => {
  it('mapped: says so and shows the WAN IP, no forwarding help', () => {
    expect(networkLines(net(), 7700, [])).toEqual([
      { tone: 'ok', key: 'host.net.upnp.mapped' },
      { tone: 'info', key: 'host.net.wan', vars: { ip: '203.0.113.7' } },
    ]);
  });

  it('no UPnP: explains port forwarding to this LAN IP, and the VPN/VPS alternatives', () => {
    expect(networkLines(net({ upnp: { state: 'unavailable', wanIp: null } }), 7710, [])).toEqual([
      { tone: 'warning', key: 'host.net.upnp.unavailable' },
      { tone: 'info', key: 'host.net.forward', vars: { port: 7710, lanIp: '192.168.0.10' } },
    ]);
    expect(keys(networkLines(net({ lanIp: null, upnp: { state: 'failed', wanIp: null } }), 7700, []))).toEqual(['host.net.upnp.failed', 'host.net.forwardNoLan']);
  });

  it('partial: lists the ports that failed', () => {
    const lines = networkLines(
      net({ upnp: { state: 'partial', mappings: [{ protocol: 'TCP', port: 7700, ok: true }, { protocol: 'UDP', port: 7882, ok: false, error: 'conflict' }] } }),
      7700,
      [],
    );
    expect(lines[0]).toEqual({ tone: 'warning', key: 'host.net.upnp.partial', vars: { ports: 'UDP 7882' } });
    expect(keys(lines)).toContain('host.net.forward');
  });

  it('CGNAT comes first, hides the WAN line and the (useless) forwarding help', () => {
    const lines = networkLines(net({ cgnat: true, upnp: { state: 'mapped', wanIp: '100.72.1.1' } }), 7700, []);
    expect(lines[0]).toEqual({ tone: 'warning', key: 'host.net.cgnat', vars: { ip: '100.72.1.1' } });
    expect(keys(lines)).not.toContain('host.net.wan');
    expect(keys(networkLines(net({ cgnat: true, upnp: { state: 'failed', wanIp: '10.0.0.2' } }), 7700, []))).not.toContain('host.net.forward');
  });

  it('warns about media ports another program holds, even before the network is known', () => {
    expect(networkLines(null, null, ['UDP 7882', 'TCP 7881'])).toEqual([{ tone: 'warning', key: 'host.net.mediaBusy', vars: { ports: 'UDP 7882, TCP 7881' } }]);
  });
});

describe('firewallLine', () => {
  it.each([
    ['allowed', 'host.firewall.allowed', false],
    ['blocked', 'host.firewall.blocked', true],
    ['missing', 'host.firewall.missing', true],
    ['off', 'host.firewall.off', false],
    ['unknown', 'host.firewall.unknown', true],
  ] as const)('%s → %s (fix offered: %s)', (state, key, offerFix) => {
    expect(firewallLine({ state, activeProfiles: ['Public'] }, 'rede pública')).toMatchObject({ line: { key }, offerFix });
  });

  it('says nothing outside Windows and "checking" before the first answer', () => {
    expect(firewallLine({ state: 'unsupported', activeProfiles: [] }, '')).toBeNull();
    expect(firewallLine(null, '')).toEqual({ line: { tone: 'info', key: 'host.firewall.checking' }, offerFix: false });
  });
});
