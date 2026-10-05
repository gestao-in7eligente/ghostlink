// Attachments in a channel end to end (spec 2026-10-01-anexos §5): two built app instances on the
// v0.1 harness. Ana hosts, Bia joins with her invite. Ana sends an image and a PDF in #geral with
// the "+" picker; Bia sees the image (decoded by her page from main's app:// route, which fetched
// it with the signed URL and the pin) and the PDF's card, and "Baixar" saves the PDF. The save
// dialog is not shown: Bia's app runs with GHOSTLINK_E2E_SAVE_DIR (a dev-only hook, never honoured
// when packaged), so main writes straight into that folder. Then a message with three images shows
// the grid and the lightbox. Run with `npm run test:e2e` (builds the app first). Skipped without
// the LiveKit binary.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import type { Locator, Page } from 'playwright-core';
import { afterAll, describe, expect, it, type TestContext } from 'vitest';
import { freeLoopbackPort } from '../../../server/src/livekit/backend.js';
import { resolveLivekitBinary } from '../../../server/src/livekit/binary.js';
import { E2eRun, joinWithInvite, onboard, textChannel, type Instance } from './harness.js';

const binary = resolveLivekitBinary();
const SERVER = 'Servidor dos Anexos';
const TEXT = 'Olha a foto da viagem e o relatório';
const GRID_TEXT = 'Mais três fotos';

