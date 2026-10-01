// The camera end to end (spec 2026-10-01-camera-design.md §4): two built app instances with
// Chromium's fake camera (--use-fake-device-for-media-stream). Ana hosts and Bia joins by
// invite, both enter voice; Ana turns her camera on in the call bar; she sees herself
// mirrored, and Bia, without clicking anything, receives decoded frames in Ana's tile; the
// channel list shows the camera; Ana turns it off in the panel and Bia's tile is back to
// the photo. A real camera, switching devices mid-call, 1080p and a bad connection are on
// the manual checklist.
// Run with `npm run test:e2e` (builds the app first). Skipped without the LiveKit binary.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { afterAll, describe, expect, it, type TestContext } from 'vitest';
import { freeLoopbackPort } from '../../../server/src/livekit/backend.js';
import { resolveLivekitBinary } from '../../../server/src/livekit/binary.js';
import { E2eRun, joinWithInvite, onboard, textChannel, tile, voiceChannel, voiceRow, type Instance } from './harness.js';

const binary = resolveLivekitBinary();
const SERVER = 'Servidor Câmera';

interface CameraVideo {
  readyState: number;
  width: number;
  height: number;
  /** data-camera-live: the tile shows it (frames are moving). */
  live: boolean;
  /** The computed transform: a mirror is matrix(-1, 0, 0, 1, 0, 0). */
  transform: string;
  /** The video covers the whole tile. */
  fills: boolean;
}

/** `userId`'s camera in the open voice stage, or null without one. (A string: the tests have no DOM types.) */
function cameraVideo(page: Page, userId: string): Promise<CameraVideo | null> {
  return page.evaluate(`(() => {
    const v = document.querySelector('[data-voice-stage] video[data-camera-video="${userId}"]');
    if (!v) return null;
    const tile = v.parentElement.getBoundingClientRect();
    const box = v.getBoundingClientRect();
    return {
      readyState: v.readyState,
      width: v.videoWidth,
      height: v.videoHeight,
      live: v.hasAttribute('data-camera-live'),
      transform: getComputedStyle(v).transform,
      fills: Math.abs(box.width - tile.width) < 1 && Math.abs(box.height - tile.height) < 1 && getComputedStyle(v).objectFit === 'cover',
    };
  })()`);
}

const MIRROR = 'matrix(-1, 0, 0, 1, 0, 0)';

