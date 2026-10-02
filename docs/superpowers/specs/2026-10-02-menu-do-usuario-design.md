# GhostLink — Menu da pessoa (clique direito, como o Discord)

Aprovado pelo dono em 2026-10-02, a partir de um print do menu do Discord numa chamada de voz ("Isso"; "essas informações é quando tiver em chamada de áudio"). Escolha: **com tudo**, inclusive "Desativar áudio no servidor". Sai na **v0.4.3**.

## 1. Onde abre

Um menu só para a pessoa, o mesmo em três lugares: **nome ou foto no chat** (hoje o clique direito ali não faz nada), **linha da lista de membros** (troca o menu de hoje) e **participante de uma chamada** (troca o menu de hoje). Abre com o clique direito, a tecla de menu ou Shift+F10. O clique esquerdo continua abrindo o cartão de perfil.

## 2. Itens, em ordem (cada um só aparece quando faz sentido)

1. **Perfil**: abre o cartão de perfil da pessoa, como o clique esquerdo.
2. **Mencionar**: põe a menção no compositor.
3. *Separador.* Itens de voz, só quando a pessoa está numa chamada que eu vejo:
   - **Eu mesmo**: **Silenciar** ☐ (o meu microfone) e **Desativar áudio** ☐ (o meu som), os mesmos botões da barra da chamada.
   - **Outra pessoa**: **Silenciar** ☐, que silencia a pessoa só para mim (guardado no PC, por servidor e pessoa, como o volume), e **Volume do usuário** (o controle de 0 a 200% de hoje).
4. **Editar perfil por servidor** (só em mim): abre Configurações > Perfil, onde fica o "Apelido neste servidor".
5. **Cargos ›**: submenu com os cargos marcáveis, para quem pode gerenciar cargos e está acima da pessoa (as regras de hoje).
6. *Separador.* Moderação de voz (pessoa numa chamada, com a permissão no canal dela):
   - **Silenciar voz no servidor** ☐ (vermelho, MUTE_MEMBERS), que já existe.
   - **Desativar áudio no servidor** ☐ (vermelho, MUTE_MEMBERS), novo: a pessoa deixa de ouvir a chamada até alguém tirar; ela vê o fone cortado em vermelho e não consegue tirar sozinha.
   - **Mover para ›** (submenu de canais de voz, MOVE_MEMBERS) e **Desconectar** (vermelho, MOVE_MEMBERS), que já existem.
7. **Expulsar** e **Banir** (vermelhos), que já existem, com as confirmações de hoje.
8. *Separador.* **Copiar ID do usuário**, com o ícone de ID.

As caixas ☐ ficam à direita do texto, como no Discord. Os submenus abrem ao passar o mouse ou com a seta para a direita, e fecham com a seta para a esquerda.

Fora: "Apps" e "Abrir na visualização de moderador", que não têm equivalente no GhostLink.

## 3. Servidor

`voice.moderate` ganha as ações `deafen` e `undeafen` (permissão MUTE_MEMBERS, a mesma de silenciar; as mesmas regras de hierarquia). O participante ganha `serverDeafened` no estado de voz; o servidor corta a assinatura de áudio dessa pessoa na sala (LiveKit) enquanto valer. O app só mostra o item quando o servidor anuncia a função (servidores antigos não têm; eles se atualizam sozinhos).

## 4. Testes (enxutos)

- Servidor: `deafen`/`undeafen` com e sem permissão, hierarquia, estado enviado a todos, a assinatura cortada e devolvida.
- App: quais itens aparecem (eu, outra pessoa, em chamada ou não, com e sem permissão) e o "Silenciar só para mim" guardado.
