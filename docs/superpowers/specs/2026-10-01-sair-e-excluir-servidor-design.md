# GhostLink — Sair do servidor e excluir servidor

Desenho aprovado pelo dono em 2026-10-01 ("Quando excluir um servidor, deve abrir um modal de confirmação e ter pelo menos 48h até apagar de verdade… Só deve ter excluir de verdade, para quem é o ADMIN. Os usuários, essa opção deve ser Sair do servidor. Remover não seria útil para nada"; e "Desliga na hora, apaga em 48 h").

## 1. Decisões

| Tema | Decisão |
|---|---|
| "Remover da lista" | **Sai do app** (clique direito no trilho, ⋮ da Home). |
| Membro | **Sair do servidor** (o `server.leave` que já existe, com o `LeaveDialog`). |
| Dono | **Excluir servidor**. O dono não vê "Sair" (como no Discord). |
| Confirmação | Modal vermelho; o dono **digita o nome do servidor** para liberar o botão. |
| Efeito | O servidor **sai do ar na hora** e **é apagado de verdade 48 h depois**. Até lá, o dono pode **Restaurar**. |
| Lançamento | **v0.2.4**, junto com a correção do servidor hospedado reconhecido pelo nome (§6). |

## 2. Sair do servidor (membros)

- Onde: clique direito no ícone do servidor no trilho, ⋮ na lista da Home, e o menu do nome do servidor (cabeçalho da barra lateral).
- Abre o `LeaveDialog` que já existe ("Sair de {servidor}?", com "apagar minhas mensagens"). Confirmado: `server.leave`, desconecta e tira o servidor da lista salva.
- **Servidor que não responde** (desligado, excluído, endereço mudou): o diálogo avisa "Não foi possível falar com o servidor" e oferece **Tirar só da minha lista**.

## 3. Excluir servidor (dono)

- Onde: os mesmos menus (no lugar de "Sair") e Configurações do servidor → aba Visão geral, numa área "Zona de perigo".
- **Modal:** título "Excluir {servidor}?", texto: "O servidor sai do ar agora para todos. Ele é apagado de vez em 48 h — mensagens, canais, cargos e arquivos. Até lá, você pode restaurá-lo." Campo "Digite o nome do servidor para confirmar"; botão vermelho **Excluir servidor** só com o nome exato.
- **Servidor** (novo pedido `server.delete {}`, só o dono; protocolo novo, `features: ['serverDelete']`):
  1. grava `deleting_at = agora + 48 h` em `server_meta`;
  2. manda o evento `server.deleting { at }` a todos e **encerra as sessões de todo mundo menos a do dono** (motivo `SERVER_DELETING`);
  3. enquanto `deleting_at` existir, **recusa** no handshake qualquer pessoa que não seja o dono, com `SERVER_DELETING` e a data (erro novo em `packages/shared/src/errors.ts`, com textos pt-BR/en no app); convites param de funcionar; o dono entra normalmente e vê só a faixa de restauração;
  4. `server.restore {}` (só o dono, antes do prazo) apaga `deleting_at`, manda `server.restored` e volta ao normal;
  5. **no prazo:** apaga os dados (o banco, os arquivos de avatar, o certificado fica) e passa a recusar todo mundo com `SERVER_DELETED`. Um servidor que reinicia depois do prazo faz o mesmo no início. A verificação roda a cada minuto.
- **App do dono:**
  - faixa vermelha no topo: "{servidor} está fora do ar e será excluído em 47 h" + **Restaurar servidor**;
  - **Railway criado pelo app** (`managed`): logo ao confirmar, nada muda no Railway (o processo fica no ar só para recusar e para o dono poder restaurar). No prazo — ou na próxima abertura do app depois dele — o app **apaga o projeto no Railway** (`projectDelete`), tira o registro de `managed` e o servidor da lista salva. Um restaurar antes do prazo cancela isso.
  - **Hospedado neste PC:** no prazo, o app para o servidor local e apaga a pasta `hosted/<servidor>`.
- **App dos membros:** ao ser desconectado com `SERVER_DELETING`, ou ao tentar entrar e receber esse erro: "{servidor} foi desligado pelo dono e será excluído em {data}." Com `SERVER_DELETED`: "{servidor} foi excluído pelo dono" e o app tira o servidor da lista.
- **Servidor antigo** (sem `serverDelete`): o dono não vê "Excluir servidor"; os servidores se atualizam sozinhos (spec "servidores acompanham o app").

## 4. Segurança

- Só o dono atual (`ownerId`) pode `server.delete` / `server.restore`; limite de 5 por hora.
- Nada é apagado antes do prazo; o prazo vem do relógio do servidor.
- O app só apaga projetos do Railway que ele mesmo criou (`managed`) e só depois de o servidor confirmar o prazo vencido (`SERVER_DELETED`) ou de o registro local de exclusão (com a data recebida em `server.deleting`) ter passado.

## 5. Testes

- **Servidor:** só o dono; sessões encerradas menos a do dono; handshake recusado para os outros e convites recusados; restaurar; prazo vencido (relógio injetado) apaga e recusa; reinício depois do prazo.
- **App:** os menus (dono vê Excluir, membro vê Sair, ninguém vê Remover); o modal só libera com o nome exato; as faixas e mensagens; a decisão de apagar o projeto no Railway (antes do prazo nunca; depois sim; restaurado nunca) com o Railway falso; a pasta local apagada no prazo.
- **e2e:** Ana (dona) exclui; Bia é desconectada com a mensagem e não consegue entrar; Ana restaura; Bia entra de novo. Prazo vencido com relógio de teste: Bia vê "excluído" e o servidor some da lista dela.

## 6. Correção junto: servidor hospedado reconhecido pelo nome

- Hoje, com o modo hospedar parado, `homeServerRows` reconhece o servidor hospedado **pelo nome**. Um servidor do Railway com o mesmo nome de um servidor local antigo ("Tropa do ADS") aparece como "Seu servidor · parado" com ▶ e o clique tenta ligar o local.
- Correção: o `HostManager` lê a chave (`readServerKeyId`) do certificado da pasta do último servidor ao carregar e a mantém depois de parar; `status().serverKeyId` passa a vir sempre que a pasta existe. `homeServerRows` **nunca** compara por nome: sem chave conhecida, nada é marcado como hospedado aqui.
