import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PortMapper,
  UPNP_LEASE_SECONDS,
  UpnpClient,
  UpnpError,
  discoverGateway,
  parseDescription,
  parseSsdpResponse,
  type DiscoverOptions,
} from '../src/net/upnp.js';
import { startFakeIgd, type FakeIgd, type FakeIgdOptions } from './helpers/fakeIgd.js';

const igds: FakeIgd[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const igd of igds.splice(0)) await igd.close();
});

async function igd(opts: FakeIgdOptions = {}): Promise<FakeIgd> {
  const fake = await startFakeIgd(opts);
  igds.push(fake);
  return fake;
}

function at(fake: FakeIgd, extra: DiscoverOptions = {}): DiscoverOptions {
  return { ssdpAddress: '127.0.0.1', ssdpPort: fake.ssdpPort, interfaces: ['127.0.0.1'], timeoutMs: 1_500, ...extra };
}

describe('parseSsdpResponse', () => {
  it('reads the LOCATION of a 200 response, headers in any case', () => {
    expect(parseSsdpResponse('HTTP/1.1 200 OK\r\nst: x\r\nLocation: http://192.168.0.1:5000/rootDesc.xml\r\n\r\n')).toBe('http://192.168.0.1:5000/rootDesc.xml');
  });
  it.each([
    'NOTIFY * HTTP/1.1\r\nLOCATION: http://192.168.0.1/\r\n\r\n',
    'HTTP/1.1 404 Not Found\r\nLOCATION: http://192.168.0.1/\r\n\r\n',
    'HTTP/1.1 200 OK\r\nST: x\r\n\r\n',
    `HTTP/1.1 200 OK\r\nLOCATION: http://192.168.0.1/${'a'.repeat(3_000)}\r\n\r\n`,
  ])('ignores %j', (text) => {
    expect(parseSsdpResponse(text)).toBeNull();
  });
});

