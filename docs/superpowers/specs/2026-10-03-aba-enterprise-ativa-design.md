# GhostLink: a aba Enterprise depois de ativada (v0.6.1)

Pedido do dono em 2026-10-03, com o print da aba já ativa no TC Flag: "Quando ativar, deve mudar essa tela." O dono escolheu a opção **só o cartão da licença**: o Hermes continua só na lista de bots.

## O que muda

Hoje a aba **Configurações do servidor → Enterprise** mostra sempre a identidade do servidor e o campo "Colar licença", mesmo com a licença ativa. Ela passa a ter dois jeitos:

- **Servidor normal, sem licença válida:** fica como hoje, com o texto explicativo, a identidade do servidor com "Copiar" e o campo "Colar licença" com "Salvar licença".
- **Servidor Enterprise:**
  - **Cartão da licença:** mostra "✓ Enterprise ativo", a empresa e "válida até DD/MM/AAAA", mais "faltam N dias".
  - **Cor do cartão:**
    - normal enquanto a licença vale;
    - de aviso nos 7 dias antes de vencer, com "vence em N dias";
    - de perigo no prazo de 7 dias depois de vencer, com "venceu em DD/MM; o servidor volta a ser normal em N dias".
  - **Texto abaixo do cartão:** "Servidores Enterprise têm o Hermes da empresa e não têm o Ghost DJ."
  - **Botão "Renovar ou trocar licença":** abre logo abaixo a identidade do servidor com "Copiar" e o campo "Colar licença" com "Salvar licença". Ao salvar com sucesso, o formulário fecha e o cartão mostra a licença nova.
  - **Licença recusada:** o erro aparece no formulário aberto, que continua aberto.
- **Só o dono vê** os detalhes, como hoje.
- **Textos:** em pt-BR e em inglês.

## Testes (enxutos)

- **Lógica num auxiliar puro:**
  - qual jeito mostrar: normal ou Enterprise;
  - a cor do cartão: ativo, vencendo ou no prazo;
  - a contagem de dias.
- **Teste do auxiliar:** cobre essas regras, inclusive os limites de 7 dias.
