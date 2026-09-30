// Voice behind a TCP proxy (spec §8.6), end to end: the way a Railway server is reached. A
// server in this process runs in proxy mode with the real text module and the real LiveKit;
// a "fake Railway" forwards ONE external address to its public port. Two built apps, with UDP
// disabled in Chromium, join by invite through that address and talk: TLS (the pinned
// connection, the /rtc signaling) and the media (ICE-TCP) share it.
//
// The external address is this machine's LAN IP at LiveKit's port: Windows lets the forwarder
// hold that one address next to LiveKit's wildcard listener on the same port (the more specific
// binding wins), so LiveKit's only candidate, <LAN IP>:<port>, leads to the forwarder. Linux
// refuses that bind, hence Windows only (as the e2e runs are).
// Run with `npm run test:e2e` (builds the app first). Skipped without the LiveKit binary.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freeLoopbackPort } from '../../../server/src/livekit/backend.js';
import { resolveLivekitBinary } from '../../../server/src/livekit/binary.js';
import { localIPv4Addresses, silentLogger, startServer, type GhostServer } from '../../../server/src/index.js';
import { createTextModule } from '../../../server/src/text/index.js';
import { createVoiceModule } from '../../../server/src/voice/index.js';
import { FakeTcpProxy } from '../../../server/test/helpers/fakeProxy.js';
import { freeMediaPorts } from '../../../server/test/helpers/voice.js';
import { E2eRun, joinWithInvite, onboard, receivedLevelDb, textChannel, tile, voiceChannel, type Instance } from './harness.js';

const binary = resolveLivekitBinary();
const lan = localIPv4Addresses().find((a) => a.kind === 'lan') ?? localIPv4Addresses().find((a) => a.kind !== 'virtual');
/** Chromium sends no UDP at all (it would use UDP only through a proxy that supports it). */
const NO_UDP = ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'];

describe.runIf(binary && process.platform === 'win32' && lan)('voice through a TCP proxy, UDP disabled (spec §8.6)', () => {
  const run = new E2eRun();
  let server!: GhostServer;
  let railway!: FakeTcpProxy;

  beforeAll(async () => {
    const port = await freeLoopbackPort();
    const external = (await freeMediaPorts()).tcpPort;
    const voice = createVoiceModule();
    server = await startServer({
      dataDir: run.tempDir('server'),
      port,
      host: '127.0.0.1',
      name: 'Servidor Railway',
      joinMode: 'invite',
      proxy: { host: lan!.ip, port: external },
      // What `start --proxy` does: the proxy's address goes in the invites.
      publicAddresses: [`${lan!.ip}:${external}`],
      logger: silentLogger,
      modules: [createTextModule(), voice],
      voice: { binaryPath: binary! },
    });
    const started = server;
    run.onClose(() => started.close());
    expect(await voice.whenReady()).toBe(true);
    expect(voice.nodeIp).toBe(lan!.ip);
    railway = await new FakeTcpProxy(port).listen(external, lan!.ip);
    const forwarder = railway;
    run.onClose(() => forwarder.close());
  });

  afterAll(() => run.close(), 180_000);

  it('two apps join through the proxy and hear each other over ICE-TCP alone', async () => {
    try {
      const ana = await run.launch('ana', {}, NO_UDP);
      const bia = await run.launch('bia', {}, NO_UDP);
      const join = async (i: Instance, nickname: string) => {
        await onboard(i.page, nickname, 'Entrar num servidor');
        await joinWithInvite(i.page, server.createInvite().pasteCode);
        await textChannel(i.page, 'geral').waitFor({ timeout: 30_000 });
      };
      await join(ana, 'Ana');
      await join(bia, 'Bia');
      // The invite carries the proxy's address: the pinned TLS connections went through it.
      expect(railway.tlsConnections.length).toBeGreaterThanOrEqual(2);

      await voiceChannel(ana.page, 'Sala de voz').click();
      await ana.page.locator('[data-voice-panel="connected"]').waitFor({ timeout: 30_000 });
      await voiceChannel(bia.page, 'Sala de voz').click();
      await bia.page.locator('[data-voice-panel="connected"]').waitFor({ timeout: 30_000 });
      await expect.poll(() => tile(ana.page, 'Bia').getAttribute('data-receiving'), { timeout: 30_000 }).toBe('true');
      await expect.poll(() => tile(bia.page, 'Ana').getAttribute('data-receiving'), { timeout: 30_000 }).toBe('true');
      const anaId = (await tile(bia.page, 'Ana').getAttribute('data-user'))!;
      const biaId = (await tile(ana.page, 'Bia').getAttribute('data-user'))!;
      // Real audio each way: the fake microphones' speech, decoded in the other app.
      await expect.poll(() => receivedLevelDb(bia.page, anaId), { timeout: 30_000 }).toBeGreaterThan(-40);
      await expect.poll(() => receivedLevelDb(ana.page, biaId), { timeout: 30_000 }).toBeGreaterThan(-40);

      // And it came through the proxy as ICE-TCP: LiveKit opens no UDP socket in proxy mode,
      // and each app's media connection carried far more than the ICE checks and DTLS.
      const media = railway.iceConnections.filter((c) => c.down > 8_000 && c.up > 8_000);
      expect(media.length, JSON.stringify(railway.connections)).toBeGreaterThanOrEqual(2);
    } catch (e) {
      await run.report('proxy');
      throw e;
    }
  }, 240_000);
});