describe('parseDescription', () => {
  const desc = (services: string, urlBase = '') =>
    `<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0">${urlBase}<device><serviceList>${services}</serviceList></device></root>`;
  const svc = (type: string, control: string) => `<service><serviceType>${type}</serviceType><controlURL>${control}</controlURL></service>`;

  it('lists the WAN connection services, best first (IP:2, IP:1, PPP:1)', () => {
    const xml = desc(
      svc('urn:schemas-upnp-org:service:Layer3Forwarding:1', '/l3f') +
        svc('urn:schemas-upnp-org:service:WANPPPConnection:1', '/ppp') +
        svc('urn:schemas-upnp-org:service:WANIPConnection:1', '/ip1') +
        svc('urn:schemas-upnp-org:service:WANIPConnection:2', '/ip2'),
    );
    expect(parseDescription(xml, 'http://192.168.0.1:5000/desc.xml')).toEqual([
      { serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:2', controlUrl: 'http://192.168.0.1:5000/ip2' },
      { serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1', controlUrl: 'http://192.168.0.1:5000/ip1' },
      { serviceType: 'urn:schemas-upnp-org:service:WANPPPConnection:1', controlUrl: 'http://192.168.0.1:5000/ppp' },
    ]);
  });

  it('honours URLBase, decodes entities and namespace prefixes', () => {
    const xml = desc(
      '<ns:service><ns:serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</ns:serviceType><ns:controlURL>ctl?a=1&amp;b=2</ns:controlURL></ns:service>',
      '<URLBase>http://192.168.0.1:49152/upnp/</URLBase>',
    );
    expect(parseDescription(xml, 'http://192.168.0.1:5000/desc.xml')).toEqual([
      { serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1', controlUrl: 'http://192.168.0.1:49152/upnp/ctl?a=1&b=2' },
    ]);
  });

  it('drops control URLs on another host or scheme (no SSRF through the router description)', () => {
    const xml = desc(
      svc('urn:schemas-upnp-org:service:WANIPConnection:1', 'http://10.66.66.66/ctl') +
        svc('urn:schemas-upnp-org:service:WANIPConnection:2', 'file:///etc/passwd') +
        svc('urn:schemas-upnp-org:service:WANPPPConnection:1', 'https://192.168.0.1/ctl'),
      '',
    );
    expect(parseDescription(xml, 'http://192.168.0.1:5000/desc.xml')).toEqual([]);
    expect(parseDescription(desc('', '<URLBase>http://10.66.66.66/</URLBase>') + svc('urn:schemas-upnp-org:service:WANIPConnection:1', 'ctl'), 'http://192.168.0.1/d.xml')).toEqual([]);
  });
});

describe('discoverGateway (SSDP + description)', () => {
  it.each<[string, FakeIgdOptions['services'], string]>([
    ['IGD v1 / WANIPConnection:1', ['WANIPConnection:1'], 'urn:schemas-upnp-org:service:WANIPConnection:1'],
    ['IGD v2 / WANIPConnection:2', ['WANIPConnection:2'], 'urn:schemas-upnp-org:service:WANIPConnection:2'],
    ['PPPoE / WANPPPConnection:1', ['WANPPPConnection:1'], 'urn:schemas-upnp-org:service:WANPPPConnection:1'],
  ])('finds %s', async (_label, services, serviceType) => {
    const fake = await igd({ services });
    const gw = await discoverGateway(at(fake));
    expect(gw).toMatchObject({ localAddress: '127.0.0.1', location: `http://127.0.0.1:${fake.httpPort}/desc.xml` });
    expect(gw!.services[0]).toEqual({ serviceType, controlUrl: `http://127.0.0.1:${fake.httpPort}/ctl/IPConn` });
    expect(fake.searches).toEqual(expect.arrayContaining(['urn:schemas-upnp-org:device:InternetGatewayDevice:1', 'urn:schemas-upnp-org:device:InternetGatewayDevice:2']));
  });

  it('works with a URLBase and a relative controlURL', async () => {
    const fake = await igd({ urlBase: true });
    expect((await discoverGateway(at(fake)))?.services[0]?.controlUrl).toBe(`http://127.0.0.1:${fake.httpPort}/ctl/IPConn`);
  });

  it('returns null when nothing answers, within the timeout', async () => {
    const fake = await igd({ silent: true });
    const started = Date.now();
    expect(await discoverGateway(at(fake, { timeoutMs: 400 }))).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('ignores a LOCATION on another host than the one that answered', async () => {
    const fake = await igd({ location: () => 'http://10.66.66.66:80/desc.xml' });
    expect(await discoverGateway(at(fake, { timeoutMs: 400 }))).toBeNull();
  });

  it('ignores an oversized description', async () => {
    const fake = await igd({ descriptionPadding: 200_000 });
    expect(await discoverGateway(at(fake, { timeoutMs: 800 }))).toBeNull();
  });

  it('ignores a description whose control URL points elsewhere', async () => {
    const fake = await igd({ controlUrl: () => 'http://10.66.66.66/ctl' });
    expect(await discoverGateway(at(fake, { timeoutMs: 800 }))).toBeNull();
  });
});

describe('UpnpClient (SOAP)', () => {
  async function client(opts: FakeIgdOptions = {}) {
    const fake = await igd(opts);
    const gw = await discoverGateway(at(fake));
    return { fake, client: new UpnpClient(gw!) };
  }

  it('reads the WAN IP and validates it', async () => {
    expect(await (await client()).client.externalIp()).toBe('203.0.113.7');
    expect(await (await client({ externalIp: '<b>x</b>' })).client.externalIp()).toBeNull();
    expect(await (await client({ externalIp: '100.72.1.1' })).client.externalIp()).toBe('100.72.1.1');
  });

  it('adds and deletes a mapping for this machine with a 2 h lease', async () => {
    const { fake, client: c } = await client();
    expect(await c.addPortMapping({ protocol: 'TCP', port: 7700 })).toEqual({ leaseSeconds: UPNP_LEASE_SECONDS });
    expect(fake.mappings.get('TCP:7700')).toEqual({
      protocol: 'TCP',
      externalPort: 7700,
      internalPort: 7700,
      internalClient: '127.0.0.1',
      description: 'GhostLink',
      lease: 7200,
    });
    await c.deletePortMapping({ protocol: 'TCP', port: 7700 });
    expect(fake.mappings.size).toBe(0);
  });

  it('falls back to a permanent mapping when the router only supports those (725)', async () => {
    const { fake, client: c } = await client({ onlyPermanentLeases: true });
    expect(await c.addPortMapping({ protocol: 'UDP', port: 7882 })).toEqual({ leaseSeconds: 0 });
    expect(fake.mappings.get('UDP:7882')?.lease).toBe(0);
  });

  it('reports a port already mapped to another computer as UpnpError 718', async () => {
    const { client: c } = await client({ conflicts: ['TCP:7700'] });
    await expect(c.addPortMapping({ protocol: 'TCP', port: 7700 })).rejects.toEqual(expect.objectContaining({ name: 'UpnpError', upnpCode: 718 }));
    await expect(c.addPortMapping({ protocol: 'TCP', port: 7700 })).rejects.toBeInstanceOf(UpnpError);
  });

  it('escapes the description it sends', async () => {
    const { fake, client: c } = await client();
    await c.addPortMapping({ protocol: 'TCP', port: 7701, description: 'a<b>&"c' });
    expect(fake.mappings.get('TCP:7701')?.description).toBe('a&lt;b&gt;&amp;&quot;c');
  });
});

describe('PortMapper (lease renewal, unmap on stop)', () => {
  it('maps every port, renews before the lease ends, and removes them all on stop', async () => {
    const fake = await igd();
    const gw = await discoverGateway(at(fake));
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const mapper = new PortMapper({
      client: new UpnpClient(gw!),
      ports: [
        { protocol: 'TCP', port: 7700 },
        { protocol: 'UDP', port: 7882 },
        { protocol: 'TCP', port: 7881 },
      ],
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return { unref() {}, [Symbol.dispose]() {} } as unknown as NodeJS.Timeout;
      },
      clearTimer: () => {},
    });
    const result = await mapper.start();
    expect(result).toEqual([
      { protocol: 'TCP', port: 7700, ok: true, leaseSeconds: 7200 },
      { protocol: 'UDP', port: 7882, ok: true, leaseSeconds: 7200 },
      { protocol: 'TCP', port: 7881, ok: true, leaseSeconds: 7200 },
    ]);
    expect([...fake.mappings.keys()].sort()).toEqual(['TCP:7700', 'TCP:7881', 'UDP:7882']);
    expect(timers.at(-1)!.ms).toBe(3_600_000); // renew at half the lease

    fake.mappings.clear(); // the router rebooted
    timers.at(-1)!.fn();
    await vi.waitFor(() => expect(fake.mappings.size).toBe(3));

    await mapper.stop();
    expect(fake.mappings.size).toBe(0);
    expect(fake.actions.filter((a) => a === 'DeletePortMapping')).toHaveLength(3);
  });

  it('reports a failed port and still unmaps only what it mapped', async () => {
    const fake = await igd({ conflicts: ['TCP:7700'] });
    const gw = await discoverGateway(at(fake));
    const mapper = new PortMapper({ client: new UpnpClient(gw!), ports: [{ protocol: 'TCP', port: 7700 }, { protocol: 'UDP', port: 7882 }] });
    expect(await mapper.start()).toEqual([
      { protocol: 'TCP', port: 7700, ok: false, error: 'conflict' },
      { protocol: 'UDP', port: 7882, ok: true, leaseSeconds: 7200 },
    ]);
    await mapper.stop();
    expect(fake.actions.filter((a) => a === 'DeletePortMapping')).toHaveLength(1);
  });
});
