# GhostLink — Cartão de perfil (como o Discord)

Aprovado pelo dono em 2026-10-02 ("Ao clicar no usuário, deve abrir um modal que nem o Discord", com prints do cartão do Discord e do menu ⋯). Escolhas: **cartão ao lado do clique** (não o modal grande); ações **cargos (adicionar e tirar)**, **enviar mensagem** e **copiar ID**. Sai na **v0.4.2**.

## 1. O que abre e onde

| Tema | Decisão |
|---|---|
| Abrir | **Clique** no nome ou na foto do autor de uma mensagem, ou numa linha da lista de membros. O clique direito continua abrindo o menu de hoje (Mencionar, cargos, expulsar, banir), que ganha **Copiar ID do usuário**. |
| Posição | Ao lado do clique, como o Discord: à direita do nome no chat, à esquerda da lista de membros; sempre dentro da janela. Fecha ao clicar fora, com Esc ou ao abrir outro. |
| Tamanho | 340 px de largura, cantos de 8 px, sombra e cores da paleta do GhostLink (fundo `--bg-floating`). |

## 2. Conteúdo

1. **Faixa** de 60 px no topo, na cor média da foto da pessoa (sem foto: a cor das iniciais).
2. **Foto** de 80 px sobre a faixa, com borda da cor do cartão e a bolinha de online/offline.
3. **Nome** (20 px, negrito) com a etiqueta **BOT**, e as marcas **Você** / **Dono** quando for o caso.
4. **MEMBRO DESDE**: a data de entrada no servidor ("2 de out. de 2026").
5. **CARGOS**: fichas com a bolinha na cor do cargo. Quem pode gerenciar cargos e está acima da pessoa (as mesmas regras do menu de hoje) vê o **×** na ficha (tira) e uma ficha **(+)** que lista os cargos que pode dar. Usa `member.setRoles`; um erro (hierarquia, permissão) aparece em uma linha embaixo.
6. **Conversar com @Nome**: uma caixa de texto, só quando a pessoa é **sua amiga**. Enter envia a mensagem pela DM e abre a conversa. Quem não é amigo não vê a caixa (o GhostLink só tem DM entre amigos).
7. **⋯** no canto da faixa: **Mencionar** (põe a menção no compositor, o que o clique fazia antes) e **Copiar ID do usuário**.

## 3. Amigo ou não

O id de um membro é `hex(SHA-256(chave pública))[0:32]`; a chave do amigo já está na lista de amigos. O main passa a mandar o `userId` de cada amigo no snapshot de amigos; o cartão procura o membro ali (estado `friend`).

## 4. Fora

Faixa ou bio próprias, servidores e amigos em comum, nota pessoal, "Ver perfil completo", adicionar amigo pelo cartão.

## 5. Testes (enxutos)

- A cor da faixa (média da foto; iniciais sem foto) e o `userId` dos amigos no snapshot.
- O cartão: abre no clique, mostra cargos; o (+)/× aparecem só para quem pode; Enter na caixa manda a DM; Copiar ID.
