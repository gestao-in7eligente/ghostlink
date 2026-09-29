import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ResErr, ResOk } from '@ghostlink/shared';
import { resolveLivekitBinary } from '../../src/livekit/binary.js';
import type { Logger } from '../../src/logger.js';
import { fallbackNodeIp, type NodeIpChoice } from '../../src/net/addresses.js';
import { createVoiceModule, type VoiceModule, type VoiceModuleOptions } from '../../src/voice/index.js';
import { connectTestClient, startTestServer, type TestClient, type TestServer } from '../helpers/testClient.js';
import { FakeBackend, StubNet, StubText, freeMediaPorts } from '../helpers/voice.js';

// spec §8.1: the IP LiveKit announces (rtc.node_ip) is an explicit value, else the `net`
// module's (the router's WAN IP from UPnP, else a local address), else the address
// fallback; a later change restarts LiveKit, but only while nobody is in voice.

const LAN: NodeIpChoice = { ip: '192.168.0.10', source: 'lan', interface: 'Ethernet' };
const WAN: NodeIpChoice = { ip: '203.0.113.7', source: 'upnp' };

const servers: TestServer[] = [];
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await Promise.all(servers.splice(0).map((s) => s.cleanup()));
});

interface Setup {
  t: TestServer;
  backend: FakeBackend;
  voice: VoiceModule;
  logs: string[];
  client(nickname?: string): Promise<TestClient>;
}

async function setup(o: { net?: StubNet; nodeIp?: string; voice?: Partial<VoiceModuleOptions> } = {}): Promise<Setup> {
  const text = new StubText();
  text.channels.set('VC1', { type: 'voice', userLimit: 0 });
  const backend = new FakeBackend();
  const voice = createVoiceModule({
    backend: () => backend,
    sweepIntervalMs: 3_600_000,
    reconcileIntervalMs: 3_600_000,
    nodeIpCheckIntervalMs: 3_600_000,
    ...o.voice,
  });
  const logs: string[] = [];
  const keep = (m: string, meta?: object) => void logs.push(`${m} ${JSON.stringify(meta ?? {})}`);
  const logger: Logger = { info: keep, warn: keep, error: keep };
  const t = await startTestServer({
    joinMode: 'open',
    // `net` first, as the CLI and Host mode register it.
    modules: [...(o.net ? [o.net] : []), text, voice],
    logger,
    voice: o.nodeIp ? { nodeIp: o.nodeIp } : undefined,
  });
  servers.push(t);
  expect(await voice.whenReady()).toBe(true);
  return {
    t,
    backend,
    voice,
    logs,
    client: async (nickname) => {
      const c = await connectTestClient(t.server, nickname ? { nickname } : {});
      clients.push(c);
      return c;
    },
  };
}

function ok<T = Record<string, unknown>>(res: ResOk | ResErr): T {
  if (!res.ok) throw new Error(`expected success, got ${res.error.code}`);
  return res.d as T;
}

describe('voice: the IP LiveKit announces at start (spec §8.1)', () => {
  it('an explicit voice.nodeIp (CLI --node-ip) wins over the net module, and the log says why', async () => {
    const s = await setup({ net: new StubNet(WAN), nodeIp: '198.51.100.9' });
    expect(s.backend.nodeIps).toEqual(['198.51.100.9']);
    expect(s.voice.nodeIp).toBe('198.51.100.9');
    expect(s.logs.join('\n')).toMatch(/announces 198\.51\.100\.9 .*explicit/);
  });

  it("takes the net module's node IP once UPnP first answered (the router's WAN IP)", async () => {
    const net = new StubNet(LAN, { answered: false });
    const answered = setTimeout(() => net.answer(WAN), 150);
    try {
      const s = await setup({ net });
      expect(s.backend.nodeIps).toEqual([WAN.ip]);
      expect(s.logs.join('\n')).toMatch(/announces 203\.0\.113\.7 .*WAN IP, from UPnP/);
    } finally {
      clearTimeout(answered);
    }
  });

  it('waits for UPnP at most netWaitMs, then takes what the net module has (a later answer restarts LiveKit)', async () => {
    const net = new StubNet(LAN, { answered: false });
    const started = Date.now();
    const s = await setup({ net, voice: { netWaitMs: 200 } });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(s.backend.nodeIps).toEqual([LAN.ip]);
    expect(s.logs.join('\n')).toMatch(/announces 192\.168\.0\.10 .*LAN IPv4 on interface "Ethernet"/);
  });

  it('without a net module: the address fallback (a public interface IP, else the LAN, else 127.0.0.1)', async () => {
    const s = await setup();
    expect(s.backend.nodeIps).toEqual([fallbackNodeIp().ip]);
    expect(s.voice.nodeIp).toBe(fallbackNodeIp().ip);
  });

  it('with a net module that has no usable address (a loopback bind): the address fallback too', async () => {
    const s = await setup({ net: new StubNet(null) });
    expect(s.backend.nodeIps).toEqual([fallbackNodeIp().ip]);
  });
});

