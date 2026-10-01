// Screen sharing end to end (spec 2026-10-01-transmitir-tela-design.md §10): two built app
// instances. Ana hosts and Bia joins by invite, both enter voice; Ana picks the first screen
// in GhostLink's own picker (main's display-media handler hands it over, so no
// GHOSTLINK_E2E_PICK is needed); Bia sees "AO VIVO", watches, receives decoded frames, stops
// watching; Ana stops and the badge goes away. The PC's sound cannot be checked with fake
// devices: it is on the manual checklist.
// Run with `npm run test:e2e` (builds the app first). Skipped without the LiveKit binary.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { afterAll, describe, expect, it, type TestContext } from 'vitest';
import { freeLoopbackPort } from '../../../server/src/livekit/backend.js';
import { resolveLivekitBinary } from '../../../server/src/livekit/binary.js';
import { E2eRun, joinWithInvite, onboard, textChannel, tile, voiceChannel, voiceRow, type Instance } from './harness.js';

const binary = resolveLivekitBinary();
const SERVER = 'Servidor Tela';

/** readyState and videoWidth of `userId`'s watched screen, or null without one. (A string: the tests have no DOM types.) */
function screenVideo(page: Page, userId: string): Promise<{ readyState: number; width: number; height: number } | null> {
  return page.evaluate(`(() => {
    const v = document.querySelector('video[data-screen-video="${userId}"]');
    return v ? { readyState: v.readyState, width: v.videoWidth, height: v.videoHeight } : null;
  })()`);
}

/** Frames my own preview shows (the local track attached to the panel's <video>). */
function previewWidth(page: Page): Promise<number> {
  return page.evaluate(`(() => {
    const v = document.querySelector('[data-screen-sharing] video');
    return v ? v.videoWidth : -1;
  })()`);
}

