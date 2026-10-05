// GhostLink v0.1 end to end (release plan, "Integration and release" step 3): two built
// app instances, each with its own profile. Ana hosts a server from the Host flow (the
// real server with defaultModules(): text + voice, LiveKit included) and is its owner;
// Bia joins with Ana's invite through the real screens. Then: chat both ways, voice with
// real audio each way (mute, deafen, speaking, server mute, move, push-to-talk, leave),
// a private channel Bia never sees, and a kick after which she cannot come back in.
// Run with `npm run test:e2e` (builds the app first). Skipped without the LiveKit binary.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { afterAll, describe, expect, it, type TestContext } from 'vitest';
import { freeLoopbackPort } from '../../../server/src/livekit/backend.js';
import { resolveLivekitBinary } from '../../../server/src/livekit/binary.js';
import {
  E2eRun,
  joinWithInvite,
  onboard,
  receivedLevelDb,
  requestOutcome,
  textChannel,
  tile,
  voiceChannel,
  voiceRow,
  type Instance,
} from './harness.js';

const binary = resolveLivekitBinary();
const SERVER = 'Servidor E2E';

const members = (page: Page) => page.getByRole('complementary', { name: 'Membros' });
const composer = (page: Page, channel: string) => page.getByRole('combobox', { name: new RegExp(`^Conversar em #${channel}\\b`) });
const message = (page: Page, channel: string, text: string) =>
  page.getByRole('region', { name: `Mensagens em #${channel}` }).getByRole('article').filter({ hasText: text });

async function say(page: Page, channel: string, text: string): Promise<void> {
  await composer(page, channel).fill(text);
  await composer(page, channel).press('Enter');
}

