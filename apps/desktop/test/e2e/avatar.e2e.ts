// Profile photo end to end (plan 2026-10-01-foto-de-perfil, "e2e avatar.e2e.ts"): two built
// app instances on the v0.1 harness. Ana hosts, Bia joins with her invite. Ana picks a PNG
// in User Settings → Perfil and crops it; Bia sees it, 256×256, in the member list and on
// Ana's message (main's app:// route downloads it with the server's signed URL). Ana removes
// it and Bia sees her initials again. On the Home screen the Perfil tab has the photo too.
// Run with `npm run test:e2e` (builds the app first). Skipped without the LiveKit binary.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import type { Locator, Page } from 'playwright-core';
import { afterAll, describe, expect, it, type TestContext } from 'vitest';
import { freeLoopbackPort } from '../../../server/src/livekit/backend.js';
import { resolveLivekitBinary } from '../../../server/src/livekit/binary.js';
import { E2eRun, joinWithInvite, onboard, textChannel, type Instance } from './harness.js';

const binary = resolveLivekitBinary();
const SERVER = 'Servidor das Fotos';
const HELLO = 'Oi Bia, olha a minha foto nova!';

const members = (page: Page) => page.getByRole('complementary', { name: 'Membros' });
const memberRow = (page: Page, name: string) => members(page).getByRole('button', { name: new RegExp(`^${name},`) });
const composer = (page: Page, channel: string) => page.getByRole('combobox', { name: new RegExp(`^Conversar em #${channel}\\b`) });
const message = (page: Page, channel: string, text: string) =>
  page.getByRole('region', { name: `Mensagens em #${channel}` }).getByRole('article').filter({ hasText: text });
const photo = (scope: Locator) => scope.locator('img[src*="_avatar/"]');
const settings = (page: Page) => page.getByRole('dialog', { name: 'Configurações do usuário' });

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

/** A width×height RGB PNG: a blurple-to-green gradient with a light disc in the middle, so the crop shows. */
function testPng(width: number, height: number): Buffer {
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    raw[y * row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const disc = (x - width / 2) ** 2 + (y - height / 2) ** 2 < (height / 4) ** 2;
      const i = y * row + 1 + x * 3;
      raw[i] = disc ? 240 : Math.round(88 + (x / width) * 60);
      raw[i + 1] = disc ? 240 : Math.round(101 + (y / height) * 120);
      raw[i + 2] = disc ? 250 : 242;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, deflate, no filter, no interlace
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

/** User Settings → Perfil (the tab it opens on) → pick the PNG → "Editar imagem" → Aplicar. */
async function setPhoto(page: Page, shot: string): Promise<void> {
  await page.getByRole('button', { name: 'Configurações do usuário' }).click();
  await settings(page).getByRole('tab', { name: 'Perfil', selected: true }).waitFor();
  await settings(page).locator('[data-profile-photo] input[type="file"]').setInputFiles({ name: 'foto.png', mimeType: 'image/png', buffer: testPng(300, 200) });
  const crop = page.getByRole('dialog', { name: 'Editar imagem' });
  await crop.waitFor();
  // Zoom in a little and move: the crop is whatever stays under the circle.
  await crop.getByRole('slider', { name: 'Aproximar' }).press('PageUp');
  await crop.getByRole('group', { name: /^Arraste a imagem/ }).press('ArrowRight');
  // Past the modal's 140 ms fade-in, so the picture shows the crop and not a blend with the page behind.
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(tmpdir(), shot) });
  await crop.getByRole('button', { name: 'Aplicar' }).click();
  await crop.waitFor({ state: 'detached', timeout: 20_000 });
}

