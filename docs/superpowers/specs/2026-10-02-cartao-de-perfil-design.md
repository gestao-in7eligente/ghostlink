# GhostLink — Cartão de perfil (como o Discord)

Aprovado pelo dono em 2026-10-02 ("Ao clicar no usuário, deve abrir um modal que nem o Discord", com prints do cartão do Discord e do menu ⋯). Escolhas: **cartão ao lado do clique** (não o modal grande); ações **cargos (adicionar e tirar)**, **enviar mensagem** e **copiar ID**. Sai na **v0.4.2**, sem a caixa de mensagem (ver §3).

## 1. O que abre e onde

| Tema | Decisão |
|---|---|
| Abrir | **Clique** no nome ou na foto do autor de uma mensagem, ou numa linha da lista de membros. O clique direito continua abrindo o menu de hoje (Mencionar, cargos, expulsar, banir), que ganha **Copiar ID do usuário**. |
| Posição | Ao lado do clique, como o Discord: à direita do nome no chat, à esquerda da lista de membros; sempre dentro da janela. Fecha ao clicar fora, com Esc ou ao abrir outro. |
| Tamanho | 340 px de largura, cantos de 8 px, sombra e cores da paleta do GhostLink (fundo `--bg-raised`). |

## 2. Conteúdo

1. **Faixa** de 60 px no topo, na cor média da foto da pessoa (sem foto: a cor das iniciais).
2. **Foto** de 80 px sobre a faixa, com borda da cor do cartão e a bolinha de online/offline.
3. **Nome** (20 px, negrito) com a etiqueta **BOT**, e as marcas **Você** / **Dono** quando for o caso.
4. **MEMBRO DESDE**: a data de entrada no servidor ("2 de out. de 2026").
5. **CARGOS**: fichas com a bolinha na cor do cargo. Quem pode gerenciar cargos e está acima da pessoa (as mesmas regras do menu de hoje) vê o **×** na ficha (tira) e uma ficha **(+)** que lista os cargos que pode dar. Usa `member.setRoles`; um erro (hierarquia, permissão) aparece em uma linha embaixo.
6. **Conversar com @Nome**: fica para a v0.4.3 (§3).
7. **⋯** no canto da faixa: **Mencionar** (põe a menção no compositor, o que o clique fazia antes) e **Copiar ID do usuário**.

## 3. Amigo ou não (v0.4.3)

Não dá para descobrir sozinho: cada servidor vê a pessoa com uma chave própria (HKDF do segredo mestre com o id do servidor) e a chave de amigo é outra, sem relação, de propósito (amigos §1.2: nenhum servidor liga alguém aos seus amigos). Decisão do dono (2026-10-02): o cartão ganha **Adicionar amigo**, um pedido levado pelo servidor; quando a pessoa aceita, os dois apps guardam quem é quem naquele servidor, e só então aparece **Conversar com @Nome** (Enter manda a DM e abre a conversa). Se já forem amigos, o pedido só faz a ligação. Nada se liga sem os dois aceitarem.

## 4. Fora

Faixa ou bio próprias, servidores e amigos em comum, nota pessoal, "Ver perfil completo".

## 5. Testes (enxutos)

- A cor da faixa (média da foto; iniciais sem foto) e a posição do cartão.
- O cartão: abre no clique, mostra cargos; o (+)/× aparecem só para quem pode; Copiar ID.
