// Leaving and deleting a server end to end (spec 2026-10-01-sair-e-excluir-servidor-design.md §5):
// a server in this process with the text and serverDelete modules and a test clock; two built
// apps join it by invite, Ana with the owner code. Ana deletes it from the red modal (the exact
// name unlocks it); Bia is disconnected with the date and cannot get back in; Ana restores it from
// her red band; Bia gets in again. Then the deadline passes on the test clock: Bia reads that the
// owner deleted it, and the server leaves her list. No LiveKit: nothing here needs voice.
// Run with `npm run test:e2e` (builds the app first).
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import { SERVER_DELETE_LIMITS } from '@ghostlink/shared';
import { createServerDeleteModule } from '../../../server/src/deletion/index.js';
import { silentLogger, startServer, type GhostServer } from '../../../server/src/index.js';
import { freeLoopbackPort } from '../../../server/src/livekit/backend.js';
import { createTextModule } from '../../../server/src/text/index.js';
import { E2eRun, onboard, textChannel, type Instance } from './harness.js';

const SERVER = 'Tropa do ADS';
/** Screenshots for the owner (GHOSTLINK_E2E_SHOTS, else the temp dir). */
const shot = (name: string) => join(process.env.GHOSTLINK_E2E_SHOTS ?? tmpdir(), `ghostlink-e2e-delete-${name}.png`);
const serverMenu = (page: Page) => page.getByRole('button', { name: /Menu do servidor/ });
/** The server in the rail: on the Home screen (the Friends page since v0.3) servers live in the rail only. */
const homeServer = (page: Page) => page.getByRole('navigation', { name: 'Servidores' }).getByRole('button', { name: SERVER, exact: true });

/** The Join screen with an invite; `setupCode` makes this person the owner. */
async function joinByInvite(page: Page, invite: string, setupCode?: string): Promise<void> {
  await page.getByRole('textbox').fill(invite);
  await page.getByRole('button', { name: 'Continuar' }).click();
  if (setupCode) {
    await page.getByRole('button', { name: 'Sou o dono deste servidor' }).click();
    await page.getByLabel('Código de dono').fill(setupCode);
  }
  await page.getByRole('button', { name: 'Aceitar convite' }).click();
  await page.getByRole('button', { name: 'Conectar' }).click();
  await textChannel(page, 'geral').waitFor({ timeout: 30_000 });
}

/** Ana's "Excluir servidor" from the server menu: the red modal, unlocked by the exact name only. */
async function deleteFromMenu(page: Page, screenshot?: string): Promise<void> {
  await serverMenu(page).click();
  await page.getByRole('menuitem', { name: 'Excluir servidor' }).click();
  const modal = page.getByRole('dialog', { name: `Excluir ${SERVER}?` });
  const confirm = modal.getByRole('button', { name: 'Excluir servidor' });
  await modal.getByText('O servidor sai do ar agora para todos. Ele é apagado de vez em 48 h').waitFor();
  expect(await confirm.isDisabled()).toBe(true);
  await modal.getByLabel('Digite o nome do servidor para confirmar').fill('tropa do ads');
  expect(await confirm.isDisabled()).toBe(true);
  await modal.getByLabel('Digite o nome do servidor para confirmar').fill(SERVER);
  expect(await confirm.isEnabled()).toBe(true);
  if (screenshot) {
    await page.waitForTimeout(400); // past the dialog's fade-in
    await page.screenshot({ path: shot(screenshot) });
  }
  await confirm.click();
  await modal.waitFor({ state: 'detached', timeout: 15_000 });
}

