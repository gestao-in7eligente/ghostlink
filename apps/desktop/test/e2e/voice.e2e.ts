// Voice end to end (voice track "Done means"): two Electron dev instances, each with its own
// profile, join one voice channel through the real UI and receive each other's audio.
// Chromium's fake devices feed the microphones (--use-fake-device-for-media-stream, and
// deliberately NOT --use-fake-ui-for-media-stream: the app's own permission handler answers).
// Run with `npm run test:e2e` (builds the app first). Skipped without the LiveKit binary.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_EVERYONE_PERMISSIONS, PERMISSIONS } from '@ghostlink/shared';
import { freeLoopbackPort } from '../../../server/src/livekit/backend.js';
import { resolveLivekitBinary } from '../../../server/src/livekit/binary.js';
import { silentLogger, startServer, type GhostServer } from '../../../server/src/index.js';
import type { ModuleContext, ServerModule, SessionInfo } from '../../../server/src/modules.js';
import { createVoiceModule } from '../../../server/src/voice/index.js';
import type { VoiceAccess } from '../../../server/src/voice/access.js';
import { freeMediaPorts } from '../../../server/test/helpers/voice.js';

const binary = resolveLivekitBinary();
// No trailing separator: on Windows Playwright quotes each argument, and a final backslash would escape the quote.
const desktopDir = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const MODS = 'MODS';
const VOICE_CHANNELS = [
  { id: 'VC1', name: 'Sala de conversa' },
  { id: 'VC2', name: 'Sala 2' },
];

/**
 * A stand-in for the Text module: two voice channels, and the first member to arrive is a
 * moderator (MUTE_MEMBERS + MOVE_MEMBERS). Its welcome fields have the Text track's shape.
 */
class E2eText implements ServerModule {
  readonly name = 'text';
  moderator: string | null = null;
  #ctx: ModuleContext | null = null;
  readonly voiceAccess: VoiceAccess = {
    channel: (id) => (VOICE_CHANNELS.some((c) => c.id === id) ? { type: 'voice', userLimit: 0 } : null),
    permissions: (userId, channelId) => {
      if (!VOICE_CHANNELS.some((c) => c.id === channelId)) return 0;
      return userId === this.moderator ? DEFAULT_EVERYONE_PERMISSIONS | PERMISSIONS.MUTE_MEMBERS | PERMISSIONS.MOVE_MEMBERS : DEFAULT_EVERYONE_PERMISSIONS;
    },
    isOwner: () => false,
    topPosition: (userId) => (userId === this.moderator ? 5 : 0),
  };

  init(ctx: ModuleContext): void {
    this.#ctx = ctx;
  }

  welcome(session: SessionInfo): Record<string, unknown> {
    this.moderator ??= session.userId;
    const users = this.#ctx!.db.all<{ id: string; nickname: string }>('SELECT id, nickname FROM users');
    return {
      channels: VOICE_CHANNELS.map((c, position) => ({ ...c, type: 'voice', topic: '', position, private: false, allowedRoleIds: [], userLimit: 0, lastMessageId: 0 })),
      roles: [
        { id: 'EVERY', name: '@todos', color: 0, permissions: DEFAULT_EVERYONE_PERMISSIONS, position: 0, hoist: false, mentionable: false, isDefault: true },
        { id: MODS, name: 'Mods', color: 0, permissions: PERMISSIONS.MUTE_MEMBERS | PERMISSIONS.MOVE_MEMBERS, position: 5, hoist: false, mentionable: false, isDefault: false },
      ],
      members: users.map((u) => ({ userId: u.id, nickname: u.nickname, roleIds: u.id === this.moderator ? [MODS] : [], online: true, joinedAt: 0 })),
    };
  }
}

interface Instance {
  app: ElectronApplication;
  page: Page;
  userData: string;
  log: string[];
}

const instances: Instance[] = [];
let server: GhostServer | null = null;
let dataDir = '';
let speechWav = '';

/**
 * A speech-like signal for Chromium's fake microphone (48 kHz mono PCM, 12 s, looped):
 * "syllables" of 180–320 ms with a changing pitch and harmonics, then short pauses. Its
 * default fake input is a brief beep that LiveKit's speaker detection may or may not count,
 * and a steady tone is faded out by noise suppression (which the app keeps on, spec §8.2).
 */
