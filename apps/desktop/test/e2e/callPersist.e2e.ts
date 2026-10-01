// The call goes on while browsing, end to end (spec 2026-10-01-chamada-continua-design.md §3):
// Ana hosts server A in her app, Bia joins it by invite, and server B runs in this process
// (text only). Ana and Bia talk in A's voice channel. Ana goes to the Home screen: Bia keeps
// hearing her (the level the voice e2e measures), and the user panel says "Voz conectada —
// Sala de voz / Servidor A". Ana opens B and writes there: the call goes on. The panel's
// channel name takes her back to A at once, the call untouched. From B again she hangs up:
// the call ends, A's connection closes (Bia sees her leave and go offline), B stays.
// Run with `npm run test:e2e` (builds the app first). Skipped without the LiveKit binary.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { afterAll, describe, expect, it, type TestContext } from 'vitest';
import { freeLoopbackPort } from '../../../server/src/livekit/backend.js';
import { resolveLivekitBinary } from '../../../server/src/livekit/binary.js';
import { silentLogger, startServer, type GhostServer } from '../../../server/src/index.js';
import { createTextModule } from '../../../server/src/text/index.js';
import { E2eRun, joinWithInvite, onboard, receivedLevelDb, textChannel, tile, voiceChannel, voiceRow, type Instance } from './harness.js';

const binary = resolveLivekitBinary();
const SERVER_A = 'Servidor A';
const SERVER_B = 'Servidor B';

/** Screenshots for the owner (GHOSTLINK_E2E_SHOTS, else the temp dir). */
const shot = (name: string) => join(process.env.GHOSTLINK_E2E_SHOTS ?? tmpdir(), `ghostlink-e2e-call-${name}.png`);
const rail = (page: Page) => page.getByRole('navigation', { name: 'Servidores' });
const railServer = (page: Page, name: string) => rail(page).getByRole('button', { name, exact: true });
/** The open server's header (its name, then "Menu do servidor"). */
const header = (page: Page, name: string) => page.getByRole('button', { name: new RegExp(`^${name}\\s*Menu do servidor$`) });
const panel = (page: Page) => page.locator('[data-voice-panel]');
const members = (page: Page) => page.getByRole('complementary', { name: 'Membros' });
const composer = (page: Page, channel: string) => page.getByRole('combobox', { name: new RegExp(`^Conversar em #${channel}\\b`) });
const message = (page: Page, channel: string, text: string) =>
  page.getByRole('region', { name: `Mensagens em #${channel}` }).getByRole('article').filter({ hasText: text });

