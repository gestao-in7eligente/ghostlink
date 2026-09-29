// Voice that becomes available after the app connected (voice track, voice.availability):
// a server in this process with the real text module and a real LiveKit that only starts
// once the test opens a gate. The app joins while voice is down, then the voice UI comes
// alive without a reconnect. The full two-app scenario lives in v01.e2e.ts.
// Run with `npm run test:e2e` (builds the app first). Skipped without the LiveKit binary.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LivekitBackend, freeLoopbackPort, type VoiceBackend, type VoiceServerOptions } from '../../../server/src/livekit/backend.js';
import { resolveLivekitBinary } from '../../../server/src/livekit/binary.js';
import { silentLogger, startServer, type GhostServer } from '../../../server/src/index.js';
import type { ModuleContext } from '../../../server/src/modules.js';
import { createTextModule } from '../../../server/src/text/index.js';
import { createVoiceModule } from '../../../server/src/voice/index.js';
import { freeMediaPorts } from '../../../server/test/helpers/voice.js';
import { E2eRun, joinWithInvite, onboard, textChannel, voiceChannel } from './harness.js';

const binary = resolveLivekitBinary();

describe.skipIf(!binary)('voice that becomes available after the app connected (real LiveKit)', () => {
  const run = new E2eRun();
  let openGate!: () => void;
  let server: GhostServer | null = null;

  beforeAll(async () => {
    const port = await freeLoopbackPort();
    const gate = new Promise<void>((r) => (openGate = r));
    // The real LiveKit, started only once the gate opens: the app connects while voice is still down.
    const backend = (ctx: ModuleContext, options: VoiceServerOptions): VoiceBackend => {
      const real = new LivekitBackend({ ...options, binaryPath: binary!, dataDir: ctx.dataDir, logger: ctx.logger });
      const start = real.start.bind(real);
      real.start = async (listeners, options) => {
        await gate;
        return start(listeners, options);
      };
      return real;
    };
    server = await startServer({
      dataDir: run.tempDir('server'),
      port,
      host: '127.0.0.1',
      name: 'Servidor E2E',
      publicAddresses: [`127.0.0.1:${port}`],
      joinMode: 'invite',
      logger: silentLogger,
      modules: [createTextModule(), createVoiceModule({ backend, readyWaitMs: 0 })],
      voice: { binaryPath: binary!, ...(await freeMediaPorts()) },
    });
    const started = server;
    run.onClose(() => started.close());
  });

  afterAll(async () => {
    openGate?.();
    await run.close();
  }, 120_000);

  it('the voice UI comes alive (voice.availability) without a reconnect, and joining works', async () => {
    try {
      const cia = await run.launch('cia');
      await onboard(cia.page, 'Cia', 'Entrar num servidor');
      await joinWithInvite(cia.page, server!.createInvite().pasteCode);
      await textChannel(cia.page, 'geral').waitFor({ timeout: 30_000 });

      // Voice is down: the channel's stage says so and offers no way in.
      await voiceChannel(cia.page, 'Sala de voz').click();
      const stage = cia.page.locator('[data-voice-stage]');
      await stage.getByText('A voz não está disponível neste servidor agora.').waitFor({ timeout: 10_000 });
      expect(await stage.locator('[data-voice-join]').count()).toBe(0);

      // LiveKit comes up: the same screen offers "Entrar na voz", and it works.
      openGate();
      await stage.locator('[data-voice-join]').waitFor({ timeout: 30_000 });
      await stage.locator('[data-voice-join]').click();
      await cia.page.locator('[data-voice-panel="connected"]').waitFor({ timeout: 30_000 });
    } catch (e) {
      await run.report('late');
      throw e;
    }
  }, 180_000);
});
