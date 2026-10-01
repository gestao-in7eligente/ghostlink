// Friends over P2P, end to end (friends spec 2026-09-30 §11): two real apps on a private
// loopback DHT. Ana hands out her code, Bia sends the request, Ana accepts, each sees the
// other online, they talk in a direct conversation (also while Bia is away), and removing
// the friendship takes it away on both sides.
import createTestnet from 'hyperdht/testnet.js';
import type { Page } from 'playwright-core';
import { afterAll, describe, expect, it, type TestContext } from 'vitest';
import { E2eRun, onboard, type Instance } from './harness.js';

const tab = (page: Page, name: string | RegExp) => page.getByRole('tab', { name });
const row = (page: Page, name: string) => page.getByRole('listitem').filter({ hasText: name });
const message = (page: Page, text: string) => page.getByRole('article').filter({ hasText: text });
const dmRow = (page: Page, name: string) => page.getByRole('list', { name: 'Mensagens diretas' }).getByRole('button', { name: new RegExp(`^${name}`) });
const friendsNav = (page: Page) => page.getByRole('navigation').getByRole('button', { name: /^Amigos/ });

/** Onboarding, then back to the Home screen (the Friends page). */
async function openHome(page: Page, nickname: string): Promise<void> {
  await onboard(page, nickname, 'Entrar num servidor');
  await page.getByRole('button', { name: 'Voltar' }).click();
  await page.getByRole('heading', { name: `Bem-vindo, ${nickname}!` }).waitFor();
}

