# GhostLink: página dos bots mais larga e abas no Hermes da empresa (v0.6.3)

Pedido do dono em 2026-10-03, com o print da página do Hermes da empresa no TC Flag, que mostra 69 skills numa coluna estreita: "A página dos bots deve ter o width maior. A página do Hermes deve ter abas." Ele escolheu **larga + 5 abas**.

Só o app muda. O servidor e o protocolo ficam iguais aos da v0.6.2.

## 1. Página de todo bot, mais larga

- A página de qualquer bot (Hermes, Ghost DJ e bots comuns) passa a ocupar a área do conteúdo até **1100 px** de largura, centralizada.
- O cabeçalho (faixa, foto, nome, BOT, situação, "Criado por…") acompanha essa largura.
- Em janela estreita, ela continua cabendo sem barra de rolagem horizontal.

## 2. Abas na página do Hermes da empresa

As abas valem para quem vê a página da v0.6.2 (o dono e o cargo escolhido) e ficam logo abaixo do cabeçalho e do selo "Hermes da empresa". Elas seguem o visual das abas que o app já tem.

1. **Visão geral**, aberta por padrão: a situação e os modelos, como hoje.
2. **Skills N**:
   - **Busca** por nome e descrição.
   - **Grade em 2 colunas** com cartões compactos (nome e descrição em uma ou duas linhas). Em janela estreita, vira 1 coluna.
   - **Filtro Ligadas | Todas**, só para o dono, que usa o estado completo que ele já recebe. Em "Todas", as desligadas aparecem esmaecidas, com a marca "desligada".
   - **Quem tem o cargo** vê só as ligadas, sem o filtro.
   - **O dono** ganha também o botão **Gerenciar skills**, que abre Configurações → Skills.
3. **Acesso**: os canais onde ele responde e quem pode usar, como hoje, inclusive "+N canais que você não vê".
4. **Memória**, só o dono: a contagem e o botão **Abrir**, como hoje. Quem tem o cargo não vê essa aba.
5. **Comandos**: a lista de comandos que hoje fica embaixo.

## 3. Comportamento das abas

- **Quando a aba volta para Visão geral:** ao trocar de bot ou de servidor.
- **Atualização ao vivo:** a aba aberta se atualiza sozinha, sem fechar.
- **Bots comuns e Ghost DJ:** ficam sem abas, só mais largos.

## 4. Testes (enxutos)

- **Auxiliar puro das abas:**
  - quais abas cada pessoa vê;
  - a busca de skills (nome e descrição, sem diferenciar maiúsculas e acentos);
  - o filtro Ligadas | Todas.
- **i18n:** completo em pt-BR e em inglês.
