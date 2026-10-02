// Bots end to end (spec 2026-10-02-bots-design.md §3, §5): Ana hosts a server and adds a bot in the
// sidebar's BOTS section (name and photo); the test starts @ghostlink/discord-compat's example
// bot (examples/ping-bot, a discord.js-style bot) with the one-time connection code; Ana types "/",
// picks /ping and sees "Pong!" under "Ana usou /ping"; with the `private` chip set to Sim the
// answer is only hers ("Só você pode ver isto · Dispensar"); with `slow` it comes after thinking.
// Then "Gerar novo código" disconnects the bot and "Excluir bot" removes it. Run with
// `npm run test:e2e` (builds the app first; the package is built here when its dist/ is missing).
// Skipped without the LiveKit binary.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import type { Page } from 'playwright-core';
import { afterAll, describe, expect, it, type TestContext } from 'vitest';
import { freeLoopbackPort } from '../../../server/src/livekit/backend.js';
import { resolveLivekitBinary } from '../../../server/src/livekit/binary.js';
import { E2eRun, onboard, textChannel, type Instance } from './harness.js';

const binary = resolveLivekitBinary();
const SERVER = 'Servidor dos Bots';
const compat = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../packages/discord-compat');
const shot = (name: string) => join(tmpdir(), `ghostlink-e2e-bots-${name}.png`);