const composer = (page: Page) => page.getByRole('combobox', { name: /^Conversar em #geral\b/ });
const message = (page: Page, text: string) => page.getByRole('region', { name: 'Mensagens em #geral' }).getByRole('article').filter({ hasText: text });
const pictures = (scope: Locator) => scope.locator('[data-attachments] img');

/** The decoded width of an <img>, 0 until it has loaded (typed by shape: the tests have no DOM types). */
const naturalWidth = (img: Locator) => img.evaluate((el: { complete: boolean; naturalWidth: number }) => (el.complete ? el.naturalWidth : 0));

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A width×height RGB PNG: a gradient from `from` to `to` with a light band, so each picture looks different. */
function testPng(width: number, height: number, from: [number, number, number], to: [number, number, number]): Buffer {
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    raw[y * row] = 0;
    for (let x = 0; x < width; x++) {
      const k = x / width;
      const band = Math.abs(y - height * (0.3 + 0.4 * k)) < height * 0.06;
      const i = y * row + 1 + x * 3;
      for (let c = 0; c < 3; c++) raw[i + c] = band ? 245 : Math.round(from[c]! + (to[c]! - from[c]!) * (0.5 * k + (0.5 * y) / height));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

/** A small PDF-looking file: the server types it from `%PDF-`; the rest is random so a copy is easy to tell apart. */
function testPdf(): Buffer {
  return Buffer.concat([Buffer.from('%PDF-1.4\n%GhostLink e2e\n'), randomBytes(48 * 1024), Buffer.from('\n%%EOF\n')]);
}

describe.skipIf(!binary)('GhostLink attachments: Ana sends an image and a PDF, Bia sees and downloads', () => {
  const run = new E2eRun();
  let ana!: Instance;
  let bia!: Instance;
  let saveDir!: string;
  let broken = false;
  const photo = testPng(640, 400, [88, 101, 242], [35, 165, 90]);
  const pdf = testPdf();

  /** One scenario step: later steps are skipped once one failed, and a failure dumps logs and screenshots. */
  const step = (name: string, timeout: number, fn: () => Promise<void>) =>
    it(name, async (ctx: TestContext) => {
      if (broken) ctx.skip();
      try {
        await fn();
      } catch (e) {
        broken = true;
        await run.report(`attachments ${name.split(':')[0]!}`);
        throw e;
      }
    }, timeout);

  afterAll(() => run.close(), 180_000);

  step('setup: Ana hosts a server, Bia joins it with an invite', 180_000, async () => {
    saveDir = run.tempDir('saved');
    // Loopback bind (dev-only hook): no firewall prompt, and no UPnP mapping on the router.
    ana = await run.launch('ana', { GHOSTLINK_HOST_BIND: '127.0.0.1' });
    bia = await run.launch('bia', { GHOSTLINK_E2E_SAVE_DIR: saveDir });
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
    expect(link).toMatch(/\/j\/#GL1-/);
    await invite.getByRole('button', { name: 'Fechar', exact: true }).click();

    await onboard(bia.page, 'Bia', 'Entrar num servidor');
    await joinWithInvite(bia.page, link);
    await textChannel(bia.page, 'geral').waitFor({ timeout: 30_000 });
  });

  step('send: Ana picks an image and a PDF with "+", sees them in the tray and sends them with a text', 90_000, async () => {
    const plus = ana.page.getByRole('button', { name: 'Anexar arquivos' });
    await expect.poll(() => plus.isEnabled(), { timeout: 10_000 }).toBe(true);
    await ana.page.locator('[data-attachment-input]').setInputFiles([
      { name: 'viagem.png', mimeType: 'image/png', buffer: photo },
      { name: 'relatorio.pdf', mimeType: 'application/pdf', buffer: pdf },
    ]);
    const tray = ana.page.locator('[data-attachment-tray]');
    await expect.poll(() => tray.locator('[data-tray-item]').count(), { timeout: 10_000 }).toBe(2);
    await tray.locator('[data-tray-item="image"] img').waitFor();
    await ana.page.screenshot({ path: join(tmpdir(), 'ghostlink-e2e-attachments-tray.png') });
    await composer(ana.page).fill(TEXT);
    await composer(ana.page).press('Enter');
    await tray.waitFor({ state: 'detached', timeout: 10_000 });
    // Her own copy comes back from the server with both files.
    const mine = message(ana.page, TEXT);
    await mine.locator('[data-attachment="file"]').waitFor({ timeout: 60_000 });
    await expect.poll(() => naturalWidth(pictures(mine).first()), { timeout: 30_000 }).toBe(640);
  });

  step('see: Bia sees the image decoded and the PDF card', 60_000, async () => {
    const theirs = message(bia.page, TEXT);
    await theirs.waitFor({ timeout: 30_000 });
    const img = pictures(theirs).first();
    await img.waitFor({ timeout: 15_000 });
    expect(await img.getAttribute('src')).toMatch(/^app:\/\/ghostlink\/_file\/[^/]+\/[A-Z2-7]{26}$/);
    await expect.poll(() => naturalWidth(img), { timeout: 30_000 }).toBeGreaterThan(0);
    expect(await naturalWidth(img)).toBe(640);
    const card = theirs.locator('[data-attachment="file"]');
    await expect.poll(() => card.textContent(), { timeout: 10_000 }).toContain('relatorio.pdf');
    expect(await card.textContent()).toContain('48 KB');
  });

  step('download: "Baixar" on the PDF saves exactly its bytes, and nothing opens', 60_000, async () => {
    await message(bia.page, TEXT).getByRole('button', { name: 'Baixar relatorio.pdf' }).click();
    const saved = join(saveDir, 'relatorio.pdf');
    await expect.poll(() => existsSync(saved), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => readFileSync(saved).length, { timeout: 10_000 }).toBe(pdf.length);
    expect(readFileSync(saved).equals(pdf)).toBe(true);
    expect(readdirSync(saveDir)).toEqual(['relatorio.pdf']); // no leftover part file
    // Still only the app's window: the PDF was not opened anywhere.
    expect(bia.app.windows()).toHaveLength(1);
  });

  step('grid: three images form a grid; a click opens the lightbox with "Baixar"', 90_000, async () => {
    await ana.page.locator('[data-attachment-input]').setInputFiles([
      { name: 'praia.png', mimeType: 'image/png', buffer: testPng(800, 600, [242, 63, 67], [251, 191, 36]) },
      { name: 'serra.png', mimeType: 'image/png', buffer: testPng(600, 800, [35, 165, 90], [118, 175, 246]) },
      { name: 'cidade.png', mimeType: 'image/png', buffer: testPng(900, 500, [148, 156, 247], [43, 45, 49]) },
      { name: 'contas.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: randomBytes(20_000) },
    ]);
    await composer(ana.page).fill(GRID_TEXT);
    await composer(ana.page).press('Enter');

    const grid = message(bia.page, GRID_TEXT);
    await grid.waitFor({ timeout: 60_000 });
    await expect.poll(() => pictures(grid).count(), { timeout: 30_000 }).toBe(3);
    for (let i = 0; i < 3; i++) await expect.poll(() => naturalWidth(pictures(grid).nth(i)), { timeout: 30_000 }).toBeGreaterThan(0);
    await grid.locator('[data-attachment="file"]').waitFor();
    await bia.page.waitForTimeout(300);
    await bia.page.screenshot({ path: join(tmpdir(), 'ghostlink-e2e-attachments-bia.png') });

    await pictures(grid).nth(1).click();
    const box = bia.page.getByRole('dialog', { name: 'Imagem: serra.png' });
    await box.waitFor({ timeout: 10_000 });
    await expect.poll(() => naturalWidth(box.locator('img')), { timeout: 15_000 }).toBe(600);
    await box.getByRole('button', { name: 'Baixar' }).waitFor();
    await bia.page.waitForTimeout(250);
    await bia.page.screenshot({ path: join(tmpdir(), 'ghostlink-e2e-attachments-lightbox.png') });
    await bia.page.keyboard.press('ArrowRight');
    await bia.page.getByRole('dialog', { name: 'Imagem: cidade.png' }).waitFor();
    await bia.page.keyboard.press('Escape');
    await box.waitFor({ state: 'detached' });
  });
});