describe('GhostLink friends: request by code, presence, direct messages, remove', () => {
  const run = new E2eRun();
  let ana!: Instance;
  let bia!: Instance;
  let env: Record<string, string> = {};
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

  afterAll(() => run.close(), 180_000);

  step('start: two apps on a private DHT open the Friends page', 120_000, async () => {
    const testnet = await createTestnet(3);
    run.onClose(() => testnet.destroy());
    env = {
      GHOSTLINK_DHT_BOOTSTRAP: testnet.bootstrap.map((node) => `${node.host}:${node.port}`).join(','),
      GHOSTLINK_P2P_BIND: '127.0.0.1',
    };
    ana = await run.launch('ana', env);
    bia = await run.launch('bia', env);
    await openHome(ana.page, 'Ana');
    await openHome(bia.page, 'Bia');
    // The user panel says the friends network is up.
    await ana.page.getByRole('status').filter({ hasText: 'Online para amigos' }).waitFor({ timeout: 30_000 });
    await bia.page.getByRole('status').filter({ hasText: 'Online para amigos' }).waitFor({ timeout: 30_000 });
  });

  step('request: Bia pastes Ana\'s code and Ana sees the request with Bia\'s name', 90_000, async () => {
    await tab(ana.page, 'Adicionar amigo').click();
    const code = ((await ana.page.getByRole('region', { name: 'Seu código de amigo' }).locator('code').textContent()) ?? '').trim();
    expect(code).toMatch(/^GLF1(-[A-Z2-7]{4}){21}$/);

    await tab(bia.page, 'Adicionar amigo').click();
    // Her own code is refused.
    const biaCode = ((await bia.page.getByRole('region', { name: 'Seu código de amigo' }).locator('code').textContent()) ?? '').trim();
    await bia.page.getByRole('textbox', { name: 'Código de amigo', exact: true }).fill(biaCode);
    await bia.page.getByRole('button', { name: 'Enviar pedido de amizade' }).click();
    await bia.page.getByRole('alert').filter({ hasText: 'Esse é o seu próprio código.' }).waitFor();

    await bia.page.getByRole('textbox', { name: 'Código de amigo', exact: true }).fill(code);
    await bia.page.getByRole('button', { name: 'Enviar pedido de amizade' }).click();
    await bia.page.getByRole('status').filter({ hasText: 'Pedido enviado.' }).waitFor();
    await tab(bia.page, /^Pendentes/).click();
    await row(bia.page, 'Pedido enviado').waitFor();

    // Ana: the badge, then the request with the name Bia announced.
    await tab(ana.page, /^Pendentes/).click();
    await row(ana.page, 'Bia').filter({ hasText: 'Quer ser seu amigo' }).waitFor({ timeout: 60_000 });
  });

  step('accept: Ana accepts and each sees the other online', 90_000, async () => {
    await ana.page.getByRole('button', { name: 'Aceitar: Bia' }).click();
    await tab(ana.page, 'Online').click();
    await row(ana.page, 'Bia').filter({ hasText: 'Online' }).waitFor({ timeout: 60_000 });
    await tab(bia.page, 'Online').click();
    await row(bia.page, 'Ana').filter({ hasText: 'Online' }).waitFor({ timeout: 60_000 });
    // Nothing is left pending on either side.
    await tab(bia.page, /^Pendentes/).click();
    await bia.page.getByText('Nenhum pedido pendente.').waitFor();
  });

  step('nickname: a local nickname shows only here', 60_000, async () => {
    await tab(bia.page, 'Todos').click();
    await bia.page.getByRole('button', { name: 'Mais opções de Ana' }).click();
    await bia.page.getByRole('menuitem', { name: 'Mudar apelido' }).click();
    const dialog = bia.page.getByRole('dialog', { name: 'Apelido de Ana' });
    await dialog.getByRole('textbox').fill('Aninha');
    await dialog.getByRole('button', { name: 'Salvar' }).click();
    await row(bia.page, 'Aninha').waitFor();
    await tab(ana.page, 'Todos').click();
    await row(ana.page, 'Bia').waitFor();
  });

  step('dm: Bia opens the conversation from the friends list and they talk', 120_000, async () => {
    await bia.page.getByRole('button', { name: 'Enviar mensagem para Aninha' }).click();
    const biaBox = bia.page.getByRole('textbox', { name: 'Conversar com @Aninha' });
    await biaBox.fill('Oi Ana!');
    await biaBox.press('Enter');
    // Ana is online, so it is delivered.
    await message(bia.page, 'Oi Ana!').getByRole('img', { name: 'Entregue' }).waitFor({ timeout: 60_000 });

    // Ana: the conversation shows in the sidebar with the unread badge; opening it clears it.
    await dmRow(ana.page, 'Bia').getByLabel('1 mensagens não lidas').waitFor({ timeout: 60_000 });
    await dmRow(ana.page, 'Bia').click();
    await message(ana.page, 'Oi Ana!').waitFor();
    await dmRow(ana.page, 'Bia').getByLabel('1 mensagens não lidas').waitFor({ state: 'detached', timeout: 30_000 });
    const anaBox = ana.page.getByRole('textbox', { name: 'Conversar com @Bia' });
    await anaBox.fill('Oi Bia, tudo bem?');
    await anaBox.press('Enter');
    await message(bia.page, 'Oi Bia, tudo bem?').waitFor({ timeout: 60_000 });
  });

  step('offline: Bia quits, Ana writes two more, Bia comes back and gets them in order', 240_000, async () => {
    bia = await run.restart(bia, env);
    await ana.page.getByText('Bia está offline. A mensagem chega quando vocês dois estiverem online.').waitFor({ timeout: 60_000 });
    const anaBox = ana.page.getByRole('textbox', { name: 'Conversar com @Bia' });
    for (const text of ['Primeira enquanto você estava fora', 'Segunda enquanto você estava fora']) {
      await anaBox.fill(text);
      await anaBox.press('Enter');
      await message(ana.page, text).getByRole('img', { name: 'Enviada' }).waitFor();
    }

    // Bia is back on the Home screen; the friend link comes up and the two messages sync.
    await bia.page.getByRole('status').filter({ hasText: 'Online para amigos' }).waitFor({ timeout: 60_000 });
    await dmRow(bia.page, 'Aninha').getByLabel('2 mensagens não lidas').waitFor({ timeout: 90_000 });
    await dmRow(bia.page, 'Aninha').click();
    await message(bia.page, 'Segunda enquanto você estava fora').waitFor();
    const texts = await bia.page.getByRole('article').allTextContents();
    const first = texts.findIndex((t) => t.includes('Primeira enquanto'));
    const second = texts.findIndex((t) => t.includes('Segunda enquanto'));
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    await message(ana.page, 'Segunda enquanto você estava fora').getByRole('img', { name: 'Entregue' }).waitFor({ timeout: 60_000 });
  });

  step('edit and delete: Ana changes one message and deletes another, Bia sees both', 120_000, async () => {
    const second = message(ana.page, 'Segunda enquanto você estava fora');
    await second.hover();
    await second.getByRole('button', { name: 'Editar' }).click();
    const anaBox = ana.page.getByRole('textbox', { name: 'Conversar com @Bia' });
    await anaBox.fill('Segunda, editada');
    await anaBox.press('Enter');
    await message(bia.page, 'Segunda, editada').filter({ hasText: '(editada)' }).waitFor({ timeout: 60_000 });

    const first = message(ana.page, 'Primeira enquanto você estava fora');
    await first.hover();
    await first.getByRole('button', { name: 'Apagar' }).click();
    await ana.page.getByRole('dialog', { name: 'Apagar mensagem?' }).getByRole('button', { name: 'Apagar' }).click();
    await message(ana.page, 'Primeira enquanto você estava fora').waitFor({ state: 'detached' });
    await message(bia.page, 'Primeira enquanto você estava fora').waitFor({ state: 'detached', timeout: 60_000 });
  });

  step('remove: Bia ends the friendship and Ana loses her too', 90_000, async () => {
    await friendsNav(bia.page).click();
    await friendsNav(ana.page).click();
    await tab(bia.page, 'Todos').click();
    await bia.page.getByRole('button', { name: 'Mais opções de Aninha' }).click();
    await bia.page.getByRole('menuitem', { name: 'Desfazer amizade' }).click();
    await bia.page.getByRole('dialog', { name: 'Desfazer amizade com Aninha?' }).getByRole('button', { name: 'Desfazer amizade', exact: true }).click();
    await bia.page.getByRole('heading', { name: 'Bem-vindo, Bia!' }).waitFor({ timeout: 30_000 });
    await ana.page.getByRole('heading', { name: 'Bem-vindo, Ana!' }).waitFor({ timeout: 60_000 });
  });
});
