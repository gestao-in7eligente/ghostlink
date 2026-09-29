import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseJoinInput } from '@ghostlink/shared';
import type { LocalAddress } from '../../src/net/addresses.js';
import { NET_MODULE, createNetModule, type NetModule, type NetModuleOptions } from '../../src/net/netModule.js';
import { discoverGateway } from '../../src/net/upnp.js';
import { startFakeIgd, type FakeIgd, type FakeIgdOptions } from '../helpers/fakeIgd.js';
import { startTestServer, type TestServer } from '../helpers/testClient.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const LAN: LocalAddress[] = [
  { ip: '192.168.0.10', interface: 'Ethernet', kind: 'lan' },
  { ip: '26.1.2.3', interface: 'Radmin VPN', kind: 'radmin' },
];

async function igd(opts: FakeIgdOptions = {}): Promise<FakeIgd> {
  const fake = await startFakeIgd(opts);
  cleanups.push(() => fake.close());
  return fake;
}

async function serverWith(opts: NetModuleOptions): Promise<{ t: TestServer; net: NetModule }> {
  const net = createNetModule({ localAddresses: () => LAN, ...opts });
  const t = await startTestServer({ modules: [net] });
  cleanups.push(() => t.cleanup());
  return { t, net };
}

function viaFake(fake: FakeIgd): Pick<NetModuleOptions, 'discover'> {
  return { discover: () => discoverGateway({ ssdpAddress: '127.0.0.1', ssdpPort: fake.ssdpPort, interfaces: ['127.0.0.1'], timeoutMs: 1_500 }) };
}

describe('net module: public addresses (spec §3.5)', () => {
  it('advertises the local addresses when it manages them (bind all)', async () => {
    const { t, net } = await serverWith({ manageAddresses: true, bindHost: '0.0.0.0' });
    await net.ready();
    const port = t.server.port;
    expect(t.server.info().publicAddresses).toEqual([`192.168.0.10:${port}`, `26.1.2.3:${port}`]);
    expect(net.status()).toMatchObject({ upnp: { state: 'off' }, cgnat: false, nodeIp: '192.168.0.10', localAddresses: LAN });
    const invite = parseJoinInput(t.server.createInvite().pasteCode);
    expect(invite.kind === 'invite' && invite.invite.addresses).toEqual([`192.168.0.10:${port}`, `26.1.2.3:${port}`]);
  });

  it('leaves public_addresses alone when it does not manage them (CLI --public-address)', async () => {
    const net = createNetModule({ localAddresses: () => LAN, manageAddresses: false, bindHost: '0.0.0.0' });
    const t = await startTestServer({ modules: [net], publicAddresses: ['example.com:7700'] });
    cleanups.push(() => t.cleanup());
    await net.ready();
    expect(t.server.info().publicAddresses).toEqual(['example.com:7700']);
  });

  it('follows interface changes on refresh', async () => {
    let local = LAN;
    const { t, net } = await serverWith({ manageAddresses: true, bindHost: '0.0.0.0', localAddresses: () => local });
    await net.ready();
    local = [{ ip: '10.0.0.7', interface: 'Wi-Fi', kind: 'lan' }];
    await net.refresh();
    expect(t.server.info().publicAddresses).toEqual([`10.0.0.7:${t.server.port}`]);
  });

  it('advertises nothing on loopback and never runs UPnP there', async () => {
    const discover = vi.fn(async () => null);
    const { t, net } = await serverWith({ manageAddresses: true, bindHost: '127.0.0.1', upnp: true, discover });
    await net.ready();
    expect(discover).not.toHaveBeenCalled();
    expect(net.status().upnp.state).toBe('off');
    expect(t.server.info().publicAddresses).toEqual([]);
  });
});

