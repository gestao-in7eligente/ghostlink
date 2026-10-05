// The pencil on shared screens end to end (spec 2026-10-01-lapis-na-tela-design.md §5): two built
// app instances. Ana hosts and shares her first screen, Bia joins by invite and sees it; Bia turns
// the pencil on and drags across the stream: her canvas shows the stroke at once, and Ana receives
// it on the overlay over her real monitor and on her own preview. Ana turns "Permitir desenhos"
// off and Bia's pencil goes away (the server refuses a stroke too); when Ana stops sharing, the
// overlay closes. Then Ana shares Bia's window (Windows only): the overlay sits over that window,
// receives Bia's strokes and follows the window when it moves and resizes. Whether the overlay
// shows on the right monitor, and never in the video, is on the manual checklist. Run with `npm run test:e2e` (builds the app first). Skipped without LiveKit.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { afterAll, describe, expect, it, type TestContext } from 'vitest';
import { freeLoopbackPort } from '../../../server/src/livekit/backend.js';
import { resolveLivekitBinary } from '../../../server/src/livekit/binary.js';
import { E2eRun, joinWithInvite, onboard, requestOutcome, textChannel, tile, voiceChannel, voiceRow, type Instance } from './harness.js';

const binary = resolveLivekitBinary();
const SERVER = 'Servidor Lápis';

/** Painted pixels of a pencil canvas (-1 without one). (A string: the tests have no DOM types.) */
function paintedPixels(page: Page, selector: string): Promise<number> {
  return page.evaluate(`(() => {
    const canvas = document.querySelector(${JSON.stringify(selector)});
    if (!canvas || canvas.width === 0 || canvas.height === 0) return -1;
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n++;
    return n;
  })()`);
}

/** The overlay window over Ana's shared monitor, if open. */
function overlayPage(i: Instance): Page | null {
  return i.app.windows().find((w) => !w.isClosed() && w.url().includes('drawOverlay.html')) ?? null;
}

/** How many points the overlay received. */
async function overlayPoints(i: Instance): Promise<number> {
  const page = overlayPage(i);
  if (!page) return -1;
  return Number((await page.evaluate('document.documentElement.dataset.points ?? "0"').catch(() => '0')) as string);
}

type Bounds = { x: number; y: number; width: number; height: number };

/** The overlay window's bounds (DIPs) and whether it shows, from the instance's main process; null without one. */
function overlayWindow(i: Instance): Promise<{ bounds: Bounds; visible: boolean } | null> {
  return i.app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes('drawOverlay.html'));
    return w ? { bounds: w.getBounds(), visible: w.isVisible() } : null;
  });
}

/** The instance's main window: its media source id ("window:<HWND>:<n>") and bounds (DIPs). */
function mainWindow(i: Instance): Promise<{ source: string; bounds: Bounds }> {
  return i.app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes('index.html'))!;
    return { source: w.getMediaSourceId(), bounds: w.getBounds() };
  });
}

function setMainWindowBounds(i: Instance, bounds: Bounds): Promise<void> {
  return i.app.evaluate(({ BrowserWindow }, b) => {
    BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes('index.html'))!.setBounds(b);
  }, bounds);
}

/**
 * The overlay covers the window's visible frame (DWMWA_EXTENDED_FRAME_BOUNDS); getBounds() may also
 * count the invisible resize borders (a few DIPs per side), hence the tolerance.
 */
function near(a: Bounds | undefined, b: Bounds, tolerance = 16): boolean {
  return !!a && Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance && Math.abs(a.width - b.width) <= 2 * tolerance && Math.abs(a.height - b.height) <= 2 * tolerance;
}