describe.skipIf(!binary)('the call goes on while browsing: Home, another server, back, hang up (chamada-continua §3)', () => {
  const run = new E2eRun();
  let serverB: GhostServer | null = null;
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
        await run.report(`call-${name.split(':')[0]!}`);
        throw e;
      }
    }, timeout);

  /** Bia hears Ana now (the decoded level of Ana's audio in Bia's app), and Ana is still in the call. */
  async function stillTalking(): Promise<void> {
    await expect.poll(() => receivedLevelDb(bia.page, anaId), { timeout: 20_000 }).toBeGreaterThan(-40);
    await expect.poll(() => receivedLevelDb(ana.page, biaId), { timeout: 20_000 }).toBeGreaterThan(-40);
    expect(await panel(ana.page).getAttribute('data-voice-panel')).toBe('connected');
    expect(await voiceRow(bia.page, sala, 'Ana').count()).toBe(1);
  }

  afterAll(() => run.close(), 180_000);

  step('setup: Ana hosts A and is also a member of B; Bia joins A; both talk in A\'s voice channel', 300_000, async () => {
    const portB = await freeLoopbackPort();
    serverB = await startServer({
      dataDir: run.tempDir('server-b'),
      port: portB,
      host: '127.0.0.1',
      name: SERVER_B,
      publicAddresses: [`127.0.0.1:${portB}`],
      joinMode: 'invite',
      logger: silentLogger,
      modules: [createTextModule()],
    });
    const started = serverB;
    run.onClose(() => started.close());

    ana = await run.launch('ana', { GHOSTLINK_HOST_BIND: '127.0.0.1' });
    bia = await run.launch('bia');
    const port = await freeLoopbackPort();
    await onboard(ana.page, 'Ana', 'Hospedar um servidor');
    await ana.page.getByRole('dialog', { name: 'Criar um servidor' }).getByRole('button', { name: /^Neste computador/ }).click();
    const form = ana.page.getByRole('dialog', { name: 'Hospedar um servidor' });
    await form.getByLabel('Nome do servidor').fill(SERVER_A);
    await form.getByLabel('Porta', { exact: true }).fill(String(port));
    await form.getByRole('button', { name: 'Hospedar' }).click();
    await header(ana.page, SERVER_A).waitFor({ timeout: 90_000 });
    const status = (await ana.page.evaluate('window.ghostlink.host.status()')) as { state: string; busyMediaPorts: string[] };
    expect(status.state).toBe('running');
    expect(status.busyMediaPorts).toEqual([]);

    await ana.page.getByRole('button', { name: /Menu do servidor/ }).click();
    await ana.page.getByRole('menuitem', { name: 'Convidar pessoas' }).click();
    const invite = ana.page.getByRole('dialog', { name: `Convidar pessoas para ${SERVER_A}` });
    await invite.getByRole('button', { name: 'Gerar convite' }).click();
    const link = ((await invite.locator('code').first().textContent()) ?? '').trim();
    await invite.getByRole('button', { name: 'Fechar', exact: true }).click();

    // Ana becomes a member of B (the rail's "+"), then goes back to A: no call yet, so B closes.
    await rail(ana.page).getByRole('button', { name: 'Adicionar servidor' }).click();
    await ana.page.getByRole('dialog', { name: 'Adicionar servidor' }).getByRole('button', { name: /^Entrar em um servidor/ }).click();
    await joinWithInvite(ana.page, serverB.createInvite().pasteCode);
    await header(ana.page, SERVER_B).waitFor({ timeout: 30_000 });
    await railServer(ana.page, SERVER_A).click();
    await header(ana.page, SERVER_A).waitFor({ timeout: 30_000 });

    await onboard(bia.page, 'Bia', 'Entrar num servidor');
    await joinWithInvite(bia.page, link);
    await textChannel(bia.page, 'geral').waitFor({ timeout: 30_000 });
    sala = (await voiceChannel(ana.page, 'Sala de voz').getAttribute('data-voice-channel'))!;

    await voiceChannel(ana.page, 'Sala de voz').click();
    await ana.page.locator('[data-voice-panel="connected"]').waitFor({ timeout: 30_000 });
    await voiceChannel(bia.page, 'Sala de voz').click();
    await bia.page.locator('[data-voice-panel="connected"]').waitFor({ timeout: 30_000 });
    await expect.poll(() => tile(bia.page, 'Ana').getAttribute('data-receiving'), { timeout: 30_000 }).toBe('true');
    await expect.poll(() => tile(ana.page, 'Bia').getAttribute('data-receiving'), { timeout: 30_000 }).toBe('true');
    anaId = (await tile(bia.page, 'Ana').getAttribute('data-user'))!;
    biaId = (await tile(ana.page, 'Bia').getAttribute('data-user'))!;
    await stillTalking();
  });

  step('Home: the call goes on, and the panel says where it is', 90_000, async () => {
    await ana.page.getByRole('button', { name: 'Início: seus servidores' }).click();
    await ana.page.getByRole('navigation', { name: 'Início' }).waitFor();
    const back = panel(ana.page).locator('[data-call-return]');
    await back.waitFor({ timeout: 10_000 });
    expect(await back.textContent()).toBe(`Sala de voz / ${SERVER_A}`);
    expect(await panel(ana.page).getByText('Voz conectada').count()).toBe(1);
    // Microphone, headphones and hang-up are there.
    expect(await ana.page.locator('[data-voice-control="mute"]').count()).toBe(1);
    expect(await ana.page.locator('[data-voice-control="deafen"]').count()).toBe(1);
    expect(await panel(ana.page).getByRole('button', { name: 'Desconectar', exact: true }).count()).toBe(1);
    // The rail marks the call's server.
    expect(await rail(ana.page).locator('[data-call]').count()).toBe(1);
    await stillTalking();
    await ana.page.waitForTimeout(400); // past the panel's fade-in
    await ana.page.screenshot({ path: shot('home') });
  });

  step('another server: B opens on a second connection, Ana writes there, the call goes on', 90_000, async () => {
    await railServer(ana.page, SERVER_B).click();
    await header(ana.page, SERVER_B).waitFor({ timeout: 30_000 });
    await composer(ana.page, 'geral').fill('Oi do servidor B, ainda na chamada do A');
    await composer(ana.page, 'geral').press('Enter');
    await message(ana.page, 'geral', 'Oi do servidor B, ainda na chamada do A').waitFor({ timeout: 15_000 });
    expect(await panel(ana.page).locator('[data-call-return]').textContent()).toBe(`Sala de voz / ${SERVER_A}`);
    // B's voice channel is B's own: nobody in it, and Ana's call is not shown there.
    expect(await ana.page.locator('[data-voice-here]').count()).toBe(0);
    await stillTalking();
    await ana.page.screenshot({ path: shot('other-server') });
  });

  step('back to A from the panel: at once, on the same connection, the call untouched', 60_000, async () => {
    await panel(ana.page).locator('[data-call-return]').click();
    // No reconnect: A's screen is back right away, with the call's channel as it is now.
    await header(ana.page, SERVER_A).waitFor({ timeout: 5_000 });
    await voiceRow(ana.page, sala, 'Bia').waitFor({ timeout: 5_000 });
    await voiceRow(ana.page, sala, 'Ana').waitFor({ timeout: 5_000 });
    expect(await panel(ana.page).locator('[data-call-return]').count()).toBe(0);
    await stillTalking();
  });

  step('hang up from B: the call ends and A\'s connection closes; B stays', 90_000, async () => {
    await railServer(ana.page, SERVER_B).click();
    await header(ana.page, SERVER_B).waitFor({ timeout: 30_000 });
    await stillTalking();
    await panel(ana.page).getByRole('button', { name: 'Desconectar', exact: true }).click();
    await panel(ana.page).waitFor({ state: 'detached', timeout: 10_000 });
    // Bia sees Ana leave the channel, then go offline: her app is no longer connected to A.
    await voiceRow(bia.page, sala, 'Ana').waitFor({ state: 'detached', timeout: 15_000 });
    await members(bia.page).getByRole('button', { name: /^Ana, Offline/ }).waitFor({ timeout: 30_000 });
    expect(await rail(ana.page).locator('[data-call]').count()).toBe(0);
    // B is still open and working.
    await composer(ana.page, 'geral').fill('Desliguei, continuo no B');
    await composer(ana.page, 'geral').press('Enter');
    await message(ana.page, 'geral', 'Desliguei, continuo no B').waitFor({ timeout: 15_000 });
    expect(await ana.page.getByRole('alertdialog').count()).toBe(0);
  });
});