function writeSpeechWav(path: string): void {
  const rate = 48_000;
  const seconds = 12;
  const pcm = new Int16Array(rate * seconds);
  let t = 0;
  let syllable = 0;
  while (t < pcm.length) {
    const voiced = Math.floor(rate * (0.18 + ((syllable * 37) % 15) / 100));
    const pause = Math.floor(rate * (0.06 + ((syllable * 23) % 7) / 100));
    const f0 = 110 + ((syllable * 53) % 120);
    let phase = 0;
    for (let i = 0; i < voiced && t + i < pcm.length; i++) {
      const env = Math.min(1, i / (rate * 0.02), (voiced - i) / (rate * 0.04));
      const f = f0 * (1 + 0.15 * Math.sin((2 * Math.PI * i) / voiced));
      phase += (2 * Math.PI * f) / rate;
      let v = 0;
      for (let h = 1; h <= 12; h++) v += Math.sin(h * phase) / h;
      pcm[t + i] = Math.round(Math.max(-1, Math.min(1, v * 0.35 * env)) * 32767);
    }
    t += voiced + pause;
    syllable++;
  }
  const data = Buffer.from(pcm.buffer);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}

async function launch(name: string): Promise<Instance> {
  const userData = mkdtempSync(join(tmpdir(), `ghostlink-e2e-${name}-`));
  const env: Record<string, string> = { ...(process.env as Record<string, string>), GHOSTLINK_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  // Playwright finds Electron itself and preloads its loader (it skips the loader with executablePath).
  const app = await electron.launch({
    args: [desktopDir, '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${speechWav}`, '--lang=pt-BR'],
    env,
    timeout: 60_000,
  });
  const page = await app.firstWindow();
  const log: string[] = [];
  page.on('console', (m) => log.push(`[${name}] ${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => log.push(`[${name}] pageerror: ${e.message}`));
  const instance = { app, page, userData, log };
  instances.push(instance);
  return instance;
}

async function onboardAndJoin(page: Page, nickname: string, invite: string): Promise<void> {
  await page.getByRole('button', { name: 'Começar' }).click();
  await page.getByRole('textbox').fill(nickname);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByRole('button', { name: 'Entendi' }).click();
  await page.getByRole('button', { name: 'Entrar num servidor' }).click();
  await page.getByRole('textbox').fill(invite);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByRole('button', { name: 'Aceitar convite' }).click();
  await page.getByRole('button', { name: 'Conectar' }).click();
  await page.locator('[data-voice-channel="VC1"]').waitFor({ timeout: 30_000 });
}

/**
 * The loudest level (dBFS) of `userId`'s audio as this app decodes it, over about 400 ms:
 * the remote element's stream through an analyser in the page. Proves audio arrives,
 * independently of LiveKit's speaker detection. (A string: this file has no DOM types.)
 */
function receivedLevelDb(page: Page, userId: string): Promise<number> {
  return page.evaluate(`(async (id) => {
    const el = document.querySelector('audio[data-voice-user="' + id + '"]');
    const stream = el && el.srcObject;
    if (!(stream instanceof MediaStream)) return -200;
    const ctx = new AudioContext();
    try {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      let peak = -200;
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 50));
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        const rms = Math.sqrt(sum / buf.length);
        peak = Math.max(peak, rms > 0 ? 20 * Math.log10(rms) : -200);
      }
      return peak;
    } finally {
      await ctx.close();
    }
  })(${JSON.stringify(userId)})`);
}

/** The tile (stage) or row (sidebar) of `nickname`. */
const tile = (page: Page, nickname: string) => page.locator('[data-voice-stage] [data-user]', { hasText: nickname });
const row = (page: Page, channelId: string, nickname: string) => page.locator(`[data-voice-participants="${channelId}"] [data-user]`, { hasText: nickname });

describe.skipIf(!binary)('voice between two app instances (real LiveKit, fake devices)', () => {
  beforeAll(async () => {
    const port = await freeLoopbackPort();
    dataDir = mkdtempSync(join(tmpdir(), 'ghostlink-e2e-server-'));
    speechWav = join(dataDir, 'speech.wav');
    writeSpeechWav(speechWav);
    server = await startServer({
      dataDir,
      port,
      host: '127.0.0.1',
      name: 'Servidor E2E',
      publicAddresses: [`127.0.0.1:${port}`],
      joinMode: 'invite',
      logger: silentLogger,
      modules: [new E2eText(), createVoiceModule()],
      voice: { binaryPath: binary!, ...(await freeMediaPorts()) },
    });
  });

  afterAll(async () => {
    for (const i of instances.splice(0)) {
      await i.app.close().catch(() => {});
      rmSync(i.userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
    await server?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('both join, receive each other, and mute, deafen, speaking, server mute and move work', async () => {
    const ana = await launch('ana');
    const bia = await launch('bia');
    try {
      await onboardAndJoin(ana.page, 'Ana', server!.createInvite().pasteCode);
      await onboardAndJoin(bia.page, 'Bia', server!.createInvite().pasteCode);

      // Both join the same voice channel from the sidebar.
      await ana.page.locator('[data-voice-channel="VC1"]').click();
      await ana.page.locator('[data-voice-panel="connected"]').waitFor({ timeout: 30_000 });
      await bia.page.locator('[data-voice-channel="VC1"]').click();
      await bia.page.locator('[data-voice-panel="connected"]').waitFor({ timeout: 30_000 });

      // Each receives the other's microphone: a subscribed remote audio track, attached.
      await expect.poll(() => tile(ana.page, 'Bia').getAttribute('data-receiving'), { timeout: 30_000 }).toBe('true');
      await expect.poll(() => tile(bia.page, 'Ana').getAttribute('data-receiving'), { timeout: 30_000 }).toBe('true');
      expect(await ana.page.locator('audio[data-voice-track="remote"]').count()).toBeGreaterThanOrEqual(1);
      expect(await bia.page.locator('audio[data-voice-track="remote"]').count()).toBeGreaterThanOrEqual(1);
      const anaId = (await tile(bia.page, 'Ana').getAttribute('data-user'))!;
      const biaId = (await tile(ana.page, 'Bia').getAttribute('data-user'))!;
      // Real audio arrives each way (the fake microphones' speech-like signal), decoded in the other app.
      await expect.poll(() => receivedLevelDb(bia.page, anaId), { timeout: 20_000 }).toBeGreaterThan(-40);
      await expect.poll(() => receivedLevelDb(ana.page, biaId), { timeout: 20_000 }).toBeGreaterThan(-40);

      // The fake microphone's voice reaches LiveKit: the other side sees Ana speaking.
      await expect.poll(() => tile(bia.page, 'Ana').getAttribute('data-speaking'), { timeout: 30_000 }).toBe('true');
      await ana.page.screenshot({ path: join(tmpdir(), 'ghostlink-e2e-voice-ana.png') });

      // Mute and deafen show on the other side (voice.selfState → voice.state).
      await ana.page.locator('[data-voice-control="mute"]').click();
      await row(bia.page, 'VC1', 'Ana').getByRole('img', { name: 'Microfone desligado' }).waitFor({ timeout: 10_000 });
      await ana.page.locator('[data-voice-control="mute"]').click();
      await row(bia.page, 'VC1', 'Ana').getByRole('img', { name: 'Microfone desligado' }).waitFor({ state: 'detached', timeout: 10_000 });
      await ana.page.locator('[data-voice-control="deafen"]').click();
      await row(bia.page, 'VC1', 'Ana').getByRole('img', { name: 'Áudio desligado' }).waitFor({ timeout: 10_000 });
      await ana.page.locator('[data-voice-control="deafen"]').click();
      await row(bia.page, 'VC1', 'Ana').getByRole('img', { name: 'Áudio desligado' }).waitFor({ state: 'detached', timeout: 10_000 });
      // After muting and deafening, her voice is back on the air.
      await expect.poll(() => tile(bia.page, 'Ana').getAttribute('data-speaking'), { timeout: 30_000 }).toBe('true');

      // Server mute from Ana (moderator): Bia's microphone goes off the air until unmuted.
      await row(ana.page, 'VC1', 'Bia').click();
      await ana.page.getByRole('menuitem', { name: 'Silenciar no servidor' }).click();
      await bia.page.locator('[data-voice-control="mute"][aria-label="Silenciado pelo servidor"]').waitFor({ timeout: 15_000 });
      await row(ana.page, 'VC1', 'Bia').getByRole('img', { name: 'Silenciado pelo servidor' }).waitFor({ timeout: 15_000 });
      await expect.poll(() => tile(ana.page, 'Bia').getAttribute('data-receiving'), { timeout: 15_000 }).toBeNull();
      await row(ana.page, 'VC1', 'Bia').click();
      await ana.page.getByRole('menuitem', { name: 'Reativar no servidor' }).click();
      await bia.page.locator('[data-voice-control="mute"][aria-label="Silenciar"]').waitFor({ timeout: 15_000 });
      await expect.poll(() => tile(ana.page, 'Bia').getAttribute('data-receiving'), { timeout: 30_000 }).toBe('true');

      // Move: Bia's app joins the other channel by itself.
      await row(ana.page, 'VC1', 'Bia').click();
      await ana.page.getByRole('menuitem', { name: 'Mover para Sala 2' }).click();
      await row(bia.page, 'VC2', 'Bia').waitFor({ timeout: 20_000 });
      await expect.poll(() => bia.page.locator('[data-voice-panel="connected"]').textContent(), { timeout: 20_000 }).toContain('Sala 2');
      await row(ana.page, 'VC2', 'Bia').waitFor({ timeout: 20_000 });
      await bia.page.locator('[data-voice-stage="VC2"]').waitFor({ timeout: 10_000 });
      await bia.page.screenshot({ path: join(tmpdir(), 'ghostlink-e2e-voice-bia.png') });

      // Push-to-talk: Bia comes back; Ana binds V. Ana is silent until she holds it.
      await bia.page.locator('[data-voice-channel="VC1"]').click();
      await expect.poll(() => tile(bia.page, 'Ana').getAttribute('data-receiving'), { timeout: 30_000 }).toBe('true');
      await ana.page.getByRole('button', { name: 'Configurações de voz' }).click();
      await ana.page.locator('[data-voice-settings]').waitFor();
      await ana.page.getByRole('radio', { name: 'Aperte para falar' }).check();
      await ana.page.locator('[data-voice-record-key]').click();
      await ana.page.keyboard.press('v');
      await expect.poll(() => ana.page.locator('[data-voice-settings] kbd').textContent()).toBe('V');
      // The global hook (uiohook-napi) loaded in this Electron: push-to-talk also works from a game.
      await ana.page.getByText('Funciona mesmo com outro programa em foco, como um jogo.').waitFor({ timeout: 10_000 });
      await ana.page.screenshot({ path: join(tmpdir(), 'ghostlink-e2e-voice-settings.png') });
      await ana.page.getByRole('button', { name: 'Fechar', exact: true }).click();
      await expect.poll(() => tile(ana.page, 'Ana').getAttribute('data-speaking'), { timeout: 5_000 }).toBeNull();
      await expect.poll(() => receivedLevelDb(bia.page, anaId), { timeout: 10_000 }).toBeLessThan(-60);
      await expect.poll(() => tile(bia.page, 'Ana').getAttribute('data-speaking'), { timeout: 20_000 }).toBeNull();
      await ana.page.keyboard.down('v');
      // Her own ring follows her gate at once; her voice reaches Bia, and LiveKit reports her.
      await expect.poll(() => tile(ana.page, 'Ana').getAttribute('data-speaking'), { timeout: 5_000 }).toBe('true');
      await expect.poll(() => receivedLevelDb(bia.page, anaId), { timeout: 10_000 }).toBeGreaterThan(-40);
      await expect.poll(() => tile(bia.page, 'Ana').getAttribute('data-speaking'), { timeout: 30_000 }).toBe('true');
      await ana.page.keyboard.up('v');
      await expect.poll(() => tile(ana.page, 'Ana').getAttribute('data-speaking'), { timeout: 5_000 }).toBeNull();
      await expect.poll(() => receivedLevelDb(bia.page, anaId), { timeout: 10_000 }).toBeLessThan(-60);
      await expect.poll(() => tile(bia.page, 'Ana').getAttribute('data-speaking'), { timeout: 20_000 }).toBeNull();

      // Leaving ends the call.
      await bia.page.locator('[data-voice-panel]').getByRole('button', { name: 'Desconectar', exact: true }).click();
      await bia.page.locator('[data-voice-panel]').waitFor({ state: 'detached', timeout: 10_000 });
      await row(ana.page, 'VC1', 'Bia').waitFor({ state: 'detached', timeout: 20_000 });
    } catch (e) {
      console.log([...ana.log, ...bia.log].slice(-80).join('\n'));
      await ana.page.screenshot({ path: join(tmpdir(), 'ghostlink-e2e-fail-ana.png') }).catch(() => {});
      await bia.page.screenshot({ path: join(tmpdir(), 'ghostlink-e2e-fail-bia.png') }).catch(() => {});
      throw e;
    }
  });
});