describe('leave and delete a server: Ana deletes, Bia is out, Ana restores, Bia is back (spec §5)', () => {
  const run = new E2eRun();
  /** The server's clock runs `offset` ms ahead of the real one: the deadline passes on demand. */
  const clock = { offset: 0 };
  let server!: GhostServer;
  let ana!: Instance;
  let bia!: Instance;
  let broken = false;

  const step = (name: string, timeout: number, fn: () => Promise<void>) =>
    it(name, async (ctx: TestContext) => {
      if (broken) ctx.skip();
      try {
        await fn();
      } catch (e) {
        broken = true;
        await run.report(name.split(':')[0]!);
        throw e;
      }
    }, timeout);

  beforeAll(async () => {
    server = await startServer({
      dataDir: run.tempDir('server'),
      port: await freeLoopbackPort(),
      host: '127.0.0.1',
      name: SERVER,
      joinMode: 'invite',
      logger: silentLogger,
      now: () => Date.now() + clock.offset,
      modules: [createTextModule(), createServerDeleteModule({ checkIntervalMs: 500 })],
    });
    const started = server;
    run.onClose(() => started.close());
  });

  afterAll(() => run.close(), 180_000);

  step('setup: Ana joins as the owner and Bia as a member, by invite', 120_000, async () => {
    ana = await run.launch('ana');
    bia = await run.launch('bia');
    await onboard(ana.page, 'Ana', 'Entrar num servidor');
    await joinByInvite(ana.page, server.createInvite().pasteCode, server.setupCode()!);
    await onboard(bia.page, 'Bia', 'Entrar num servidor');
    await joinByInvite(bia.page, server.createInvite().pasteCode);
  });

  step('menus: the owner sees "Excluir servidor", a member "Sair do servidor", nobody "Remover da lista"', 60_000, async () => {
    await serverMenu(ana.page).click();
    await ana.page.getByRole('menuitem', { name: 'Excluir servidor' }).waitFor();
    expect(await ana.page.getByRole('menuitem', { name: 'Sair do servidor' }).count()).toBe(0);
    await ana.page.keyboard.press('Escape');
    // The rail's right-click on the open server offers the same.
    await ana.page.getByRole('navigation', { name: 'Servidores' }).getByRole('button', { name: SERVER, exact: true }).click({ button: 'right' });
    await ana.page.getByRole('menuitem', { name: 'Excluir servidor' }).waitFor();
    await ana.page.screenshot({ path: shot('rail-menu-owner') });
    await ana.page.keyboard.press('Escape');

    await serverMenu(bia.page).click();
    await bia.page.getByRole('menuitem', { name: 'Sair do servidor' }).waitFor();
    expect(await bia.page.getByRole('menuitem', { name: 'Excluir servidor' }).count()).toBe(0);
    await bia.page.screenshot({ path: shot('header-menu-member') });
    await bia.page.keyboard.press('Escape');
    for (const page of [ana.page, bia.page]) expect(await page.getByText(/Remover da lista/).count()).toBe(0);
  });

  step('delete: Ana deletes from the red modal; Bia is disconnected with the date, Ana sees the red band', 60_000, async () => {
    await deleteFromMenu(ana.page, 'modal');

    const lost = bia.page.getByRole('alertdialog', { name: 'Servidor desligado' });
    await lost.waitFor({ timeout: 15_000 });
    await lost.getByText(new RegExp(`^${SERVER} foi desligado pelo dono e será excluído em \\d{2}/\\d{2}/\\d{4}`)).waitFor();
    expect(await lost.getByRole('button', { name: 'Conectar de novo' }).count()).toBe(0);
    await bia.page.screenshot({ path: shot('member-disconnected') });

    const band = ana.page.getByTestId('server-deleting-banner');
    await band.getByText(`${SERVER} está fora do ar e será excluído em 47 h.`).waitFor({ timeout: 15_000 });
    await band.getByRole('button', { name: 'Restaurar servidor' }).waitFor();
    await ana.page.screenshot({ path: shot('owner-band') });
  });

  step('refused: back home, Bia cannot get in, and reads why', 60_000, async () => {
    await bia.page.getByRole('alertdialog', { name: 'Servidor desligado' }).getByRole('button', { name: 'Voltar aos servidores' }).click();
    await homeServer(bia.page).click();
    await bia.page.getByRole('alert').filter({ hasText: `${SERVER} foi desligado pelo dono e será excluído em` }).waitFor({ timeout: 20_000 });
    expect(await textChannel(bia.page, 'geral').count()).toBe(0);
    await bia.page.screenshot({ path: shot('member-refused') });
  });

  step('restore: Ana restores from the band, and Bia gets back in', 60_000, async () => {
    await ana.page.getByTestId('server-deleting-banner').getByRole('button', { name: 'Restaurar servidor' }).click();
    await ana.page.getByTestId('server-deleting-banner').waitFor({ state: 'detached', timeout: 15_000 });
    await homeServer(bia.page).click();
    await textChannel(bia.page, 'geral').waitFor({ timeout: 30_000 });
  });

  step('leave from Home: Bia\'s right-click "Sair do servidor" in the rail connects first and offers the leave dialog', 60_000, async () => {
    await bia.page.getByRole('button', { name: 'Início: seus servidores' }).click();
    await bia.page.getByRole('navigation', { name: 'Início' }).waitFor();
    await homeServer(bia.page).click({ button: 'right' });
    await bia.page.getByRole('menuitem', { name: 'Sair do servidor' }).click();
    const leave = bia.page.getByRole('dialog', { name: `Sair de ${SERVER}?` });
    await leave.getByText('Apagar também todas as minhas mensagens').waitFor({ timeout: 20_000 });
    await bia.page.waitForTimeout(400); // past the dialog's fade-in
    await bia.page.screenshot({ path: shot('member-leave-dialog') });
    await leave.getByRole('button', { name: 'Cancelar' }).click();
    await leave.waitFor({ state: 'detached' });
  });

  step('deadline: after 48 h on the test clock, Bia reads that the owner deleted it, and it leaves her list', 90_000, async () => {
    await deleteFromMenu(ana.page);
    clock.offset = SERVER_DELETE_LIMITS.graceMs + 60_000;
    // The owner's own session ends too once the server erased itself.
    await ana.page.getByRole('alertdialog', { name: 'Servidor excluído' }).getByText(`${SERVER} foi excluído.`).waitFor({ timeout: 20_000 });

    await homeServer(bia.page).click();
    await bia.page.getByRole('alert').filter({ hasText: `${SERVER} foi excluído pelo dono.` }).waitFor({ timeout: 20_000 });
    await homeServer(bia.page).waitFor({ state: 'detached', timeout: 15_000 });
    await bia.page.screenshot({ path: shot('member-deleted') });
  });
});
