import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../src/logger.js';
import { describeNodeIp } from '../src/net/addresses.js';
import { ProxyAddress } from '../src/net/proxyAddress.js';

// spec §8.6: behind a TCP proxy, LiveKit announces the proxy's IPv4 (node_ip), resolved from
// its host name at start and every few minutes (a change restarts LiveKit once nobody is in voice).

const logger = () => ({ info: vi.fn<Logger['info']>(), warn: vi.fn<Logger['warn']>(), error: vi.fn<Logger['error']>() });

describe('ProxyAddress', () => {
  it('an IPv4 literal needs no lookup', async () => {
    const lookup = vi.fn(async () => ['192.0.2.1']);
    const p = new ProxyAddress({ host: '66.33.22.220', lookup, logger: logger() });
    p.start();
    await p.ready();
    expect(p.nodeIpChoice()).toEqual({ ip: '66.33.22.220', source: 'proxy', host: '66.33.22.220' });
    expect(lookup).not.toHaveBeenCalled();
    p.stop();
  });

  it('resolves a host name to its IPv4 and says so', async () => {
    const lookup = vi.fn(async () => ['66.33.22.220']);
    const p = new ProxyAddress({ host: 'altaria.proxy.rlwy.net', lookup, logger: logger() });
    expect(p.nodeIpChoice()).toBeNull();
    p.start();
    await p.ready();
    expect(lookup).toHaveBeenCalledWith('altaria.proxy.rlwy.net');
    const choice = p.nodeIpChoice()!;
    expect(choice).toEqual({ ip: '66.33.22.220', source: 'proxy', host: 'altaria.proxy.rlwy.net' });
    expect(describeNodeIp(choice)).toBe("the TCP proxy's IPv4 (altaria.proxy.rlwy.net)");
    p.stop();
  });

  it('keeps its IP while the name still resolves to it (no flapping between several), else takes the first', async () => {
    let answer = ['66.33.22.220'];
    const p = new ProxyAddress({ host: 'proxy.example.net', lookup: async () => answer, logger: logger() });
    p.start();
    await p.ready();
    answer = ['66.33.22.221', '66.33.22.220'];
    await p.refresh();
    expect(p.nodeIpChoice()?.ip).toBe('66.33.22.220');
    answer = ['66.33.22.222', '66.33.22.223'];
    await p.refresh();
    expect(p.nodeIpChoice()?.ip).toBe('66.33.22.222');
    p.stop();
  });

  it('a failed lookup keeps the last good IP and warns; a first failure leaves none', async () => {
    const l = logger();
    let fail = true;
    const p = new ProxyAddress({ host: 'proxy.example.net', lookup: async () => {
      if (fail) throw new Error('ENOTFOUND');
      return ['66.33.22.220'];
    }, logger: l });
    p.start();
    await p.ready();
    expect(p.nodeIpChoice()).toBeNull();
    expect(l.warn).toHaveBeenCalledWith(expect.stringMatching(/could not resolve the TCP proxy proxy\.example\.net/), expect.anything());
    fail = false;
    await p.refresh();
    expect(p.nodeIpChoice()?.ip).toBe('66.33.22.220');
    fail = true;
    await p.refresh();
    expect(p.nodeIpChoice()?.ip).toBe('66.33.22.220');
    p.stop();
  });

  it('only IPv4 counts (LiveKit announces one IPv4 host candidate); an IPv6 literal gives none', async () => {
    const p = new ProxyAddress({ host: 'proxy.example.net', lookup: async () => ['2001:db8::1', '66.33.22.220'], logger: logger() });
    p.start();
    await p.ready();
    expect(p.nodeIpChoice()?.ip).toBe('66.33.22.220');
    p.stop();
    const l = logger();
    const v6 = new ProxyAddress({ host: '2001:db8::1', lookup: async () => [], logger: l });
    v6.start();
    await v6.ready();
    expect(v6.nodeIpChoice()).toBeNull();
    expect(l.warn).toHaveBeenCalled();
    v6.stop();
  });

  it('re-resolves on its own every refreshMs', async () => {
    let answer = '66.33.22.220';
    const lookup = vi.fn(async () => [answer]);
    const p = new ProxyAddress({ host: 'proxy.example.net', lookup, refreshMs: 30, logger: logger() });
    p.start();
    await p.ready();
    answer = '66.33.22.230';
    await expect.poll(() => p.nodeIpChoice()?.ip).toBe('66.33.22.230');
    p.stop();
    const calls = lookup.mock.calls.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(lookup.mock.calls.length).toBe(calls);
  });
});