describe.skipIf(!binary)('screen sharing: Ana shares a screen, Bia watches it', () => {
  const run = new E2eRun();
  let ana!: Instance;
  let bia!: Instance;
  let sala = '';
  let anaId = '';
  /** Ana's share carries the PC's sound (the capture excluded GhostLink's own audio). */
  let withSound = false;
  let broken = false;

  const step = (name: string, timeout: number, fn: () => Promise<void>) =>
    it(name, async (ctx: TestContext) => {
      if (broken) ctx.skip();
      try {
        await fn();
      } catch (e) {
        broken = true;
        await run.report(`screen-${name.split(':')[0]!}`);
        throw e;
      }
    }, timeout);

  afterAll(() => run.close(), 180_000);

  step('setup: Ana hosts, Bia joins by invite, and both enter voice', 240_000, async () => {
    ana = await run.launch('ana', { GHOSTLINK_HOST_BIND: '127.0.0.1' });
    bia = await run.launch('bia');
    const port = await freeLoopbackPort();

    await onboard(ana.page, 'Ana', 'Hospedar um servidor');
    await ana.page.getByRole('dialog', { name: 'Criar um servidor' }).getByRole('button', { name: /^Neste computador/ }).click();
    const form = ana.page.getByRole('dialog', { name: 'Hospedar um servidor' });
    await form.getByLabel('Nome do servidor').fill(SERVER);
    await form.getByLabel('Porta', { exact: true }).fill(String(port));
    await form.getByRole('button', { name: 'Hospedar' }).click();
    await textChannel(ana.page, 'geral').waitFor({ timeout: 90_000 });
    const status = (await ana.page.evaluate('window.ghostlink.host.status()')) as { state: string; busyMediaPorts: string[] };
    expect(status.state).toBe('running');
    // LiveKit's fixed media ports (UDP 7882, TCP 7881) were free, so voice can work.
    expect(status.busyMediaPorts).toEqual([]);

    await ana.page.getByRole('button', { name: /Menu do servidor/ }).click();
    await ana.page.getByRole('menuitem', { name: 'Convidar pessoas' }).click();
    const invite = ana.page.getByRole('dialog', { name: `Convidar pessoas para ${SERVER}` });
    await invite.getByRole('button', { name: 'Gerar convite' }).click();
    const link = ((await invite.locator('code').first().textContent()) ?? '').trim();
    await invite.getByRole('button', { name: 'Fechar', exact: true }).click();

    await onboard(bia.page, 'Bia', 'Entrar num servidor');
    await joinWithInvite(bia.page, link);
    await textChannel(bia.page, 'geral').waitFor({ timeout: 30_000 });
    sala = (await voiceChannel(ana.page, 'Sala de voz').getAttribute('data-voice-channel'))!;

    await voiceChannel(ana.page, 'Sala de voz').click();
    await ana.page.locator('[data-voice-panel="connected"]').waitFor({ timeout: 30_000 });
    await voiceChannel(bia.page, 'Sala de voz').click();
    await bia.page.locator('[data-voice-panel="connected"]').waitFor({ timeout: 30_000 });
    await expect.poll(() => tile(bia.page, 'Ana').getAttribute('data-receiving'), { timeout: 30_000 }).toBe('true');
    anaId = (await tile(bia.page, 'Ana').getAttribute('data-user'))!;
  });

  step('share: Ana opens the picker and picks the first screen', 90_000, async () => {
    await ana.page.locator('[data-screen-share="start"]').click();
    const picker = ana.page.getByRole('dialog', { name: 'Transmitir tela' });
    // Thumbnails take up to a few seconds on Windows: the picker shows a loading state first.
    const first = picker.locator('[data-screen-source="screen"]').first();
    await first.waitFor({ timeout: 30_000 });
    // The real screens are listed (main's desktopCapturer), even with Chromium's fake devices.
    expect(await picker.locator('[data-screen-source="screen"]').count()).toBeGreaterThanOrEqual(1);
    await ana.page.screenshot({ path: join(tmpdir(), 'ghostlink-e2e-screen-picker.png') });
    await first.click();
    expect(await first.getAttribute('aria-checked')).toBe('true');
    await picker.getByRole('button', { name: 'Transmitir', exact: true }).click();
    await picker.waitFor({ state: 'detached', timeout: 10_000 });

    // Live: the panel shows the badge and a preview with frames; the stage shows her own tile.
    await ana.page.locator('[data-screen-sharing]').waitFor({ timeout: 20_000 });
    await expect.poll(() => previewWidth(ana.page), { timeout: 20_000 }).toBeGreaterThan(0);
    await ana.page.locator(`[data-voice-stage] [data-screen-tile="${await tile(ana.page, 'Ana').getAttribute('data-user')}"]`).waitFor();
    // With fake devices the PC's sound may or may not be captured; either way the picture goes.
    const noticeBar = ana.page.locator('[data-voice-notice]');
    const notice = (await noticeBar.count()) > 0 ? await noticeBar.getAttribute('data-voice-notice') : null;
    // The panel says whether the sound goes (it does only when Chromium excluded GhostLink's own audio).
    withSound = (await ana.page.locator('[data-screen-sharing] [role="img"]').getAttribute('aria-label')) === 'Com o som do PC';
    console.log(`[screen e2e] Ana's notice after going live: ${notice ?? 'none'}; sound: ${withSound}`);
    expect(notice === null || notice === 'screenAudio').toBe(true);
    expect(withSound).toBe(notice === null);
    await ana.page.screenshot({ path: join(tmpdir(), 'ghostlink-e2e-screen-live-ana.png') });
  });

  step('watch: Bia sees AO VIVO, clicks Assistir, and receives decoded frames', 90_000, async () => {
    // The voice channel's list and the stage say Ana is live (voice.state → screen).
    await voiceRow(bia.page, sala, 'Ana').locator('[data-screen-live-badge]').waitFor({ timeout: 30_000 });
    const watch = bia.page.locator(`[data-screen-watch="${anaId}"]`);
    await watch.waitFor({ timeout: 10_000 });
    // Not watched yet: no video is received (opt-in subscription, spec §8.4).
    expect(await screenVideo(bia.page, anaId)).toBeNull();
    await watch.click();
    await expect.poll(async () => (await screenVideo(bia.page, anaId))?.readyState ?? 0, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    await expect.poll(async () => (await screenVideo(bia.page, anaId))?.width ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
    const frame = await screenVideo(bia.page, anaId);
    console.log(`[screen e2e] Bia receives Ana's screen at ${frame?.width}×${frame?.height}`);
    // The stream's sound is subscribed with the picture, and plays apart from Ana's voice.
    if (withSound) await bia.page.locator(`audio[data-screen-user="${anaId}"]`).waitFor({ state: 'attached', timeout: 20_000 });
    await bia.page.screenshot({ path: join(tmpdir(), 'ghostlink-e2e-screen-watch-bia.png') });
  });

  step('stop watching: the video goes away and "Assistir" is back', 60_000, async () => {
    await bia.page.locator(`[data-screen-unwatch="${anaId}"]`).click();
    await bia.page.locator(`video[data-screen-video="${anaId}"]`).waitFor({ state: 'detached', timeout: 10_000 });
    await bia.page.locator(`audio[data-screen-user="${anaId}"]`).waitFor({ state: 'detached', timeout: 10_000 });
    await bia.page.locator(`[data-screen-watch="${anaId}"]`).waitFor({ timeout: 10_000 });
    // Her voice is still received.
    expect(await tile(bia.page, 'Ana').getAttribute('data-receiving')).toBe('true');
  });

  step('stop: Ana stops sharing and the badge goes away for Bia', 60_000, async () => {
    await ana.page.locator('[data-screen-share="stop"]').click();
    await ana.page.locator('[data-screen-sharing]').waitFor({ state: 'detached', timeout: 10_000 });
    await voiceRow(bia.page, sala, 'Ana').locator('[data-screen-live-badge]').waitFor({ state: 'detached', timeout: 30_000 });
    await bia.page.locator(`[data-screen-tile="${anaId}"]`).waitFor({ state: 'detached', timeout: 10_000 });
  });
});