describe.skipIf(!binary)('GhostLink v0.1: host in one app, join from another by invite', () => {
  const run = new E2eRun();
  let ana!: Instance;
  let bia!: Instance;
  /** Channel ids, read from the sidebar once they exist. */
  let sala = '';
  let sala2 = '';
  /** The invite Bia accepted, reused in the rejoin step. */
  let inviteLink = '';
  let broken = false;

  /** One scenario step: later steps are skipped once one failed, and a failure dumps logs and screenshots. */
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

  afterAll(() => run.close(), 180_000);

  step('host: Ana hosts a server from the Host flow and is its owner', 150_000, async () => {
    // Loopback bind (dev-only hook): no firewall prompt, and no UPnP mapping on the router.
    ana = await run.launch('ana', { GHOSTLINK_HOST_BIND: '127.0.0.1' });
    bia = await run.launch('bia');
    const port = await freeLoopbackPort();

    await onboard(ana.page, 'Ana', 'Hospedar um servidor');
    // "Criar um servidor" asks where the server lives: this computer (Host mode) or Railway.
    await ana.page.getByRole('dialog', { name: 'Criar um servidor' }).getByRole('button', { name: /^Neste computador/ }).click();
    const form = ana.page.getByRole('dialog', { name: 'Hospedar um servidor' });
    await form.getByLabel('Nome do servidor').fill(SERVER);
    await form.getByLabel('Porta', { exact: true }).fill(String(port));
    await form.getByRole('button', { name: 'Hospedar' }).click();

    // The server runs in a utility process and the app joins it as the owner (setup code).
    await textChannel(ana.page, 'geral').waitFor({ timeout: 90_000 });
    await voiceChannel(ana.page, 'Sala de voz').waitFor();
    await members(ana.page).getByRole('button', { name: /^Ana, Online, Você, Dono/ }).waitFor();
    await ana.page.getByRole('button', { name: `Hospedando ${SERVER}` }).waitFor();
    const status = (await ana.page.evaluate('window.ghostlink.host.status()')) as { state: string; port: number; hasOwner: boolean; busyMediaPorts: string[] };
    expect(status).toMatchObject({ state: 'running', port, hasOwner: true });
    // LiveKit's fixed media ports (UDP 7882, TCP 7881) were free, so voice can work.
    expect(status.busyMediaPorts).toEqual([]);
  });

  step('join: Bia joins with the invite: onboarding → Home → "+" → "Entrar em um servidor" → accept → connect', 90_000, async () => {
    // Ana: server menu → "Convidar pessoas" → a fresh invite link.
    await ana.page.getByRole('button', { name: /Menu do servidor/ }).click();
    await ana.page.getByRole('menuitem', { name: 'Convidar pessoas' }).click();
    const invite = ana.page.getByRole('dialog', { name: `Convidar pessoas para ${SERVER}` });
    await invite.getByRole('button', { name: 'Gerar convite' }).click();
    const link = ((await invite.locator('code').first().textContent()) ?? '').trim();
    expect(link).toMatch(/\/j\/#GL1-/);
    await invite.getByRole('button', { name: 'Fechar', exact: true }).click();
    inviteLink = link;

    // Bia: onboarding, then back to Home and the rail's "+" → "Entrar em um servidor".
    await onboard(bia.page, 'Bia', 'Entrar num servidor');
    await bia.page.getByRole('button', { name: 'Voltar' }).click();
    await bia.page.getByRole('heading', { name: 'Bem-vindo, Bia!' }).waitFor();
    await bia.page.getByRole('navigation', { name: 'Servidores' }).getByRole('button', { name: 'Adicionar servidor' }).click();
    await bia.page.getByRole('dialog', { name: 'Adicionar servidor' }).getByRole('button', { name: /^Entrar em um servidor/ }).click();
    await joinWithInvite(bia.page, link);
    await textChannel(bia.page, 'geral').waitFor({ timeout: 30_000 });

    // Each sees the other online; Ana is the owner.
    await members(ana.page).getByRole('button', { name: /^Bia, Online/ }).waitFor({ timeout: 15_000 });
    await members(bia.page).getByRole('button', { name: /^Ana, Online, Dono/ }).waitFor({ timeout: 15_000 });
    sala = (await voiceChannel(ana.page, 'Sala de voz').getAttribute('data-voice-channel'))!;
    expect(sala).toMatch(/^\w+$/);
  });

  step('rejoin: the same invite takes Bia straight back in, without accepting it again', 60_000, async () => {
    // Owner request 2026-10-01: people reopened the invite to come back and were asked again.
    await bia.page.getByRole('button', { name: 'Início: seus servidores' }).click();
    await bia.page.getByRole('navigation', { name: 'Início' }).waitFor();
    await bia.page.getByRole('navigation', { name: 'Servidores' }).getByRole('button', { name: 'Adicionar servidor' }).click();
    await bia.page.getByRole('dialog', { name: 'Adicionar servidor' }).getByRole('button', { name: /^Entrar em um servidor/ }).click();
    await bia.page.getByRole('textbox').fill(inviteLink);
    await bia.page.getByRole('button', { name: 'Continuar' }).click();
    await textChannel(bia.page, 'geral').waitFor({ timeout: 30_000 });
    expect(await bia.page.getByRole('button', { name: 'Aceitar convite' }).count()).toBe(0);
    await members(ana.page).getByRole('button', { name: /^Bia, Online/ }).waitFor({ timeout: 15_000 });
  });

  step('chat: messages in #geral reach the other side, both ways', 60_000, async () => {
    await say(ana.page, 'geral', 'Oi Bia, bem-vinda ao servidor!');
    await message(bia.page, 'geral', 'Oi Bia, bem-vinda ao servidor!').waitFor({ timeout: 15_000 });
    await say(bia.page, 'geral', 'Valeu, Ana! Tudo certo por aqui.');
    await message(ana.page, 'geral', 'Valeu, Ana! Tudo certo por aqui.').waitFor({ timeout: 15_000 });
    // Authored by whom the other side thinks.
    expect(await message(bia.page, 'geral', 'Oi Bia').getAttribute('aria-label')).toMatch(/^Ana, /);
    expect(await message(ana.page, 'geral', 'Valeu, Ana!').getAttribute('aria-label')).toMatch(/^Bia, /);
  });

  step('channels: Ana creates a second voice channel, and it appears for Bia', 60_000, async () => {
    await ana.page.locator('section[aria-labelledby="section-voice"]').getByRole('button', { name: 'Criar canal' }).click();
    const create = ana.page.getByRole('dialog', { name: 'Criar canal de voz' });
    await create.getByLabel('Nome', { exact: true }).fill('Sala 2');
    await create.getByRole('button', { name: 'Criar canal' }).click();
    await create.waitFor({ state: 'detached' });
    await voiceChannel(ana.page, 'Sala 2').waitFor();
    await voiceChannel(bia.page, 'Sala 2').waitFor({ timeout: 15_000 });
    sala2 = (await voiceChannel(ana.page, 'Sala 2').getAttribute('data-voice-channel'))!;
    expect(sala2).toMatch(/^\w+$/);
  });

  step('voice: both join, hear each other, and mute, deafen, speaking, server mute, move and push-to-talk work', 240_000, async () => {
    // Both join the same voice channel from the sidebar.
    await voiceChannel(ana.page, 'Sala de voz').click();
    await ana.page.locator('[data-voice-panel="connected"]').waitFor({ timeout: 30_000 });
    await voiceChannel(bia.page, 'Sala de voz').click();
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
    await voiceRow(bia.page, sala, 'Ana').getByRole('img', { name: 'Microfone desligado' }).waitFor({ timeout: 10_000 });
    await ana.page.locator('[data-voice-control="mute"]').click();
    await voiceRow(bia.page, sala, 'Ana').getByRole('img', { name: 'Microfone desligado' }).waitFor({ state: 'detached', timeout: 10_000 });
    await ana.page.locator('[data-voice-control="deafen"]').click();
    await voiceRow(bia.page, sala, 'Ana').getByRole('img', { name: 'Áudio desligado' }).waitFor({ timeout: 10_000 });
    await ana.page.locator('[data-voice-control="deafen"]').click();
    await voiceRow(bia.page, sala, 'Ana').getByRole('img', { name: 'Áudio desligado' }).waitFor({ state: 'detached', timeout: 10_000 });
    // After muting and deafening, her voice is back on the air.
    await expect.poll(() => tile(bia.page, 'Ana').getAttribute('data-speaking'), { timeout: 30_000 }).toBe('true');

    // Server mute from Ana (owner), in Bia's menu: Bia's microphone goes off the air until unmuted.
    await voiceRow(ana.page, sala, 'Bia').click({ button: 'right' });
    await ana.page.getByRole('menuitemcheckbox', { name: 'Silenciar voz no servidor' }).click();
    await ana.page.keyboard.press('Escape');
    await bia.page.locator('[data-voice-control="mute"][aria-label="Silenciado pelo servidor"]').waitFor({ timeout: 15_000 });
    await voiceRow(ana.page, sala, 'Bia').getByRole('img', { name: 'Silenciado pelo servidor' }).waitFor({ timeout: 15_000 });
    await expect.poll(() => tile(ana.page, 'Bia').getAttribute('data-receiving'), { timeout: 15_000 }).toBeNull();
    await voiceRow(ana.page, sala, 'Bia').click({ button: 'right' });
    await ana.page.getByRole('menuitemcheckbox', { name: 'Silenciar voz no servidor', checked: true }).click();
    await ana.page.keyboard.press('Escape');
    await bia.page.locator('[data-voice-control="mute"][aria-label="Silenciar"]').waitFor({ timeout: 15_000 });
    await expect.poll(() => tile(ana.page, 'Bia').getAttribute('data-receiving'), { timeout: 30_000 }).toBe('true');

    // Move: Bia's app joins the other channel by itself, and her screen follows the call.
    await voiceRow(ana.page, sala, 'Bia').click({ button: 'right' });
    await ana.page.getByRole('menuitem', { name: 'Mover para' }).click();
    await ana.page.getByRole('menu', { name: 'Mover para' }).getByRole('menuitem', { name: 'Sala 2' }).click();
    await voiceRow(bia.page, sala2, 'Bia').waitFor({ timeout: 20_000 });
    await expect.poll(() => bia.page.locator('[data-voice-panel="connected"]').textContent(), { timeout: 20_000 }).toContain('Sala 2');
    await voiceRow(ana.page, sala2, 'Bia').waitFor({ timeout: 20_000 });
    await bia.page.locator(`[data-voice-stage="${sala2}"]`).waitFor({ timeout: 10_000 });
    await bia.page.screenshot({ path: join(tmpdir(), 'ghostlink-e2e-voice-bia.png') });

    // The voice panel's settings button opens the user settings on the voice section.
    await bia.page.locator('[data-voice-panel]').getByRole('button', { name: 'Configurações de voz', exact: true }).click();
    await bia.page.locator('[data-voice-settings]').waitFor({ timeout: 10_000 });
    await bia.page.getByRole('button', { name: 'Fechar', exact: true }).click();
    await bia.page.locator('[data-voice-settings]').waitFor({ state: 'detached', timeout: 10_000 });

    // Push-to-talk: Bia comes back; Ana binds V in her user settings. Ana is silent until she holds it.
    await voiceChannel(bia.page, 'Sala de voz').click();
    await expect.poll(() => tile(bia.page, 'Ana').getAttribute('data-receiving'), { timeout: 30_000 }).toBe('true');
    await ana.page.getByRole('button', { name: 'Configurações do usuário' }).click();
    await ana.page.getByRole('tab', { name: 'Voz' }).click();
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
    await voiceRow(ana.page, sala, 'Bia').waitFor({ state: 'detached', timeout: 20_000 });
  });

  step('private: a private channel Ana creates never reaches Bia', 60_000, async () => {
    await textChannel(bia.page, 'geral').click();
    await ana.page.locator('section[aria-labelledby="section-text"]').getByRole('button', { name: 'Criar canal' }).click();
    const create = ana.page.getByRole('dialog', { name: 'Criar canal de texto' });
    await create.getByLabel('Nome', { exact: true }).fill('segredo');
    // Private, with no role allowed: only administrators and the owner see it (spec §6).
    await create.getByRole('switch').check();
    await create.getByRole('button', { name: 'Criar canal' }).click();
    await create.waitFor({ state: 'detached' });
    await textChannel(ana.page, 'segredo').waitFor();
    expect(await textChannel(ana.page, 'segredo').getAttribute('aria-label')).toContain('Canal privado');
    const secretId = (await textChannel(ana.page, 'segredo').getAttribute('data-channel'))!;

    // Ana writes there, then in #geral: once Bia has the later message, the channel would have reached her too.
    await say(ana.page, 'segredo', 'Só a administração lê isto.');
    await message(ana.page, 'segredo', 'Só a administração lê isto.').waitFor({ timeout: 15_000 });
    await textChannel(ana.page, 'geral').click();
    await say(ana.page, 'geral', 'Mensagem depois do canal privado');
    await message(bia.page, 'geral', 'Mensagem depois do canal privado').waitFor({ timeout: 15_000 });
    expect(await textChannel(bia.page, 'segredo').count()).toBe(0);
    expect(await bia.page.getByText('Só a administração lê isto.').count()).toBe(0);
    // Even asked for directly, the server does not show it to her.
    expect(await requestOutcome(bia.page, 'msg.history', { channelId: secretId })).toMatch(/^(NOT_FOUND|FORBIDDEN)$/);
  });

  step('kick: Ana kicks Bia, who is disconnected and cannot come back through the saved server', 90_000, async () => {
    // Bia is in voice when the kick lands: it takes her out of the voice channel too.
    await voiceChannel(bia.page, 'Sala de voz').click();
    await bia.page.locator('[data-voice-panel="connected"]').waitFor({ timeout: 30_000 });
    await voiceRow(ana.page, sala, 'Bia').waitFor({ timeout: 20_000 });

    await members(ana.page).getByRole('button', { name: /^Bia,/ }).click({ button: 'right' });
    await ana.page.getByRole('menuitem', { name: 'Expulsar Bia' }).click();
    const confirm = ana.page.getByRole('dialog', { name: 'Expulsar' });
    // Invite-only server: she will need a new invite (the confirmation says so).
    await confirm.getByText('ela vai precisar de um convite novo').waitFor();
    await confirm.getByRole('button', { name: 'Expulsar', exact: true }).click();

    // Bia: the session ends with KICKED, and the app offers no reconnect.
    const lost = bia.page.getByRole('alertdialog', { name: 'Você foi desconectado' });
    await lost.waitFor({ timeout: 15_000 });
    await lost.getByText('Você foi expulso do servidor.').waitFor();
    expect(await lost.getByRole('button', { name: 'Conectar de novo' }).count()).toBe(0);
    // Ana: Bia left the member list and the voice channel.
    await members(ana.page).getByRole('button', { name: /^Bia,/ }).waitFor({ state: 'detached', timeout: 15_000 });
    await voiceRow(ana.page, sala, 'Bia').waitFor({ state: 'detached', timeout: 20_000 });

    // Back home, the saved server does not let her in again (spec §7: blocked, then a new invite is needed).
    await lost.getByRole('button', { name: 'Voltar aos servidores' }).click();
    await bia.page.getByRole('navigation', { name: 'Servidores' }).getByRole('button', { name: SERVER, exact: true }).click();
    await bia.page.getByRole('alert').filter({ hasText: 'Você foi expulso há pouco' }).waitFor({ timeout: 20_000 });
    expect(await textChannel(bia.page, 'geral').count()).toBe(0);
    await members(ana.page).getByRole('button', { name: /^Ana, Online/ }).waitFor();
  });
});
