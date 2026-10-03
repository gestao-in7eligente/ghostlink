# GhostLink: a página do Hermes da empresa (v0.6.2)

Pedido do dono em 2026-10-03, com o print da página de um bot Hermes que mostrava só "Comandos — 0": "Nessa página do bot Hermes deve mostrar as skills, modelos de IA...". Decisões do dono:

- **Quem vê:** o dono e um cargo, que o dono escolhe.
- **O que a página mostra:** a situação e o modelo, as skills ligadas, onde ele responde e quem pode usar, e a memória (esta só para o dono).
- O desenho foi aprovado como proposto.

Este desenho estende `2026-10-02-enterprise-e-hermes-da-empresa-design.md` §2.

## 1. Quem vê

- **O dono** sempre vê a página.
- **O cargo escolhido:**
  - A aba **Quem pode usar**, nas configurações do Hermes da empresa, ganha o campo **Cargo que vê a página**.
  - Ele vem vazio, e assim só o dono vê. O valor pode ser nenhum ou um cargo do servidor.
  - Quem tem esse cargo vê a página, mas **não** vê a memória e **não** mexe em nada.
- **Os outros membros** veem a página do bot como hoje, só com os comandos.
- **As configurações** continuam só do dono, pelo botão direito → Configurações.
- **Se o cargo for apagado,** o campo volta para "nenhum".
- **Se o servidor deixar de ser Enterprise,** ninguém além do dono vê a página.

## 2. O que a página mostra

Vale para o clique normal no bot "Hermes da empresa". Abaixo do cabeçalho de hoje (foto, nome, BOT, online, "Criado por…"), aparece o selo **Hermes da empresa** e quatro blocos:

1. **Situação e modelo:**
   - "Conectado" ou "Desconectado".
   - O modelo principal e o reserva configurados (provedor · modelo), ou "sem reserva".
   - O modelo em uso que o Hermes informou, se for diferente do configurado.
2. **Skills — N:** o nome e a descrição de cada skill **ligada**, a partir da última lista que o Hermes mandou. Se o Hermes nunca informou nada, aparece "O Hermes ainda não informou as skills".
3. **Onde e quem usa:**
   - Os canais onde ele responde: "Todos os canais" ou a lista de nomes.
   - Os cargos que podem falar com ele, mais "o dono".
4. **Memória** (só o dono): "N itens sobre a empresa · M sobre as pessoas", com o botão **Abrir** para a aba Memória das configurações.

A seção **Comandos** continua lá embaixo, como hoje. A página se atualiza ao vivo quando o Hermes manda um relatório novo ou o dono muda as configurações.

## 3. Segurança

- **O que nunca vai para o cargo:** as chaves (nem os 4 últimos caracteres), o texto da memória e a contagem da memória. Ele recebe só o que os blocos 1 a 3 mostram.
- **O que o Hermes recebe:** o campo "Cargo que vê a página" fica só no GhostLink e **não** vai no `hermes.config`. O plugin 1.1 não muda.
- **Quem recebe a visão:** o servidor manda a página a quem tem o direito, no momento do pedido e quando os cargos mudam. Quem perde o cargo deixa de receber na hora.

## 4. Protocolo

- **Função nova:** `enterpriseHermesView`. Apps e servidores antigos ignoram e mostram a página como hoje.
- **Pedido `hermes.view`:** permitido ao dono e a quem tem o cargo. Devolve a visão (blocos 1 a 3, mais a memória quando é o dono). Para os outros, `FORBIDDEN`.
- **Evento `hermes.view`:** vai ao dono e aos membros com o cargo quando a visão muda.
- **No welcome:** o dono e os membros com o cargo recebem a visão já na entrada, então o app sabe qual bot é o Hermes da empresa.
- **`hermes.update`:** aceita o novo `viewerRoleId: string | null`, só do dono. O cargo precisa existir.

## 5. Testes (enxutos)

- **Servidor:**
  - o dono e quem tem o cargo recebem a visão; outro membro recebe `FORBIDDEN` e nenhum evento;
  - a visão do cargo não tem chave nem memória;
  - perder o cargo para o envio;
  - apagar o cargo zera o campo;
  - o `hermes.config` não leva o campo.
- **App:**
  - um auxiliar puro monta os blocos a partir da visão: sem relatório, com reserva e sem, canais "todos" ou a lista;
  - o i18n completo em pt-BR e em inglês.