describe('net module: UPnP (spec §8.5)', () => {
  it('maps the server port and the media ports, puts a public WAN first, and unmaps on close', async () => {
    const fake = await igd();
    const { t, net } = await serverWith({
      manageAddresses: true,
      bindHost: '0.0.0.0',
      upnp: true,
      mediaPorts: [{ protocol: 'UDP', port: 7882 }, { protocol: 'TCP', port: 7881 }],
      ...viaFake(fake),
    });
    await net.ready();
    const port = t.server.port;
    expect(net.status()).toMatchObject({
      upnp: {
        state: 'mapped',
        wanIp: '203.0.113.7',
        mappings: [
          { protocol: 'TCP', port, ok: true, leaseSeconds: 7200 },
          { protocol: 'UDP', port: 7882, ok: true, leaseSeconds: 7200 },
          { protocol: 'TCP', port: 7881, ok: true, leaseSeconds: 7200 },
        ],
      },
      cgnat: false,
      nodeIp: '203.0.113.7',
    });
    expect(t.server.info().publicAddresses).toEqual([`203.0.113.7:${port}`, `192.168.0.10:${port}`, `26.1.2.3:${port}`]);
    expect(fake.mappings.size).toBe(3);

    await t.server.close();
    expect(fake.mappings.size).toBe(0);
  });

  it('flags CGNAT / double NAT and keeps that WAN out of the invites', async () => {
    const fake = await igd({ externalIp: '100.72.1.1' });
    const { t, net } = await serverWith({ manageAddresses: true, bindHost: '0.0.0.0', upnp: true, ...viaFake(fake) });
    await net.ready();
    expect(net.status()).toMatchObject({ upnp: { wanIp: '100.72.1.1' }, cgnat: true, nodeIp: '192.168.0.10' });
    expect(t.server.info().publicAddresses).toEqual([`192.168.0.10:${t.server.port}`, `26.1.2.3:${t.server.port}`]);
  });

  it('reports a router without UPnP as unavailable (the server still runs)', async () => {
    const { net } = await serverWith({ manageAddresses: true, bindHost: '0.0.0.0', upnp: true, discover: async () => null });
    await net.ready();
    expect(net.status().upnp).toEqual({ state: 'unavailable', wanIp: null, mappings: [] });
  });

  it('reports partial mappings (a port taken by another computer)', async () => {
    const fake = await igd({ conflicts: ['UDP:7882'] });
    const { net } = await serverWith({ manageAddresses: true, bindHost: '0.0.0.0', upnp: true, mediaPorts: [{ protocol: 'UDP', port: 7882 }], ...viaFake(fake) });
    await net.ready();
    expect(net.status().upnp.state).toBe('partial');
    expect(net.status().upnp.mappings[1]).toEqual({ protocol: 'UDP', port: 7882, ok: false, error: 'conflict' });
  });

  it('an explicit node IP wins over the WAN (CLI --node-ip)', async () => {
    const fake = await igd();
    const { net } = await serverWith({ manageAddresses: true, bindHost: '0.0.0.0', upnp: true, nodeIp: '198.51.100.9', ...viaFake(fake) });
    await net.ready();
    expect(net.nodeIp()).toBe('198.51.100.9');
  });

  it('refuses an explicit node IP that is not IPv4', () => {
    expect(() => createNetModule({ nodeIp: 'example.com' })).toThrow(/node IP/);
  });

  it('closing while UPnP is still searching does not hang and leaves nothing mapped', async () => {
    const fake = await igd();
    let release!: () => void;
    const { t, net } = await serverWith({
      manageAddresses: true,
      bindHost: '0.0.0.0',
      upnp: true,
      discover: async () => {
        await new Promise<void>((r) => {
          release = r;
        });
        return viaFake(fake).discover!();
      },
    });
    expect(net.status().upnp.state).toBe('searching');
    const closing = t.server.close();
    release();
    await closing;
    expect(fake.mappings.size).toBe(0);
  });

  it('is registered under the name "net"', () => {
    expect(createNetModule({}).name).toBe(NET_MODULE);
  });
});