describe.skipIf(!binary)('the pencil: Bia draws on the screen Ana shares', () => {
  const run = new E2eRun();
  let ana!: Instance;
  let bia!: Instance;
  let sala = '';
  let anaId = '';
  let broken = false;
  /** Bia's main window as Ana shares it (window steps). */
  let biaWindow!: { source: string; bounds: Bounds };

  const step = (name: string, timeout: number, fn: () => Promise<void>) =>
    it(name, async (ctx: TestContext) => {
      if (broken) ctx.skip();
      try {
        await fn();
      } catch (e) {
        broken = true;
        await run.report(`draw-${name.split(':')[0]!}`);
        throw e;
      }
    }, timeout);

  afterAll(() => run.close(), 180_000);

  step('setup: Ana hosts, Bia joins by invite, both enter voice, Ana shares a screen and Bia watches', 300_000, async () => {
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
    anaId = (await tile(bia.page, 'Ana').getAttribute('data-user'))!;

    await ana.page.locator('[data-screen-share="start"]').click();
    const picker = ana.page.getByRole('dialog', { name: 'Transmitir tela' });
    const first = picker.locator('[data-screen-source="screen"]').first();
    await first.waitFor({ timeout: 30_000 });
    await first.click();
    await picker.getByRole('button', { name: 'Transmitir', exact: true }).click();
    await ana.page.locator('[data-screen-sharing]').waitFor({ timeout: 20_000 });

    await voiceRow(bia.page, sala, 'Ana').locator('[data-screen-live-badge]').waitFor({ timeout: 30_000 });
    // Watched without a click (owner, 2026-10-02): the picture plays in Ana's stream tile.
    await expect
      .poll(async () => bia.page.evaluate(`document.querySelector('video[data-screen-video="${anaId}"]')?.videoWidth ?? 0`), { timeout: 30_000 })
      .toBeGreaterThan(0);
  });

  step('overlay: sharing a whole screen opens the overlay over that monitor', 30_000, async () => {
    await expect.poll(() => overlayPage(ana) !== null, { timeout: 15_000 }).toBe(true);
    // Ana's switch starts on, and Ana has the pencil on her own share too.
    expect(await ana.page.getByRole('switch', { name: 'Permitir desenhos' }).getAttribute('aria-checked')).toBe('true');
    await ana.page.locator(`[data-voice-stage] [data-draw-pencil="${anaId}"]`).waitFor({ timeout: 10_000 });
  });

  step('draw: Bia turns the pencil on and drags; Ana gets the stroke on the overlay and her preview', 60_000, async () => {
    const pencil = bia.page.locator(`[data-draw-pencil="${anaId}"]`);
    await pencil.click();
    expect(await pencil.getAttribute('aria-pressed')).toBe('true');
    await bia.page.locator(`[data-draw-layer="${anaId}"][data-draw-active]`).waitFor({ timeout: 5_000 });

    const box = (await bia.page.locator(`[data-screen-view="${anaId}"]`).boundingBox())!;
    const at = (fx: number, fy: number) => [box.x + box.width * fx, box.y + box.height * fy] as const;
    await bia.page.mouse.move(...at(0.3, 0.35));
    await bia.page.mouse.down();
    await bia.page.mouse.move(...at(0.5, 0.45), { steps: 15 });
    await bia.page.mouse.move(...at(0.65, 0.3), { steps: 15 });
    // Held down: the stroke stays (it fades only ~3 s after it ends).
    try {
      // Bia's own stroke shows at once.
      await expect.poll(() => paintedPixels(bia.page, `[data-screen-view="${anaId}"] [data-draw-layer]`), { timeout: 5_000 }).toBeGreaterThan(50);
      await bia.page.screenshot({ path: join(tmpdir(), 'ghostlink-e2e-draw-viewer-bia.png') });
      // Ana: the overlay over her real monitor received the points, and her preview shows them.
      await expect.poll(() => overlayPoints(ana), { timeout: 10_000 }).toBeGreaterThan(5);
      await expect.poll(() => paintedPixels(ana.page, `[data-voice-stage] [data-draw-layer="${anaId}"]`), { timeout: 10_000 }).toBeGreaterThan(20);
      await ana.page.screenshot({ path: join(tmpdir(), 'ghostlink-e2e-draw-preview-ana.png') });
      console.log(`[draw e2e] overlay points: ${await overlayPoints(ana)}`);
    } finally {
      await bia.page.mouse.up();
    }
    // Once ended, the stroke fades out after ~3 s, on both sides.
    await expect.poll(() => paintedPixels(bia.page, `[data-screen-view="${anaId}"] [data-draw-layer]`), { timeout: 8_000 }).toBe(0);
    await expect.poll(() => paintedPixels(ana.page, `[data-voice-stage] [data-draw-layer="${anaId}"]`), { timeout: 8_000 }).toBe(0);
  });

  step('Esc: Bia stops drawing with Esc', 20_000, async () => {
    await bia.page.keyboard.press('Escape');
    expect(await bia.page.locator(`[data-draw-pencil="${anaId}"]`).getAttribute('aria-pressed')).toBe('false');
    expect(await bia.page.locator(`[data-draw-layer="${anaId}"][data-draw-active]`).count()).toBe(0);
  });

  step('fullscreen: Bia draws on the stream in fullscreen too', 30_000, async () => {
    // The canvas is inside the stream's box, which is the fullscreen element.
    const view = `[data-screen-view="${anaId}"]`;
    const which = () => bia.page.evaluate(`(() => { const f = document.fullscreenElement; return f ? (f.getAttribute('data-screen-view') ?? f.tagName) : 'none'; })()`);
    await bia.page.locator(`[data-screen-fullscreen="${anaId}"]`).click();
    await expect.poll(which, { timeout: 5_000 }).toBe(anaId);
    const pencil = bia.page.locator(`[data-draw-pencil="${anaId}"]`);
    await pencil.click();
    expect(await pencil.getAttribute('aria-pressed')).toBe('true');
    const box = (await bia.page.locator(view).boundingBox())!;
    await bia.page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.6);
    await bia.page.mouse.down();
    await bia.page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.65, { steps: 20 });
    await expect.poll(() => paintedPixels(bia.page, `${view} [data-draw-layer]`), { timeout: 5_000 }).toBeGreaterThan(50);
    // Ana gets it as from the normal view.
    const before = await overlayPoints(ana);
    await bia.page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.4, { steps: 10 });
    await expect.poll(() => overlayPoints(ana), { timeout: 10_000 }).toBeGreaterThan(before);
    await bia.page.screenshot({ path: join(tmpdir(), 'ghostlink-e2e-draw-fullscreen-bia.png') });
    await bia.page.mouse.up();
    // Esc leaves the pencil (Electron may take the first Esc to leave fullscreen).
    await bia.page.keyboard.press('Escape');
    if ((await pencil.getAttribute('aria-pressed')) === 'true') await bia.page.keyboard.press('Escape');
    expect(await pencil.getAttribute('aria-pressed')).toBe('false');
    console.log(`[draw e2e] after Esc in fullscreen: ${await which()}`);
    await bia.page.evaluate('document.fullscreenElement ? document.exitFullscreen() : null');
    await expect.poll(which, { timeout: 5_000 }).toBe('none');
  });

  step('allow: Ana turns "Permitir desenhos" off and Bia\'s pencil goes away', 30_000, async () => {
    const allow = ana.page.getByRole('switch', { name: 'Permitir desenhos' });
    await allow.click();
    expect(await allow.getAttribute('aria-checked')).toBe('false');
    await bia.page.locator(`[data-draw-pencil="${anaId}"]`).waitFor({ state: 'detached', timeout: 10_000 });
    // The server refuses a stroke as well.
    const stroke = { channelId: sala, sharerId: anaId, strokeId: 'e2e', points: [[0.5, 0.5]], end: true };
    expect(await requestOutcome(bia.page, 'screen.draw', stroke)).toBe('FORBIDDEN');
    // On again: the pencil is back.
    await allow.click();
    await bia.page.locator(`[data-draw-pencil="${anaId}"]`).waitFor({ timeout: 10_000 });
  });

  step('stop: when Ana stops sharing, the overlay closes', 30_000, async () => {
    await ana.page.locator('[data-screen-share="stop"]').click();
    await ana.page.locator('[data-screen-sharing]').waitFor({ state: 'detached', timeout: 10_000 });
    await expect.poll(() => overlayPage(ana) === null, { timeout: 10_000 }).toBe(true);
    await bia.page.locator(`[data-draw-pencil="${anaId}"]`).waitFor({ state: 'detached', timeout: 30_000 });
  });

  // Over a shared window (spec §4): Windows only, where koffi reads the window's place.
  const windowStep = (name: string, timeout: number, fn: () => Promise<void>) =>
    process.platform === 'win32' ? step(name, timeout, fn) : it.skip(name, () => {});

  windowStep("window: Ana shares Bia's window; the overlay sits over it and receives Bia's strokes", 90_000, async () => {
    biaWindow = await mainWindow(bia);
    await ana.page.locator('[data-screen-share="start"]').click();
    const picker = ana.page.getByRole('dialog', { name: 'Transmitir tela' });
    await picker.getByRole('tab', { name: 'Janelas' }).click();
    // desktopCapturer lists it as "window:<HWND>:0"; getMediaSourceId() ends with another number.
    const hwnd = biaWindow.source.split(':')[1]!;
    const source = picker.locator(`[data-screen-source-id^="window:${hwnd}:"]`);
    await source.waitFor({ timeout: 30_000 });
    await source.click();
    await picker.getByRole('button', { name: 'Transmitir', exact: true }).click();
    await ana.page.locator('[data-screen-sharing]').waitFor({ timeout: 20_000 });
    await expect.poll(() => overlayPage(ana) !== null, { timeout: 15_000 }).toBe(true);
    await expect.poll(async () => near((await overlayWindow(ana))?.bounds, biaWindow.bounds), { timeout: 5_000 }).toBe(true);
    console.log(`[draw e2e] Bia's window ${JSON.stringify(biaWindow.bounds)}, overlay ${JSON.stringify((await overlayWindow(ana))?.bounds)}`);

    await voiceRow(bia.page, sala, 'Ana').locator('[data-screen-live-badge]').waitFor({ timeout: 30_000 });
    // Watched without a click (owner, 2026-10-02): the picture plays in Ana's stream tile.
    await expect
      .poll(async () => bia.page.evaluate(`document.querySelector('video[data-screen-video="${anaId}"]')?.videoWidth ?? 0`), { timeout: 30_000 })
      .toBeGreaterThan(0);
    const pencil = bia.page.locator(`[data-draw-pencil="${anaId}"]`);
    await pencil.click();
    expect(await pencil.getAttribute('aria-pressed')).toBe('true');
    const box = (await bia.page.locator(`[data-screen-view="${anaId}"]`).boundingBox())!;
    await bia.page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4);
    await bia.page.mouse.down();
    try {
      await bia.page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 20 });
      await expect.poll(() => overlayPoints(ana), { timeout: 10_000 }).toBeGreaterThan(5);
      // Shown over the window while the stroke lasts (the window is on screen, not minimized).
      expect((await overlayWindow(ana))?.visible).toBe(true);
    } finally {
      await bia.page.mouse.up();
    }
  });

  windowStep("window: the overlay follows Bia's window when it moves and resizes", 30_000, async () => {
    const b = biaWindow.bounds;
    await setMainWindowBounds(bia, { x: b.x + 80, y: b.y + 40, width: b.width - 160, height: b.height - 80 });
    const moved = (await mainWindow(bia)).bounds;
    expect(moved).not.toEqual(b);
    await expect.poll(async () => near((await overlayWindow(ana))?.bounds, moved), { timeout: 5_000 }).toBe(true);
    console.log(`[draw e2e] Bia's window moved to ${JSON.stringify(moved)}, overlay ${JSON.stringify((await overlayWindow(ana))?.bounds)}`);
    await setMainWindowBounds(bia, b);
    await expect.poll(async () => near((await overlayWindow(ana))?.bounds, b), { timeout: 5_000 }).toBe(true);
  });

  windowStep("window: when Ana stops sharing Bia's window, the overlay closes", 30_000, async () => {
    await bia.page.keyboard.press('Escape');
    await ana.page.locator('[data-screen-share="stop"]').click();
    await ana.page.locator('[data-screen-sharing]').waitFor({ state: 'detached', timeout: 10_000 });
    await expect.poll(() => overlayPage(ana) === null, { timeout: 10_000 }).toBe(true);
  });
});