describe.skipIf(!binary)('camera: Ana turns hers on, Bia sees it without asking', () => {
  const run = new E2eRun();
  let ana!: Instance;
  let bia!: Instance;
  let sala = '';
  let anaId = '';
  let biaId = '';
  let broken = false;

  const step = (name: string, timeout: number, fn: () => Promise<void>) =>
    it(name, async (ctx: TestContext) => {
      if (broken) ctx.skip();
      try {
        await fn();
      } catch (e) {
        broken = true;
        await run.report(`camera-${name.split(':')[0]!}`);
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
    biaId = (await tile(ana.page, 'Bia').getAttribute('data-user'))!;

    // Joining does not turn the camera on (spec §3).
    const button = ana.page.locator('[data-camera-control="call"]');
    expect(await button.getAttribute('aria-pressed')).toBe('false');
    expect(await button.getAttribute('aria-label')).toBe('Ligar câmera');
    expect(await cameraVideo(ana.page, anaId)).toBeNull();
    // The ⌄ menu lists the cameras by name without opening one (no getUserMedia just for the names).
    await ana.page.getByRole('button', { name: 'Opções de vídeo' }).click();
    const names = await ana.page.getByRole('menu', { name: 'Câmera' }).getByRole('menuitemradio').allTextContents();
    console.log(`[camera e2e] Ana's cameras: ${names.join(' | ')}`);
    expect(names.length).toBeGreaterThanOrEqual(2);
    expect(names.slice(1).some((n) => /^Dispositivo \d+$/.test(n))).toBe(false);
    await ana.page.keyboard.press('Escape');
  });

  step('on: Ana turns her camera on in the call bar and sees herself mirrored', 90_000, async () => {
    await ana.page.locator('[data-camera-control="call"]').click();
    const button = ana.page.locator('[data-camera-control="call"]');
    expect(await button.getAttribute('aria-pressed')).toBe('true');
    expect(await button.getAttribute('aria-label')).toBe('Desligar câmera');
    expect(await ana.page.locator('[data-camera-control="panel"]').getAttribute('aria-pressed')).toBe('true');
    await expect.poll(async () => (await cameraVideo(ana.page, anaId))?.live ?? false, { timeout: 20_000 }).toBe(true);
    const own = (await cameraVideo(ana.page, anaId))!;
    console.log(`[camera e2e] Ana's self-view: ${own.width}×${own.height}, transform ${own.transform}`);
    expect(own.width).toBeGreaterThan(0);
    expect(own.transform).toBe(MIRROR);
    expect(own.fills).toBe(true);
    expect(await ana.page.locator('[data-voice-notice]').count()).toBe(0);
    await ana.page.screenshot({ path: join(tmpdir(), 'ghostlink-e2e-camera-on-ana.png') });
  });

  step('receive: Bia gets decoded frames in Ana’s tile without clicking anything', 90_000, async () => {
    await expect.poll(async () => (await cameraVideo(bia.page, anaId))?.readyState ?? 0, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    await expect.poll(async () => (await cameraVideo(bia.page, anaId))?.width ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
    await expect.poll(async () => (await cameraVideo(bia.page, anaId))?.live ?? false, { timeout: 10_000 }).toBe(true);
    console.log(`[camera e2e] Bia's first frames of Ana's camera: ${(await cameraVideo(bia.page, anaId))?.width}px wide`);
    // adaptiveStream (spec §1): the SFU starts low, then sends the layer her ~480 px tile needs (360p).
    await expect.poll(async () => (await cameraVideo(bia.page, anaId))?.width ?? 0, { timeout: 30_000 }).toBeGreaterThanOrEqual(640);
    const seen = (await cameraVideo(bia.page, anaId))!;
    console.log(`[camera e2e] Bia receives Ana's camera at ${seen.width}×${seen.height}`);
    // Only Ana sees herself mirrored.
    expect(seen.transform).toBe('none');
    expect(seen.fills).toBe(true);
    // Bia has no camera on: her own tile has none.
    expect(await cameraVideo(bia.page, biaId)).toBeNull();
    // The channel list shows the camera next to Ana, on both sides (voice.state → camera).
    await voiceRow(bia.page, sala, 'Ana').locator('[data-camera-icon]').waitFor({ timeout: 30_000 });
    await voiceRow(ana.page, sala, 'Ana').locator('[data-camera-icon]').waitFor({ timeout: 30_000 });
    expect(await voiceRow(bia.page, sala, 'Bia').locator('[data-camera-icon]').count()).toBe(0);
    // Her voice is still received.
    expect(await tile(bia.page, 'Ana').getAttribute('data-receiving')).toBe('true');
    await bia.page.screenshot({ path: join(tmpdir(), 'ghostlink-e2e-camera-on-bia.png') });
  });

  step('device: Ana picks her camera in the ⌄ menu mid-call, and the picture goes on', 60_000, async () => {
    await ana.page.getByRole('button', { name: 'Opções de vídeo' }).click();
    const menu = ana.page.getByRole('menu', { name: 'Câmera' });
    // Chromium's fake camera is listed by name (the media permission is granted to the app).
    const device = menu.getByRole('menuitemradio').nth(1);
    await device.waitFor({ timeout: 10_000 });
    expect(await menu.getByRole('menuitemradio').first().getAttribute('aria-checked')).toBe('true');
    await device.click();
    await menu.waitFor({ state: 'detached', timeout: 5_000 });
    // switchActiveDevice reopened the camera: still live on both sides, no notice.
    await expect.poll(async () => (await cameraVideo(ana.page, anaId))?.live ?? false, { timeout: 10_000 }).toBe(true);
    await expect.poll(async () => (await cameraVideo(bia.page, anaId))?.live ?? false, { timeout: 10_000 }).toBe(true);
    expect(await ana.page.locator('[data-voice-notice]').count()).toBe(0);
    await ana.page.getByRole('button', { name: 'Opções de vídeo' }).click();
    expect(await ana.page.getByRole('menu', { name: 'Câmera' }).getByRole('menuitemradio').nth(1).getAttribute('aria-checked')).toBe('true');
    await ana.page.keyboard.press('Escape');
  });

  step('off: Ana turns it off in the panel and Bia’s tile is back to the photo', 60_000, async () => {
    await ana.page.locator('[data-camera-control="panel"]').click();
    expect(await ana.page.locator('[data-camera-control="call"]').getAttribute('aria-pressed')).toBe('false');
    await ana.page.locator(`[data-voice-stage] video[data-camera-video="${anaId}"]`).waitFor({ state: 'detached', timeout: 10_000 });
    await bia.page.locator(`[data-voice-stage] video[data-camera-video="${anaId}"]`).waitFor({ state: 'detached', timeout: 30_000 });
    // The photo (or the initials) is what shows in Ana's tile again.
    expect(await tile(bia.page, 'Ana').locator('[aria-hidden="true"]').first().isVisible()).toBe(true);
    await voiceRow(bia.page, sala, 'Ana').locator('[data-camera-icon]').waitFor({ state: 'detached', timeout: 30_000 });
    expect(await tile(bia.page, 'Ana').getAttribute('data-receiving')).toBe('true');
    await bia.page.screenshot({ path: join(tmpdir(), 'ghostlink-e2e-camera-off-bia.png') });
  });

  step('settings: "Voz e vídeo" tests the camera with a live preview, and its quality is what goes out', 90_000, async () => {
    const page = ana.page;
    await page.getByRole('button', { name: 'Configurações do usuário' }).click();
    await page.getByRole('tab', { name: 'Voz e vídeo', exact: true }).click();
    const section = page.locator('[data-video-settings]');
    await section.waitFor({ timeout: 10_000 });
    // The camera, in the app's own Select.
    await page.getByRole('combobox', { name: 'Câmera', exact: true }).click();
    expect(await page.getByRole('listbox').getByRole('option').count()).toBeGreaterThanOrEqual(2);
    await page.keyboard.press('Escape');
    // No preview until "Testar câmera": opening the section does not turn the camera on.
    const preview = page.locator('[data-camera-preview] video');
    expect(await preview.count()).toBe(0);
    await page.locator('[data-camera-test]').click();
    await page.locator('[data-camera-preview] video[data-camera-live]').waitFor({ timeout: 20_000 });
    const size = () =>
      page.evaluate(`(() => {
        const v = document.querySelector('[data-camera-preview] video');
        return v ? [v.videoWidth, v.videoHeight] : null;
      })()`) as Promise<[number, number] | null>;
    expect(await size()).toEqual([1280, 720]);
    // 1080p: the preview reopens at the new size.
    await page.getByRole('combobox', { name: 'Qualidade da câmera', exact: true }).click();
    await page.getByRole('option', { name: /^1080p com 30 FPS/ }).click();
    await expect.poll(size, { timeout: 20_000 }).toEqual([1920, 1080]);
    await page.screenshot({ path: join(tmpdir(), 'ghostlink-e2e-camera-settings.png') });
    // Leaving the section stops the preview.
    await page.getByRole('button', { name: 'Fechar', exact: true }).click();
    await section.waitFor({ state: 'detached', timeout: 10_000 });

    // In the call, the camera now goes out at 1080p; Bia receives it.
    await page.locator('[data-camera-control="call"]').click();
    await expect.poll(async () => (await cameraVideo(page, anaId))?.width ?? 0, { timeout: 20_000 }).toBe(1920);
    await expect.poll(async () => (await cameraVideo(bia.page, anaId))?.live ?? false, { timeout: 30_000 }).toBe(true);
    console.log(`[camera e2e] at 1080p, Bia's first frames are ${(await cameraVideo(bia.page, anaId))?.width}px wide (a lower layer)`);
    // While it is on, the settings preview is that camera, with no test of its own.
    await page.getByRole('button', { name: 'Configurações do usuário' }).click();
    await page.getByRole('tab', { name: 'Voz e vídeo', exact: true }).click();
    await page.locator('[data-camera-preview] video[data-camera-live]').waitFor({ timeout: 10_000 });
    expect(await page.locator('[data-camera-test]').count()).toBe(0);
    await page.getByRole('button', { name: 'Fechar', exact: true }).click();
    // Still on in the call after the settings closed.
    expect((await cameraVideo(page, anaId))?.live).toBe(true);
    await page.locator('[data-camera-control="call"]').click();
    await page.locator(`[data-voice-stage] video[data-camera-video="${anaId}"]`).waitFor({ state: 'detached', timeout: 10_000 });
  });
});
