# GhostLink — Página do bot (mockup)

Desenho aprovado pelo dono em 2026-10-02 ("Ao clicar no bot, deve abrir uma página tipo um dashboard com o que ele faz… tipo a aba de Geral, que abre o chat"). Complementa [`2026-10-02-bots-design.md`](2026-10-02-bots-design.md).

**Escopo desta versão (dono, 2026-10-02: "Deixe sem opções funcionais. Deixe apenas em mockup"):** só a tela, no app. A navegação (clicar no bot abre a página como um canal) funciona; o topo e a lista de comandos usam o que o app já recebe (nome, foto, online, comandos); **Sobre, Atividade e Gerenciar são mockup** — textos e números de exemplo fixos e botões desativados com o título "Em breve". **Nada no servidor muda**; as seções "Servidor" e os testes de servidor abaixo ficam para quando o dono pedir a versão funcional.


**Layout final (dono, 2026-10-02: "essas opções… devem ficar na opção Configurações quando clicar com o botão direito"):**
- **Clique esquerdo** no bot: seleciona como um canal e abre uma **página simples** no centro, só com dados reais — foto, nome, BOT, Online/Offline e os slash commands (opções, tipo, obrigatória, escolhas).
- **Botão direito / ⋮:** **Configurações** (primeiro item), depois **Gerar novo código** e **Excluir bot** (estes dois funcionam).
- **Configurações** abre a tela grande no estilo das Configurações do servidor, com as abas Visão geral, Comandos (real), Atividade (7 dias), Permissões, Código de conexão e Excluir bot. Tudo que não é a lista de comandos é **mockup** com a etiqueta "Prévia", e todos os botões ficam desativados com "Em breve".

O restante deste documento descreve a versão funcional futura.

## Comportamento (versão funcional futura)

- Clicar num bot da seção **BOTS** abre a **página do bot no centro**, como clicar em `#geral` abre o chat; o bot fica selecionado na barra lateral (o mesmo destaque dos canais). Clicar num canal volta ao chat. A menção "@bot" deixa de ser inserida pelo clique (continua pelo menu de membros).
- **Topo:** foto, nome, etiqueta BOT, estado (Online / Offline · "visto por último há …"), "Criado por {pessoa} em {data}".
- **Sobre:** descrição (até 1000 caracteres, markdown seguro do chat). Editável por quem tem `MANAGE_SERVER` na própria página; o bot também pode definir pelo pacote (`client.application.edit({ description })`, mapeado para um pedido novo).
- **Comandos:** cada slash command com descrição e opções (nome, tipo, obrigatória, escolhas). **Usar** volta ao último canal de texto aberto com `/comando ` já no compositor.
- **Atividade (últimos 7 dias):** usos por comando (barras), as últimas 20 interações (quem, comando, quando, se respondeu) e mensagens do bot hoje. Só quem pode ver o canal da interação a vê listada.
- **Gerenciar** (`MANAGE_SERVER`): editar nome, foto e descrição; em quais canais o bot vê e fala (pelos cargos; atalho para Cargos); **Gerar novo código**; **Excluir bot**. Bot que nunca conectou: passo a passo (código → `GHOSTLINK_BOT` → trocar o `import`) com link para o guia.

## Servidor

- `bots.description` (texto), `bots.last_seen_at`; tabela `bot_command_uses (bot_id, command, channel_id, user_id, at, answered)` com limpeza de mais de 7 dias.
- `bot.get { botId }` → `{ bot (com description, lastSeenAt, createdBy, createdAt, online), commands, usage: [{ command, count }], recent: [...20, filtradas por VIEW_CHANNEL de quem pede], messagesToday }`.
- `bot.update { botId, name?, description? }` (MANAGE_SERVER); `bot.setDescription { description }` (o próprio bot); evento `bot.updated`.

## Testes (enxutos)

Servidor: `bot.get` (filtro por canal), `bot.update`, contagem de usos. App: um passo no `bots.e2e.ts`: clicar no bot abre a página, mostra os comandos e o uso do `/ping`.
