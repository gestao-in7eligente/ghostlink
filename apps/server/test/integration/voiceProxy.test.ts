// Voice behind a TCP proxy (spec §8.6): LiveKit's ICE-TCP port is the proxy's external port
// (the candidates carry it), node_ip is the proxy's IPv4, resolved from its host name and
// followed like any node IP, and the public port pipes ICE-TCP to LiveKit while it runs.
import { connect as netConnect, createServer as createNetServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { ResErr, ResOk } from '@ghostlink/shared';
import { freeLoopbackPort, type VoiceBackendOptions } from '../../src/livekit/backend.js';
import type { Logger } from '../../src/logger.js';
import type { ProxyEndpoint } from '../../src/modules.js';
import { createVoiceModule, type VoiceModule, type VoiceModuleOptions } from '../../src/voice/index.js';
import { connectTestClient, startTestServer, type TestClient, type TestServer } from '../helpers/testClient.js';
import { FakeBackend, StubNet, StubText } from '../helpers/voice.js';

const cleanups: Array<() => unknown> = [];
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Setup {
  t: TestServer;
  backend: FakeBackend;
  /** What the backend factory was given. */
  backendOptions: VoiceBackendOptions;
  voice: VoiceModule;
  logs: string[];
  client(nickname?: string): Promise<TestClient>;
}

async function setup(o: {
  proxy?: ProxyEndpoint;
  answers?: () => string[];
  nodeIp?: string;
  port?: number;
  net?: StubNet;
  voice?: Partial<VoiceModuleOptions>;
} = {}): Promise<Setup> {
  const text = new StubText();
  text.channels.set('VC1', { type: 'voice', userLimit: 0 });
  const backend = new FakeBackend();
  let backendOptions: VoiceBackendOptions = {};
  const voice = createVoiceModule({
    backend: (_ctx, options) => {
      backendOptions = options;
      return backend;
    },
    sweepIntervalMs: 3_600_000,
    reconcileIntervalMs: 3_600_000,
    nodeIpCheckIntervalMs: 3_600_000,
    proxyLookup: async () => (o.answers ?? (() => ['66.33.22.220']))(),
    ...o.voice,
  });
  const logs: string[] = [];
  const keep = (m: string, meta?: object) => void logs.push(`${m} ${JSON.stringify(meta ?? {})}`);
  const logger: Logger = { info: keep, warn: keep, error: keep };
  const t = await startTestServer({
    joinMode: 'open',
    modules: [...(o.net ? [o.net] : []), text, voice],
    logger,
    proxy: o.proxy,
    port: o.port ?? 0,
    voice: o.nodeIp ? { nodeIp: o.nodeIp } : undefined,
  });
  cleanups.push(() => t.cleanup());
  await voice.whenReady();
  return {
    t,
    backend,
    get backendOptions() {
      return backendOptions;
    },
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

/** A stand-in for LiveKit's ICE-TCP listener on 127.0.0.1:port. */
async function fakeIce(port: number): Promise<{ sockets: Socket[] }> {
  const sockets: Socket[] = [];
  const server: Server = createNetServer((s) => {
    sockets.push(s);
    s.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  cleanups.push(() => {
    for (const s of sockets) s.destroy();
    return new Promise<void>((r) => server.close(() => r()));
  });
  return { sockets };
}

/** Opens a connection to the public port and sends the start of an ICE-TCP frame; resolves when it closes. */
function iceConnect(port: number): { closed: Promise<void> } {
  const socket = netConnect({ port, host: '127.0.0.1' });
  cleanups.push(() => socket.destroy());
  socket.on('error', () => {});
  socket.on('connect', () => socket.write(Buffer.from([0x00, 0x14, 0x00, 0x01])));
  return { closed: new Promise((r) => socket.once('close', () => r())) };
}

describe('voice behind a TCP proxy (spec §8.6)', () => {
  it("gives LiveKit the proxy's external port for ICE-TCP and announces the proxy's resolved IPv4", async () => {
    const s = await setup({ proxy: { host: 'altaria.proxy.rlwy.net', port: 25_889 } });
    expect(s.backendOptions).toMatchObject({ tcpPort: 25_889, behindProxy: true });
    expect(s.backend.nodeIps).toEqual(['66.33.22.220']);
    expect(s.voice.nodeIp).toBe('66.33.22.220');
    expect(s.logs.join('\n')).toMatch(/announces 66\.33\.22\.220 to clients \(the TCP proxy's IPv4 \(altaria\.proxy\.rlwy\.net\)\)/);
    // Signaling goes through the same public address the client used: the proxy's.
    const ana = await s.client('ana');
    expect(s.voice.features).toEqual(['voice']);
    expect(ok<{ token: string }>(await ana.request('voice.join', { channelId: 'VC1' })).token).toBeTruthy();
  });

  it('the public port pipes ICE-TCP to LiveKit while it runs, and refuses it while LiveKit is down', async () => {
    const port = await freeLoopbackPort();
    const ice = await fakeIce(port);
    const s = await setup({ proxy: { host: '127.0.0.1', port } });
    expect(s.voice.iceTcpPort?.()).toBe(port);
    iceConnect(s.t.server.port);
    await expect.poll(() => ice.sockets.length).toBe(1);

    s.backend.crash();
    expect(s.voice.iceTcpPort?.()).toBeNull();
    await iceConnect(s.t.server.port).closed;
    expect(ice.sockets).toHaveLength(1);
    s.backend.up();
    iceConnect(s.t.server.port);
    await expect.poll(() => ice.sockets.length).toBe(2);
  });

  it('outside proxy mode voice offers no ICE-TCP port and keeps its own media ports', async () => {
    const s = await setup();
    expect(s.voice.iceTcpPort?.()).toBeNull();
    expect(s.backendOptions).not.toHaveProperty('behindProxy');
  });

  it('an explicit --node-ip wins over the proxy\'s IP', async () => {
    const s = await setup({ proxy: { host: 'altaria.proxy.rlwy.net', port: 25_889 }, nodeIp: '198.51.100.9' });
    expect(s.backend.nodeIps).toEqual(['198.51.100.9']);
  });

  it("the proxy's IP, not the net module's, is the one followed", async () => {
    const s = await setup({ proxy: { host: 'altaria.proxy.rlwy.net', port: 25_889 }, net: new StubNet({ ip: '10.0.0.5', source: 'lan', interface: 'eth0' }) });
    expect(s.backend.nodeIps).toEqual(['66.33.22.220']);
  });

  it("a new IP behind the proxy's name restarts LiveKit with it, but only once nobody is in voice", async () => {
    let answer = ['66.33.22.220'];
    const s = await setup({
      proxy: { host: 'altaria.proxy.rlwy.net', port: 25_889 },
      answers: () => answer,
      voice: { proxyRefreshMs: 30, nodeIpCheckIntervalMs: 30 },
    });
    const ana = await s.client('ana');
    ok(await ana.request('voice.join', { channelId: 'VC1' }));
    s.backend.join('ch_VC1', `u_${ana.identity.userId}`);
    answer = ['66.33.22.221'];
    await new Promise((r) => setTimeout(r, 300));
    expect(s.backend.nodeIps).toEqual(['66.33.22.220']);
    expect(s.logs.join('\n')).toMatch(/66\.33\.22\.221 .*once nobody is in voice/);
    await ana.request('voice.leave', {});
    await expect.poll(() => s.backend.nodeIps).toEqual(['66.33.22.220', '66.33.22.221']);
  });

  it("the proxy's name does not resolve at first: LiveKit starts anyway, and moves to the right IP once it does", async () => {
    let answer: string[] | null = null;
    const s = await setup({
      proxy: { host: 'altaria.proxy.rlwy.net', port: 25_889 },
      answers: () => {
        if (!answer) throw new Error('ENOTFOUND');
        return answer;
      },
      voice: { proxyRefreshMs: 30, nodeIpCheckIntervalMs: 30 },
    });
    expect(s.backend.nodeIps).toHaveLength(1);
    expect(s.logs.join('\n')).toMatch(/could not resolve the TCP proxy altaria\.proxy\.rlwy\.net/);
    answer = ['66.33.22.220'];
    await expect.poll(() => s.backend.nodeIps.at(-1)).toBe('66.33.22.220');
  });

  it("refuses to run LiveKit on the server's own port (the proxy's external port must differ from --port)", async () => {
    const port = await freeLoopbackPort();
    const s = await setup({ proxy: { host: 'proxy.example.net', port }, port });
    expect(await s.voice.whenReady()).toBe(false);
    expect(s.backend.nodeIps).toEqual([]);
    expect(s.voice.features).toEqual([]);
    expect(s.logs.join('\n')).toMatch(new RegExp(`voice is unavailable: the TCP proxy's external port ${port} is also this server's port`));
  });
});