describe.skipIf(!binary)('GhostLink profile photo: one person sets it, the other sees it', () => {
  const run = new E2eRun();
  let ana!: Instance;
  let bia!: Instance;
  let broken = false;

  /** One scenario step: later steps are skipped once one failed, and a failure dumps logs and screenshots. */
  const step = (name: string, timeout: number, fn: () => Promise<void>) =>
    it(name, async (ctx: TestContext) => {
      if (broken) ctx.skip();
      try {
        await fn();
      } catch (e) {
        broken = true;
        await run.report(`avatar ${name.split(':')[0]!}`);
        throw e;
      }
    }, timeout);

  afterAll(() => run.close(), 180_000);

  step('setup: Ana hosts a server, Bia joins it with an invite', 180_000, async () => {
    // Loopback bind (dev-only hook): no firewall prompt, and no UPnP mapping on the router.
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
    expect(link).toMatch(/\/j\/#GL1-/);
    await invite.getByRole('button', { name: 'Fechar', exact: true }).click();

    await onboard(bia.page, 'Bia', 'Entrar num servidor');
    await joinWithInvite(bia.page, link);
    await textChannel(bia.page, 'geral').waitFor({ timeout: 30_000 });
    await memberRow(bia.page, 'Ana').waitFor({ timeout: 15_000 });

    // Before any photo: initials on the blurple circle, no image.
    await composer(ana.page, 'geral').fill(HELLO);
    await composer(ana.page, 'geral').press('Enter');
    await message(bia.page, 'geral', HELLO).waitFor({ timeout: 15_000 });
    expect(await memberRow(bia.page, 'Ana').locator('[data-avatar="initials"]').textContent()).toBe('A');
    expect(await photo(memberRow(bia.page, 'Ana')).count()).toBe(0);
  });

  step('set: Ana picks a 300×200 PNG in Perfil and applies the crop; her own avatar changes at once', 90_000, async () => {
    await setPhoto(ana.page, 'ghostlink-e2e-avatar-crop.png');
    // Mine shows from the profile store, right away: the 80 px preview and the user panel.
    await photo(settings(ana.page).locator('[data-profile-photo]')).waitFor({ timeout: 10_000 });
    await expect.poll(() => naturalWidth(photo(settings(ana.page).locator('[data-profile-photo]'))), { timeout: 10_000 }).toBe(256);
    await ana.page.screenshot({ path: join(tmpdir(), 'ghostlink-e2e-avatar-settings.png') });
    await settings(ana.page).getByRole('button', { name: 'Fechar', exact: true }).click();
    await photo(ana.page.getByRole('region', { name: 'Sua conta' })).waitFor({ timeout: 10_000 });
  });

  step("see: Bia sees Ana's photo, 256×256, in the member list and on her message", 60_000, async () => {
    const inList = photo(memberRow(bia.page, 'Ana'));
    await inList.waitFor({ timeout: 30_000 });
    await expect.poll(() => naturalWidth(inList), { timeout: 30_000 }).toBe(256);
    const onMessage = photo(message(bia.page, 'geral', HELLO));
    await onMessage.waitFor({ timeout: 10_000 });
    await expect.poll(() => naturalWidth(onMessage), { timeout: 30_000 }).toBe(256);
    expect(await inList.getAttribute('src')).toBe(await onMessage.getAttribute('src'));
    expect(await inList.getAttribute('src')).toMatch(/^app:\/\/ghostlink\/_avatar\/[0-9a-f]{64}$/);
    // Bia has no photo: still her initials, for both.
    expect(await memberRow(bia.page, 'Bia').locator('[data-avatar="initials"]').textContent()).toBe('B');
    expect(await memberRow(ana.page, 'Bia').locator('[data-avatar="initials"]').textContent()).toBe('B');
    await bia.page.screenshot({ path: join(tmpdir(), 'ghostlink-e2e-avatar-bia.png') });
  });

  step('remove: Ana removes the photo and Bia sees her initials again', 60_000, async () => {
    await ana.page.getByRole('button', { name: 'Configurações do usuário' }).click();
    await settings(ana.page).getByRole('button', { name: 'Remover foto' }).click();
    await settings(ana.page).getByRole('button', { name: 'Remover foto' }).waitFor({ state: 'detached', timeout: 10_000 });
    await settings(ana.page).getByRole('button', { name: 'Fechar', exact: true }).click();

    await photo(memberRow(bia.page, 'Ana')).waitFor({ state: 'detached', timeout: 30_000 });
    expect(await memberRow(bia.page, 'Ana').locator('[data-avatar="initials"]').textContent()).toBe('A');
    await photo(message(bia.page, 'geral', HELLO)).waitFor({ state: 'detached', timeout: 10_000 });
    expect(await message(bia.page, 'geral', HELLO).locator('[data-avatar="initials"]').textContent()).toBe('A');
  });

  step('home: on the Home screen the Perfil tab has the photo section, and a photo set there shows at once', 60_000, async () => {
    await bia.page.getByRole('button', { name: 'Início: seus servidores' }).click();
    await bia.page.getByRole('navigation', { name: 'Início' }).waitFor();
    await setPhoto(bia.page, 'ghostlink-e2e-avatar-home-crop.png');
    const section = settings(bia.page).locator('[data-profile-photo]');
    await section.getByRole('button', { name: 'Alterar foto' }).waitFor();
    await expect.poll(() => naturalWidth(photo(section)), { timeout: 10_000 }).toBe(256);
    // Only the photo here: the nickname belongs to a server.
    expect(await settings(bia.page).getByText('Apelido neste servidor').count()).toBe(0);
    await bia.page.screenshot({ path: join(tmpdir(), 'ghostlink-e2e-avatar-home.png') });
    await settings(bia.page).getByRole('button', { name: 'Fechar', exact: true }).click();
    await photo(bia.page.getByRole('region', { name: 'Sua conta' })).waitFor({ timeout: 10_000 });
  });
});