const composer = (page: Page) => page.getByRole('combobox', { name: /^Conversar em #geral\b/ });
const messages = (page: Page) => page.getByRole('region', { name: 'Mensagens em #geral' });
const sidebar = (page: Page) => page.getByRole('complementary', { name: 'Canais' });
const botRow = (page: Page, name: string) => page.locator('[data-bots-section] [data-bot]', { hasText: name });
const draft = (page: Page) => page.locator('[data-slash-draft]');

/** A small RGB PNG (a blurple-to-green gradient) for the bot's photo. */
function testPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k = (x + y) / (width + height);
      raw.set([Math.round(88 + (35 - 88) * k), Math.round(101 + (165 - 101) * k), Math.round(242 + (90 - 242) * k)], y * row + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Starts the package's example bot with the code, as its README says (GHOSTLINK_BOT=… node index.mjs). */
function startExampleBot(code: string, log: string[]): ChildProcess {
  if (!existsSync(join(compat, 'dist', 'esm', 'index.js'))) execFileSync(process.execPath, [join(compat, 'scripts', 'build.mjs')], { cwd: compat, stdio: 'ignore' });
  const child = spawn(process.execPath, [join(compat, 'examples', 'ping-bot', 'index.mjs')], {
    cwd: join(compat, 'examples', 'ping-bot'),
    env: { ...process.env, GHOSTLINK_BOT: code },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout!.on('data', (d: Buffer) => log.push(`[bot] ${d.toString().trim()}`));
  child.stderr!.on('data', (d: Buffer) => log.push(`[bot:err] ${d.toString().trim()}`));
  return child;
}

/** Adds an optional yes/no option to the command and sets it to Sim (opened with the arrows, as by keyboard). */
async function setYes(page: Page, option: string): Promise<void> {
  await draft(page).getByRole('button', { name: `Adicionar a opção ${option}` }).click();
  const field = draft(page).getByRole('combobox', { name: new RegExp(`^${option}: `) });
  await expect.poll(() => field.evaluate((el: { ownerDocument: { activeElement: unknown } }) => el === el.ownerDocument.activeElement)).toBe(true);
  await page.keyboard.press('ArrowDown');
  await page.getByRole('option', { name: 'Sim' }).click();
  await expect.poll(() => field.textContent()).toBe('Sim');
}

describe.skipIf(!binary)('GhostLink bots: Ana adds a bot, the example bot connects with the code, /ping answers under "Ana usou /ping"', () => {
  const run = new E2eRun();
  let ana!: Instance;
  let code = '';
  let bot: ChildProcess | null = null;
  const botLog: string[] = [];
  let broken = false;

  /** One scenario step: later steps are skipped once one failed, and a failure dumps logs and screenshots. */
  const step = (name: string, timeout: number, fn: () => Promise<void>) =>
    it(name, async (ctx: TestContext) => {
      if (broken) ctx.skip();
      try {
        await fn();
      } catch (e) {
        broken = true;
        console.log(botLog.slice(-40).join('\n'));
        await run.report(`bots ${name.split(':')[0]!}`);
        throw e;
      }
    }, timeout);

  afterAll(async () => {
    bot?.kill();
    await run.close();
  }, 180_000);

  step('setup: Ana hosts a server; the BOTS section offers "Adicionar bot" above the text channels', 180_000, async () => {
    ana = await run.launch('ana', { GHOSTLINK_HOST_BIND: '127.0.0.1' });
    const port = await freeLoopbackPort();
    await onboard(ana.page, 'Ana', 'Hospedar um servidor');
    await ana.page.getByRole('dialog', { name: 'Criar um servidor' }).getByRole('button', { name: /^Neste computador/ }).click();
    const form = ana.page.getByRole('dialog', { name: 'Hospedar um servidor' });
    await form.getByLabel('Nome do servidor').fill(SERVER);
    await form.getByLabel('Porta', { exact: true }).fill(String(port));
    await form.getByRole('button', { name: 'Hospedar' }).click();
    await textChannel(ana.page, 'geral').waitFor({ timeout: 90_000 });

    await ana.page.locator('[data-bots-section]').getByRole('heading', { name: 'Bots' }).waitFor({ timeout: 15_000 });
    // Above "CANAIS DE TEXTO".
    const order = await sidebar(ana.page).evaluate((el: { querySelectorAll(s: string): ArrayLike<{ textContent: string | null }> }) =>
      Array.from(el.querySelectorAll('h2')).map((h) => h.textContent),
    );
    expect(order.indexOf('Bots')).toBeLessThan(order.indexOf('Canais de texto'));
  });

  step('create: name and photo, then the one-time connection code with Copiar and the warning', 60_000, async () => {
    await ana.page.locator('[data-bots-section]').getByRole('button', { name: 'Adicionar bot' }).first().click();
    const dialog = ana.page.getByRole('dialog', { name: 'Adicionar bot' });
    await dialog.getByLabel('Nome do bot').fill('Hermes');
    await dialog.locator('[data-bot-photo-input]').setInputFiles({ name: 'hermes.png', mimeType: 'image/png', buffer: testPng(300, 300) });
    const crop = ana.page.getByRole('dialog', { name: 'Editar imagem' });
    await crop.getByRole('button', { name: 'Aplicar' }).click();
    await crop.waitFor({ state: 'detached' });
    await dialog.locator('[data-avatar="image"] img').waitFor();
    await dialog.getByRole('button', { name: 'Criar bot' }).click();

    const codeDialog = ana.page.getByRole('dialog', { name: 'Código de conexão de Hermes' });
    await codeDialog.waitFor({ timeout: 15_000 });
    code = ((await codeDialog.locator('code').textContent()) ?? '').trim();
    expect(code).toMatch(/^ghostlink-bot:\/\/127\.0\.0\.1:\d+\?pin=[\w-]{43}&token=[\w-]{43}$/);
    await codeDialog.getByText('Guarde agora: ele não aparece de novo.').waitFor();
    // Not clicked: it would put the code on this machine's real clipboard.
    await codeDialog.getByRole('button', { name: 'Copiar' }).waitFor();
    await ana.page.waitForTimeout(200);
    await ana.page.screenshot({ path: shot('code') });
    await codeDialog.getByRole('button', { name: 'Pronto' }).click();
    await codeDialog.waitFor({ state: 'detached' });

    // The bot is listed, offline, with its photo (uploaded through the avatar path with botId).
    await botRow(ana.page, 'Hermes').locator('[data-avatar="image"]').waitFor({ timeout: 15_000 });
  });

  step('connect: the example bot logs in with the code; it shows online, with the BOT tag in the members', 90_000, async () => {
    bot = startExampleBot(code, botLog);
    await expect.poll(() => botLog.some((l) => l.includes('Ready! Logged in as Hermes')), { timeout: 30_000 }).toBe(true);
    await botRow(ana.page, 'Hermes').locator('[class*="dotOn"]').waitFor({ timeout: 15_000 });
    await ana.page.getByRole('button', { name: /^Hermes, BOT, Online/ }).locator('[data-bot-tag]').waitFor({ timeout: 10_000 });
    await ana.page.waitForTimeout(200);
    // The rail and the sidebar's top (the user panel floats over the sidebar's bottom).
    const box = (await sidebar(ana.page).boundingBox())!;
    await ana.page.screenshot({ path: shot('section'), clip: { x: 0, y: 0, width: box.x + box.width, height: box.y + 300 } });
  });

  step('slash: "/" lists the bot\'s commands; /ping goes and "Pong!" shows under "Ana usou /ping"', 60_000, async () => {
    await composer(ana.page).click();
    await ana.page.keyboard.type('/');
    const picker = ana.page.locator('[data-slash-picker]');
    // The bot registers /ping right after it is ready.
    await picker.getByRole('option', { name: '/ping, Replies with Pong!, de Hermes' }).waitFor({ timeout: 15_000 });
    await ana.page.waitForTimeout(150);
    await ana.page.screenshot({ path: shot('picker') });

    await ana.page.keyboard.type('pi');
    await ana.page.keyboard.press('Enter');
    await draft(ana.page).getByRole('button', { name: 'Comando /ping de Hermes' }).waitFor();
    await ana.page.keyboard.press('Enter');
    await draft(ana.page).waitFor({ state: 'detached', timeout: 10_000 });

    const answer = messages(ana.page).getByRole('article').filter({ hasText: 'Pong!' });
    await answer.waitFor({ timeout: 15_000 });
    await answer.locator('[data-interaction-used]').getByText('Ana usou /ping').waitFor();
    await answer.locator('[data-bot-tag]').waitFor();
    await ana.page.waitForTimeout(200);
    await ana.page.screenshot({ path: shot('reply') });
  });

  step('private: the yes/no chip set to Sim makes the answer only Ana\'s; "Dispensar" removes it', 60_000, async () => {
    await composer(ana.page).click();
    await ana.page.keyboard.type('/ping');
    await ana.page.keyboard.press('Enter');
    await setYes(ana.page, 'private');
    await ana.page.waitForTimeout(150);
    await ana.page.screenshot({ path: shot('chips') });
    await ana.page.keyboard.press('Enter');

    const mine = messages(ana.page).locator('[data-bot-local="ephemeral"]');
    await mine.getByText('Pong!').waitFor({ timeout: 15_000 });
    await mine.getByText('Ana usou /ping').waitFor();
    await mine.getByText('Só você pode ver isto').waitFor();
    await ana.page.waitForTimeout(150);
    await ana.page.screenshot({ path: shot('ephemeral') });
    await mine.getByRole('button', { name: 'Dispensar' }).click();
    await mine.waitFor({ state: 'detached' });
  });

  step('slow: a deferred answer arrives after thinking, under "Ana usou /ping"', 60_000, async () => {
    await composer(ana.page).click();
    await ana.page.keyboard.type('/ping');
    await ana.page.keyboard.press('Enter');
    await setYes(ana.page, 'slow');
    await ana.page.getByRole('button', { name: 'Enviar' }).click();
    const answer = messages(ana.page).getByRole('article').filter({ hasText: 'Pong! (after thinking)' });
    await answer.getByText('Ana usou /ping').waitFor({ timeout: 15_000 });
    await messages(ana.page).locator('[data-bot-local="thinking"]').waitFor({ state: 'detached' });
  });

  step('menu: "Gerar novo código" disconnects the bot; "Excluir bot" removes it, its answers stay', 60_000, async () => {
    const more = ana.page.getByRole('button', { name: 'Opções de Hermes' });
    await more.click();
    await ana.page.getByRole('menuitem', { name: 'Gerar novo código' }).click();
    await ana.page.getByRole('dialog', { name: 'Gerar novo código para Hermes?' }).getByRole('button', { name: 'Gerar novo código' }).click();
    const codeDialog = ana.page.getByRole('dialog', { name: 'Código de conexão de Hermes' });
    const fresh = ((await codeDialog.locator('code').textContent()) ?? '').trim();
    expect(fresh).toMatch(/^ghostlink-bot:\/\//);
    expect(fresh).not.toBe(code);
    await codeDialog.getByRole('button', { name: 'Pronto' }).click();
    await botRow(ana.page, 'Hermes').locator('[class*="dotOn"]').waitFor({ state: 'detached', timeout: 15_000 });

    await more.click();
    await ana.page.getByRole('menuitem', { name: 'Excluir bot' }).click();
    await ana.page.getByRole('dialog', { name: 'Excluir Hermes?' }).getByRole('button', { name: 'Excluir bot' }).click();
    await botRow(ana.page, 'Hermes').waitFor({ state: 'detached', timeout: 15_000 });
    const answer = messages(ana.page).getByRole('article').filter({ hasText: 'Pong!' }).first();
    await answer.getByText('bot excluído').waitFor({ timeout: 10_000 });
    // Ana can still add one.
    await ana.page.locator('[data-bots-section]').getByRole('button', { name: 'Adicionar bot' }).first().waitFor();
  });
});
