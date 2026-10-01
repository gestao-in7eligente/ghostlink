// Voice that becomes available after the app connected (voice track, voice.availability):
// a server in this process with the real text module and a real LiveKit that only starts
// once the test opens a gate. The app joins while voice is down, then the voice UI comes
// alive without a reconnect. The full two-app scenario lives in v01.e2e.ts.
// Run with `npm run test:e2e` (builds the app first). Skipped without the LiveKit binary.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LivekitBackend, freeLoopbackPort, type VoiceBackend, type VoiceServerOptions } from '../../../server/src/livekit/backend.js';
import { resolveLivekitBinary } from '../../../server/src/livekit/binary.js';
import { silentLogger, startServer, type GhostServer } from '../../../server/src/index.js';
import type { ModuleContext } from '../../../server/src/modules.js';
import { createTextModule } from '../../../server/src/text/index.js';
import { createVoiceModule } from '../../../server/src/voice/index.js';
import { freeMediaPorts } from '../../../server/test/helpers/voice.js';
import { E2eRun, joinWithInvite, onboard, receivedLevelDb, textChannel, tile, voiceChannel } from './harness.js';

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

  it('noise suppression (spec 2026-10-01): RNNoise by default, then Speex, GTCRN, WebRTC and Desativada during the call; the voice keeps arriving', async () => {
    const cia = run.instances.find((i) => i.name === 'cia');
    if (!cia) throw new Error('the previous step did not start Cia');
    try {
      // Dan joins the same server and the same voice channel.
      const dan = await run.launch('dan');
      await onboard(dan.page, 'Dan', 'Entrar num servidor');
      await joinWithInvite(dan.page, server!.createInvite().pasteCode);
      await textChannel(dan.page, 'geral').waitFor({ timeout: 30_000 });
      await voiceChannel(dan.page, 'Sala de voz').click();
      await dan.page.locator('[data-voice-panel="connected"]').waitFor({ timeout: 30_000 });
      await expect.poll(() => tile(dan.page, 'Cia').getAttribute('data-receiving'), { timeout: 30_000 }).toBe('true');
      await expect.poll(() => tile(cia.page, 'Dan').getAttribute('data-receiving'), { timeout: 30_000 }).toBe('true');
      const ciaId = (await tile(dan.page, 'Cia').getAttribute('data-user'))!;
      const danId = (await tile(cia.page, 'Dan').getAttribute('data-user'))!;

      // Cia's voice settings: RNNoise is chosen and really runs (no fallback note), and her voice arrives.
      await cia.page.getByRole('button', { name: 'Configurações do usuário' }).click();
      await cia.page.getByRole('tab', { name: 'Voz' }).click();
      const settings = cia.page.locator('[data-voice-settings]');
      await settings.waitFor();
      // One title: the tab's, "Voz e vídeo" (the section no longer repeats it).
      expect(await cia.page.getByRole('heading', { name: 'Voz e vídeo', exact: true }).count()).toBe(1);
      const noise = settings.getByRole('combobox', { name: /supressão de ruído/i });
      await expect.poll(() => noise.textContent()).toBe('RNNoise — neural');
      const group = settings.locator('[data-voice-noise]');
      await expect.poll(() => group.getAttribute('data-voice-noise'), { timeout: 10_000 }).toBe('rnnoise');
      await expect.poll(() => receivedLevelDb(dan.page, ciaId), { timeout: 20_000 }).toBeGreaterThan(-40);
      await expect.poll(() => receivedLevelDb(cia.page, danId), { timeout: 20_000 }).toBeGreaterThan(-40);

      // The list in the app's style, open, for the record.
      await noise.click();
      const listbox = cia.page.getByRole('listbox', { name: /supressão de ruído/i });
      await listbox.waitFor();
      expect(await listbox.getByRole('option').allTextContents()).toEqual([
        'RNNoise — neural',
        'Speex — clássico',
        'GTCRN — neural alternativo',
        'WebRTC (nativo)',
        'Desativada',
      ]);
      expect(await listbox.getByRole('option', { selected: true }).textContent()).toBe('RNNoise — neural');
      await cia.page.screenshot({ path: join(tmpdir(), 'ghostlink-e2e-noise-select.png'), animations: 'disabled' });
      // Esc closes the list, not the settings.
      await cia.page.keyboard.press('Escape');
      await listbox.waitFor({ state: 'detached' });
      await settings.waitFor();
      // A list with room below opens under its field.
      const input = settings.getByRole('combobox', { name: /dispositivo de entrada/i });
      await input.click();
      const devices = cia.page.getByRole('listbox', { name: /dispositivo de entrada/i });
      await devices.waitFor();
      const [field, list] = [await input.boundingBox(), await devices.boundingBox()];
      expect(list!.y).toBeGreaterThan(field!.y + field!.height - 1);
      expect(Math.round(list!.width)).toBe(Math.round(field!.width));
      await cia.page.screenshot({ path: join(tmpdir(), 'ghostlink-e2e-select-down.png'), animations: 'disabled' });
      await cia.page.keyboard.press('Escape');
      await devices.waitFor({ state: 'detached' });

      // Each choice is swapped in during the call: the gate keeps working and the voice keeps arriving.
      const steps = [
        ['Speex — clássico', 'speex'],
        ['GTCRN — neural alternativo', 'gtcrn'],
        ['WebRTC (nativo)', 'webrtc'],
        ['Desativada', 'off'],
      ] as const;
      for (const [label, mode] of steps) {
        await noise.click();
        await cia.page.getByRole('option', { name: label }).click();
        await expect.poll(() => noise.textContent()).toBe(label);
        await expect.poll(() => group.getAttribute('data-voice-noise'), { timeout: 15_000 }).toBe(mode);
        await expect.poll(() => receivedLevelDb(dan.page, ciaId), { timeout: 20_000 }).toBeGreaterThan(-40);
        expect(await cia.page.locator('[data-voice-panel="connected"]').count()).toBe(1);
      }
      // No suppressor failed to load (the note would say so) and no worklet complained.
      expect(await group.getByRole('status').count()).toBe(0);
      expect(cia.log.filter((l) => /wasm|worklet|processor/i.test(l) && /error|fail/i.test(l))).toEqual([]);

      // Back to RNNoise by keyboard: the list opens on the current choice, Home jumps to the first.
      await noise.focus();
      await cia.page.keyboard.press('ArrowDown');
      await listbox.waitFor();
      await cia.page.keyboard.press('Home');
      await cia.page.keyboard.press('Enter');
      await expect.poll(() => group.getAttribute('data-voice-noise'), { timeout: 15_000 }).toBe('rnnoise');
      await expect.poll(() => receivedLevelDb(dan.page, ciaId), { timeout: 20_000 }).toBeGreaterThan(-40);
      // The focus is back on the field. (A string: the tests have no DOM types.)
      expect(await cia.page.evaluate("document.activeElement && document.activeElement.getAttribute('role')")).toBe('combobox');
    } catch (e) {
      await run.report('noise');
      throw e;
    }
  }, 240_000);
});