describe('voice: a node IP that changes later (spec §8.1)', () => {
  it('nobody in voice: LiveKit restarts with the new IP at once, and clients see voice.availability false then true', async () => {
    const net = new StubNet(LAN);
    const s = await setup({ net });
    const ana = await s.client('ana');
    net.choice = WAN; // UPnP answered late
    await s.voice.refreshNodeIp();
    expect(s.backend.nodeIps).toEqual([LAN.ip, WAN.ip]);
    expect(s.voice.nodeIp).toBe(WAN.ip);
    expect((await ana.waitEvent('voice.availability')).d).toEqual({ available: false });
    expect((await ana.waitEvent('voice.availability')).d).toEqual({ available: true });
    expect(s.logs.join('\n')).toMatch(/restarting LiveKit to announce 203\.0\.113\.7 .*WAN IP, from UPnP/);
    // Voice works again afterwards.
    expect(ok<{ token: string }>(await ana.request('voice.join', { channelId: 'VC1' })).token).toBeTruthy();
  });

  it('the same IP again: no restart', async () => {
    const net = new StubNet(LAN);
    const s = await setup({ net });
    await s.voice.refreshNodeIp();
    net.choice = { ...LAN, interface: 'Wi-Fi' };
    await s.voice.refreshNodeIp();
    expect(s.backend.nodeIps).toEqual([LAN.ip]);
  });

  it('someone in a call: no restart until the rooms are empty, then right away', async () => {
    const net = new StubNet(LAN);
    const s = await setup({ net });
    const ana = await s.client('ana');
    const { token } = ok<{ token: string }>(await ana.request('voice.join', { channelId: 'VC1' }));
    s.backend.join('ch_VC1', `u_${ana.identity.userId}`);
    await expect.poll(() => s.voice.registry.channelOf(ana.identity.userId)).toBe('VC1');

    net.choice = WAN;
    await s.voice.refreshNodeIp();
    expect(s.backend.nodeIps).toEqual([LAN.ip]);
    expect(s.voice.nodeIp).toBe(LAN.ip);
    expect(s.logs.join('\n')).toMatch(/203\.0\.113\.7 .*once nobody is in voice/);
    await ana.request('voice.leave', {});
    await expect.poll(() => s.backend.nodeIps).toEqual([LAN.ip, WAN.ip]);
    expect(s.voice.nodeIp).toBe(WAN.ip);
    expect(s.logs.join('\n')).not.toContain(token);
  });

  it('someone who holds a join token but is not in LiveKit yet also holds the restart back', async () => {
    const net = new StubNet(LAN);
    const s = await setup({ net });
    const ana = await s.client('ana');
    ok(await ana.request('voice.join', { channelId: 'VC1' }));
    net.choice = WAN;
    await s.voice.refreshNodeIp();
    expect(s.backend.nodeIps).toEqual([LAN.ip]);
    await ana.request('voice.leave', {});
    await expect.poll(() => s.backend.nodeIps).toEqual([LAN.ip, WAN.ip]);
  });

  it('the periodic check finds a change by itself (a VPN that connects, a new WAN IP)', async () => {
    const net = new StubNet(LAN);
    const s = await setup({ net, voice: { nodeIpCheckIntervalMs: 50 } });
    net.choice = { ip: '26.1.2.3', source: 'radmin', interface: 'Radmin VPN' };
    await expect.poll(() => s.backend.nodeIps).toEqual([LAN.ip, '26.1.2.3']);
  });

  it('an explicit node IP is never replaced', async () => {
    const net = new StubNet(LAN);
    const s = await setup({ net, nodeIp: '198.51.100.9', voice: { nodeIpCheckIntervalMs: 50 } });
    net.choice = WAN;
    await s.voice.refreshNodeIp();
    await new Promise((r) => setTimeout(r, 200));
    expect(s.backend.nodeIps).toEqual(['198.51.100.9']);
  });
});

// The real livekit-server: it parses its config strictly and must accept the node_ip the
// voice module chose, at start and after a restart with a new one.
const binary = resolveLivekitBinary();

describe.skipIf(!binary)('voice: node_ip with the real LiveKit (spec §8.1)', () => {
  it('boots with the net module\'s node_ip in livekit.yaml, and restarts with a new one', async () => {
    const net = new StubNet({ ip: '198.51.100.23', source: 'public', interface: 'eth0' });
    const text = new StubText();
    text.channels.set('VC1', { type: 'voice', userLimit: 0 });
    const voice = createVoiceModule({ sweepIntervalMs: 3_600_000, reconcileIntervalMs: 3_600_000, nodeIpCheckIntervalMs: 3_600_000 });
    const logs: string[] = [];
    const keep = (m: string, meta?: object) => void logs.push(`${m} ${JSON.stringify(meta ?? {})}`);
    const t = await startTestServer({
      joinMode: 'open',
      modules: [net, text, voice],
      logger: { info: keep, warn: keep, error: keep },
      voice: { binaryPath: binary!, ...(await freeMediaPorts()) },
    });
    servers.push(t);
    const yaml = () => readFileSync(join(t.dataDir, 'livekit.yaml'), 'utf8');
    expect(await voice.whenReady(), `LiveKit did not start: ${logs.join(' / ')}`).toBe(true);
    expect(yaml()).toContain('node_ip: "198.51.100.23"');
    expect(voice.features).toEqual(['voice']);

    const ana = await connectTestClient(t.server, { nickname: 'ana' });
    clients.push(ana);
    net.choice = { ip: '198.51.100.24', source: 'public', interface: 'eth0' };
    await voice.refreshNodeIp();
    expect(yaml()).toContain('node_ip: "198.51.100.24"');
    expect((await ana.waitEvent('voice.availability', 20_000)).d).toEqual({ available: false });
    expect((await ana.waitEvent('voice.availability', 20_000)).d).toEqual({ available: true });
    expect(voice.features, logs.join(' / ')).toEqual(['voice']);
    expect(ok<{ token: string }>(await ana.request('voice.join', { channelId: 'VC1' })).token).toBeTruthy();
  }, 60_000);
});
