# GhostLink — Amigos e mensagens diretas P2P (v0.3)

Desenho aprovado pelo dono em 2026-09-30. Complementa a spec principal
([`2026-09-27-ghostlink-design.md`](2026-09-27-ghostlink-design.md)); onde este documento não diz nada, vale a spec principal.

## 1. Visão geral

### 1.1 Objetivo

A Home do app (o ícone da casa) passa a ser a página de **Amigos** do Discord: lista de amigos, pedidos pendentes, mensagens diretas 1:1 e em grupo, imagens e arquivos, e chamadas de voz. Tudo acontece **direto entre os computadores** (P2P), sem passar por nenhum servidor GhostLink.

### 1.2 Decisões tomadas

| Tema | Decisão |
|---|---|
| Caminho das mensagens | Direto entre os dois computadores (P2P), criptografado ponta a ponta. Nenhum servidor lê nem guarda as conversas. |
| Identidade | Uma **chave de amigo** por pessoa, derivada da semente-mestra e separada das chaves por servidor. Servidores não conseguem ligar uma pessoa entre eles por causa dos amigos. |
| Adicionar amigo | Dois jeitos: **código de amigo** (copiar e colar, ou link `ghostlink://amigo/…`) e **"Adicionar amigo"** no menu de um membro de um servidor em comum. |
| Entrega offline | A mensagem fica guardada no PC de quem enviou e é entregue quando os dois estiverem online ao mesmo tempo. Em grupo, outro membro que já recebeu pode entregar. |
| Escopo da primeira versão | Texto, imagens e arquivos, DM em grupo (até 10 pessoas) e chamada de voz (até 8 numa chamada). |
| Rede P2P | Hyperswarm (DHT pública da Holepunch, MIT), com binários prontos para Windows, macOS e Linux. |
| Chamadas | WebRTC direto entre os participantes (malha), com STUN público configurável. |
| Lançamento | Sai como **v0.3.0**, depois da v0.2.0 (Railway e visual Discord). |

### 1.3 Fora do escopo desta versão

- Vídeo e compartilhamento de tela nas chamadas de DM.
- Usar a mesma identidade em dois computadores ao mesmo tempo.
- Levar a lista de amigos e o histórico no backup `.ghostkey` (o backup recupera só o código de amigo).
- Retransmissão por terceiros quando a conexão direta não abre (relay/TURN).
- Status personalizado, "não perturbe", busca no histórico, reações e menções em DM.
- Criptografia do banco local em disco (fica como o banco do servidor: protegido só pela conta do sistema).

### 1.4 O que muda na promessa de privacidade

O site e o README ganham estes pontos, em linguagem simples:

- **Quem é seu amigo vê seu IP**, como em qualquer conexão direta.
- **Quem tem seu código de amigo** consegue tentar falar com você e, ao conectar, vê seu IP enquanto você está online. Dá para **gerar um código novo** (o antigo para de funcionar; os amigos atuais continuam) e para **desligar pedidos por código**.
- A rede distribuída (DHT) é pública: os nós que guardam seu anúncio veem sua chave de amigo e seu IP. Eles não veem mensagens.
- Nas chamadas, o app pergunta seu endereço público a um servidor STUN (padrão: Google e Cloudflare). Ele vê só o IP. A lista é configurável e pode ficar vazia (aí a chamada só funciona na mesma rede ou com portas abertas).
- O conteúdo (mensagens, arquivos, voz) é criptografado ponta a ponta entre os participantes.

## 2. Identidade de amigo

- **Semente:** `friendSeed = HKDF-SHA256(ikm = masterSeed, salt = "ghostlink/friend/v1", info = "", len = 32)`.
- **Chave:** Ed25519 a partir de `friendSeed`. É a identidade de longa duração e a chave estática do handshake Noise do Hyperswarm.
- **Segredo de convite:** `inviteSecret`, 16 bytes aleatórios, guardado no banco local. "Gerar código novo" sorteia outro.
- **Código de amigo:** `GLF1-` + base32 (RFC 4648, sem padding, em grupos de 4) de `friendPub (32) ‖ inviteSecret (16) ‖ checksum (4)`, em que `checksum = SHA-256("ghostlink/friendcode/v1" ‖ friendPub ‖ inviteSecret)[0:4]`.
- **Link:** `ghostlink://amigo/<código>` abre o app em "Adicionar amigo" com o código preenchido. Nunca adiciona sozinho.
- **Nome mostrado:** o apelido global da pessoa, enviado no `hello` de cada conexão. O app guarda o último apelido visto e permite um apelido local por amigo.
- **Isolamento:** a chave privada de amigo fica só no processo principal (ou no processo do motor P2P, §3.1). O renderer nunca a recebe.
- **Strings congeladas:** `ghostlink/friend/v1`, `ghostlink/friendcode/v1`, `ghostlink/inbox/v1`, `ghostlink/dm/v1`, `ghostlink/entry/v1`, `ghostlink/offer/v1` entram em `CRYPTO_LABELS` (spec principal §3.6).

## 3. Rede P2P

### 3.1 Motor

- Um motor P2P no app, fora do renderer, com uma instância de Hyperswarm cuja chave é a chave de amigo.
- **Onde roda:** no processo principal. Se a fase 0 mostrar problema com os módulos nativos no processo principal, roda num `utilityProcess` (como o servidor hospedado), que recebe só a chave de amigo, nunca a semente-mestra.
- **Bootstrap:** os nós públicos padrão do Hyperswarm. Em desenvolvimento e nos testes, `GHOSTLINK_DHT_BOOTSTRAP` aponta para uma rede local (`hyperdht/testnet`).
- **Ligado só com identidade:** sem identidade utilizável o motor não sobe. Em "Configurações → Amigos" há um interruptor "Ficar disponível para amigos" (padrão: ligado); desligado, o motor não anuncia nem conecta.

### 3.2 Quem conecta com quem

- **Amigos e colegas de grupo:** o app chama `joinPeer(chave)` para cada amigo aceito e para cada membro de um grupo em comum. O servidor do Hyperswarm escuta na chave de amigo.
- **Firewall:** conexões de entrada só passam se a chave remota é de um amigo aceito, de um colega de grupo ou de alguém a quem você enviou um pedido (para a confirmação conseguir entrar), e não está bloqueada. O resto é recusado antes de a conexão abrir, então desconhecidos não descobrem o IP por esse caminho.
- **Caixa de pedidos (inbox):** para receber pedidos por código, o app escuta também numa segunda chave, `inboxKey = Ed25519(SHA-256("ghostlink/inbox/v1" ‖ friendPub ‖ inviteSecret))`. Só quem tem o código completo consegue derivar essa chave e conectar.
  - Quem conecta na inbox só pode enviar um `friend.request` (até 1 KiB) e a conexão fecha.
  - Como quem tem o código também conhece a chave privada da inbox, o dono **prova que é ele**: a primeira mensagem do dono é `inbox.hello` com a assinatura, pela chave de amigo, do hash do handshake dessa conexão. O solicitante confere antes de enviar o pedido.
  - Limites: 8 conexões simultâneas de desconhecidos e 30 por hora; acima disso, recusa.
  - "Desligar pedidos por código" para de escutar na inbox.

### 3.3 Protocolo entre amigos

Sobre a conexão criptografada do Hyperswarm (Noise, autenticada pelas chaves de amigo):

- **Quadros:** 1 byte de tipo + tamanho (uint32 BE) + corpo. Tipo `1` = JSON (até 256 KiB), tipo `2` = pedaço de arquivo (§6).
- **Validação:** todo JSON passa por esquema zod estrito antes de ser usado. Quadro inválido ou grande demais derruba a conexão.
- **Mensagens JSON (`t`):**

| `t` | Conteúdo | Uso |
|---|---|---|
| `hello` | `v`, `nickname` | Primeira mensagem de cada lado. Versão do protocolo P2P = 1. |
| `friend.accept` | — | Confirma a amizade depois de um pedido aceito. |
| `friend.remove` | — | Avisa que a amizade acabou (o outro lado tira da lista). |
| `sync.have` | conversas em comum e, por autor, o último `seq` | Troca inicial e periódica (§4.3). |
| `sync.want` | `conv`, `author`, `from`, `to` | Pede entradas que faltam. |
| `entry` | uma entrada assinada (§4.2) | Entrega ao vivo e resposta a `sync.want`. |
| `typing` | `conv` | "Digitando…", no máximo 1 a cada 3 s. |
| `file.want` / `file.meta` / `file.end` / `file.missing` | `hash`, `offset` | Transferência de arquivos (§6). |
| `call.invite` / `call.join` / `call.leave` / `call.decline` / `call.signal` | `conv`, `callId`, SDP ou candidato | Chamadas (§7). |
| `ping` / `pong` | — | Presença e detecção de queda (a cada 20 s). |

- **Presença:** "online" é ter uma conexão aberta com o amigo. Sem conexão, o amigo aparece offline.

### 3.4 Limites

| Item | Limite |
|---|---|
| Amigos | 500 |
| Pedidos pendentes recebidos | 100 (os mais antigos saem) |
| Membros por grupo | 10 |
| Participantes numa chamada | 8 |
| Texto de uma mensagem | 4000 caracteres (igual aos canais) |
| Anexos por mensagem | 10 |
| Tamanho de um arquivo | 100 MB |
| Entrada assinada | 64 KiB |
| Entradas por `sync.want` | 500 |

## 4. Conversas

### 4.1 Identidade da conversa

- **DM 1:1:** `conv = hex(SHA-256("ghostlink/dm/v1" ‖ menorChave ‖ maiorChave)[0:16])`. As duas pontas calculam o mesmo valor.
- **Grupo:** 16 bytes aleatórios escolhidos por quem cria, em hexadecimal.

### 4.2 Entradas assinadas

Cada pessoa mantém, por conversa, um registro só de acréscimo com as próprias entradas:

```
entry = { conv, author (chave de amigo, b64url), seq (1, 2, 3…), ts (ms), kind, body (string JSON), sig }
sig   = Ed25519(author, "ghostlink/entry/v1\n" ‖ conv ‖ "\n" ‖ seq ‖ "\n" ‖ ts ‖ "\n" ‖ kind ‖ "\n" ‖ SHA-256(body))
```

- A assinatura cobre os bytes exatos de `body`, então outro membro pode repassar a entrada sem poder alterá-la.
- Uma entrada só é aceita se a assinatura confere, se o autor é membro da conversa naquele momento e se `seq` é o próximo daquele autor (sem buracos).

| `kind` | `body` | Regra |
|---|---|---|
| `msg` | `id`, `text`, `replyTo?`, `attachments[]` | Mensagem nova. |
| `edit` | `id`, `text` | Só o autor da mensagem. |
| `delete` | `id` | Só o autor da mensagem. |
| `group.create` | `name`, `members[]` | Primeira entrada de quem cria o grupo. |
| `group.add` | `member` | Qualquer membro pode adicionar um amigo seu, até o limite. |
| `group.remove` | `member` | Só quem criou o grupo. |
| `group.leave` | — | A própria pessoa. |
| `group.rename` | `name` | Qualquer membro. |

- **Membros de um grupo:** `members` do `group.create`, mais os `group.add`, menos os `group.remove` e `group.leave`. Entradas de quem saiu ou foi removido, com `ts` depois da saída, são recusadas.
- **Relógio:** a ordem na tela é por `ts`, com desempate por autor e `seq`. Um `ts` mais de 5 min no futuro é recusado.

### 4.3 Sincronização

1. Ao conectar, cada lado manda `sync.have` com as conversas que tem em comum com aquele par e o último `seq` de cada autor.
2. Cada lado pede com `sync.want` o que falta e recebe `entry` em ordem de `seq`.
3. Entrada nova local é enviada na hora a todos os membros conectados.
4. Em grupo, as entradas de **qualquer** autor podem vir de **qualquer** membro, então a mensagem de alguém offline chega por quem já a tem.

- **Estado de entrega (só em 1:1):** "enviada" quando está gravada no PC de quem escreveu, "entregue" quando o `sync.have` do amigo já cobre aquele `seq`.
- **Pessoa nova num grupo** recebe o histórico inteiro do grupo pelos outros membros.

### 4.4 Banco local

`<userData>/friends.db`, com `node:sqlite` em modo WAL e migrações numeradas, no processo do motor.

| Tabela | Conteúdo |
|---|---|
| `me` | `invite_secret`, `inbox_enabled`, `available` |
| `friends` | chave, último apelido, apelido local, estado (`pending_out`, `pending_in`, `friend`, `blocked`), datas, `offer_id` |
| `conversations` | id, tipo, nome, criada em, lida até (`ts`) |
| `members` | conversa, chave, entrou em, saiu em |
| `entries` | conversa, autor, seq, ts, kind, body, sig — chave primária (conversa, autor, seq) |
| `messages` | visão materializada: id, conversa, autor, ts, texto, resposta a, editada em, apagada |
| `attachments` | mensagem, ordem, hash, nome, tamanho, tipo, largura, altura, miniatura |
| `files` | hash, tamanho, completo, recebido até |

Apagar uma conversa na interface apaga as linhas locais e os arquivos que só ela usava. Não apaga nada no PC dos outros.

## 5. Amigos

### 5.1 Pedido por código

1. Ana cola o código do Bruno. O app confere o checksum, recusa o próprio código e cria o amigo em `pending_out`.
2. O app conecta na inbox do Bruno (§3.2), confere o `inbox.hello` e envia `friend.request { nickname, offerId? }`. Se o Bruno está offline, tenta de novo com espera crescente (até 10 min entre tentativas) enquanto o pedido existir.
3. O Bruno vê o pedido em **Pendentes**, com o apelido da Ana e os 8 primeiros caracteres do código dela (para conferir por fora que é ela mesma). Aceitar cria a amizade; recusar apaga; bloquear guarda a chave como bloqueada.
4. Ao aceitar, o app do Bruno passa a conectar na Ana (`joinPeer`) e envia `friend.accept`. O firewall da Ana já aceita a chave do Bruno desde o envio do pedido (§3.2).
5. **Pedidos cruzados viram amizade:** se os dois pediram um ao outro, ninguém precisa aceitar.

### 5.2 Pedido por um servidor em comum

Para quem está no mesmo servidor GhostLink e não quer trocar códigos por fora.

- **No servidor (protocolo §5 da spec principal, só acréscimos):**
  - `member.key { userId }` → `{ publicKey }`. O cliente confere que `hex(SHA-256(publicKey))[0:32] == userId`.
  - `friend.offer { toUserId, box }` (`box` em base64, até 1 KiB). O servidor repassa como evento `friend.offer { fromUserId, box }`. Se o destino está offline, guarda (até 20 por destinatário, por 7 dias) e entrega no próximo login.
  - Limite: 5 por minuto e 30 por hora por pessoa. Qualquer membro pode usar.
  - O `welcome` anuncia `features: ["friendOffers"]`. Em servidor antigo o botão não aparece.
- **No app:**
  - "Adicionar amigo" no menu do membro monta `{ code, nickname, offerId, sig }`, em que `offerId` são 16 bytes aleatórios e `sig` é a assinatura, pela chave **daquele servidor**, de `"ghostlink/offer/v1\n" ‖ toUserId ‖ "\n" ‖ code ‖ "\n" ‖ offerId`.
  - O pacote é cifrado para o destinatário (caixa selada, X25519 convertida da chave Ed25519 do membro). **O dono do servidor não lê o código.**
  - O destinatário confere a assinatura com a chave do remetente naquele servidor e vê "Fulano (do servidor X) quer ser seu amigo". Aceitar faz o app dele adicionar o código recebido, enviando o `offerId` no `friend.request`.
  - O app de quem enviou aceita sozinho um pedido que traz um `offerId` que ele emitiu (uso único, vale 7 dias).

### 5.3 Remover e bloquear

- **Remover:** envia `friend.remove` se houver conexão, para de conectar e tira a chave do firewall. A conversa 1:1 fica no histórico, só leitura.
- **Bloquear:** como remover, e pedidos futuros daquela chave são descartados sem aviso. A lista de bloqueados permite desbloquear.
- Num grupo, uma pessoa bloqueada continua visível (o grupo precisa da conexão); a interface avisa.

## 6. Imagens e arquivos

- **Anexar:** o app copia o arquivo para `<userData>/friend-files/<sha256>`, calcula o hash e coloca no `msg` os metadados: `hash`, `name`, `size`, `mime`, e para imagens `width`, `height` e uma miniatura de até 16 KiB.
- **Baixar:** `file.want { hash, offset }` para um membro conectado que tenha o arquivo (primeiro o autor). A resposta vem em pedaços de 64 KiB (quadro tipo `2`: id da transferência, deslocamento, dados), com controle de fluxo, e termina em `file.end`. Quem não tem responde `file.missing`.
  - Imagens de até 10 MB baixam sozinhas. O resto baixa com um clique e mostra progresso.
  - A transferência retoma de onde parou e o hash é conferido no fim; se não bate, o arquivo é apagado.
- **Quem pode pedir:** só membros de uma conversa que tenha uma mensagem com aquele hash.
- **Segurança ao mostrar e abrir:**
  - Só PNG, JPEG, GIF e WebP aparecem na conversa, servidos pelo protocolo `app://` com o tipo fixo. SVG e HTML nunca são renderizados.
  - O nome do arquivo é saneado. "Abrir" e "Mostrar na pasta" seguem as mesmas regras e confirmações dos arquivos de canais (spec principal §12).

## 7. Chamadas de voz

- **Mídia:** só áudio, WebRTC (`RTCPeerConnection`) no renderer, uma conexão por par de participantes (malha). DTLS-SRTP entre os dois.
- **Sinalização:** pelos quadros `call.*` da conexão P2P, que já é autenticada pelas chaves de amigo. Assim as impressões digitais do SDP não podem ser trocadas por terceiros.
- **Fluxo:**
  1. Quem liga envia `call.invite { conv, callId }` a todos os membros conectados. Eles veem a tela de chamada recebida, com toque, **Aceitar** e **Recusar**. Sem resposta em 45 s, a chamada aparece como perdida.
  2. Quem aceita envia `call.join`. Para cada par, quem tem a **menor chave** faz a oferta; o resto segue por `call.signal`.
  3. `call.leave` sai. A chamada acaba quando sobra uma pessoa.
  4. Em grupo, quem chega depois pode entrar enquanto a chamada existir (botão "Entrar na chamada" na conversa).
- **ICE:** `iceServers` vem das configurações. Padrão: `stun:stun.l.google.com:19302` e `stun:stun.cloudflare.com:3478`. Sem TURN: em redes muito fechadas a chamada não conecta e a interface diz isso.
- **Reuso:** dispositivos de entrada e saída, limiar do microfone, aperte-para-falar, mudo, surdo e indicador de quem fala são os mesmos da voz em servidores. Entrar numa chamada de DM sai de um canal de voz de servidor, e vice-versa.
- **Registro:** o começo e o fim de uma chamada viram linhas de sistema na conversa (só local, não são entradas assinadas).

## 8. Interface

Referência: o print do Discord enviado pelo dono em 2026-09-29. Cores e medidas já estão nos tokens.

- **Lateral da Home:**
  - botão de busca ("Encontre ou comece uma conversa"), que filtra amigos e conversas;
  - item **Amigos** (com contador de pedidos pendentes);
  - seção **Mensagens diretas** com **+** (nova DM ou grupo: escolher amigos numa lista com busca);
  - cada conversa com avatar, bolinha de presença, nome e contador de não lidas; fechar (×) esconde a conversa sem apagar.
- **Centro, em "Amigos":**
  - barra superior: **Amigos · Online · Todos · Pendentes · Bloqueados** e o botão azul **Adicionar amigo**;
  - **Adicionar amigo**: campo para colar o código, e abaixo "Seu código" com copiar, copiar link e "Gerar código novo";
  - busca e linhas como no Discord: avatar, nome, estado, botões redondos (mensagem, mais opções: ligar, remover, bloquear, apelido local);
  - **Pendentes**: recebidos (aceitar, recusar, bloquear) e enviados (cancelar).
- **Centro, numa conversa:** cabeçalho com nome, presença, botão de ligar e, em grupo, lista de membros e "Adicionar pessoas". Corpo: a lista de mensagens e o compositor dos canais (mesmo markdown seguro, responder, editar, apagar), mais o botão de anexar e arrastar-e-soltar.
- **Direita ("Ativo agora"):** amigos que estão numa chamada de DM em que você pode entrar, e o servidor hospedado neste computador.
- **Servidores:** continuam na barra da esquerda. A lista central de servidores da v0.2 sai da Home.
- **Em servidores:** o menu de um membro ganha "Adicionar amigo" (§5.2) e, se já é amigo, "Enviar mensagem".
- **Notificações:** mensagem nova em conversa que não está aberta, pedido de amizade e chamada recebida geram notificação do sistema (respeitando a configuração existente) e som.
- **Painel do usuário:** fora de um servidor, mostra "Online" quando o motor P2P está no ar e "Invisível para amigos" quando desligado.
- **Textos:** pt-BR e en para tudo, com paridade checada no typecheck.

## 9. Arquitetura no código

| Parte | Onde | Responsabilidade |
|---|---|---|
| Rótulos e formatos | `packages/shared/src/friends.ts` | Código de amigo (codificar, validar), ids de conversa, bytes assinados, esquemas zod do protocolo P2P e das entradas, limites. Sem dependência nativa. |
| Motor P2P | `apps/desktop/src/main/p2p/**` | `swarm.ts` (Hyperswarm, firewall, inbox), `codec.ts` (quadros), `session.ts` (uma conexão), `store.ts` (SQLite), `sync.ts`, `friends.ts`, `files.ts`, `calls.ts` (sinalização), `engine.ts` (fachada). Cada arquivo com um propósito e testável sozinho. |
| IPC | `apps/desktop/src/main/friendsIpc.ts`, `shared/friendsTypes.ts` | Canais `friends.*`, `dm.*`, `dmFiles.*`, `calls.*` e eventos, com esquemas zod estritos como nos outros canais. |
| Interface | `renderer/features/friends/**`, `features/dm/**`, `features/calls/**`, `stores/friends.ts` | Telas da §8. Reaproveita os componentes de mensagem e o compositor do chat onde eles não dependem do servidor. |
| Servidor | `apps/server/src/friends/**` (módulo `friends`) | `member.key`, `friend.offer`, fila de ofertas, limites. |

O renderer nunca fala com a rede P2P: pede ao processo principal por IPC e recebe eventos.

## 10. Erros

Códigos novos em `CLIENT_ERROR_CODES`, com mensagem nos dois idiomas:

| Código | Quando |
|---|---|
| `FRIEND_CODE_INVALID` | Código malformado ou checksum errado. |
| `FRIEND_SELF` | A pessoa colou o próprio código. |
| `FRIEND_LIMIT` | Passou de 500 amigos ou do limite do grupo. |
| `FRIEND_UNREACHABLE` | Não foi possível abrir conexão direta com a pessoa. |
| `P2P_UNAVAILABLE` | O motor P2P não subiu (sem identidade, sem rede, módulo nativo falhou). |
| `FILE_TOO_LARGE` | Arquivo acima de 100 MB. |
| `FILE_UNAVAILABLE` | Ninguém online tem o arquivo. |
| `CALL_FULL` | A chamada já tem 8 pessoas. |
| `CALL_FAILED` | A conexão de voz não abriu. |

Falha de rede nunca apaga dados: pedidos e mensagens pendentes ficam na fila e a interface mostra o estado.

## 11. Testes

- **Unidade:** código de amigo, ids, assinatura e validação de entradas, regras de membros de grupo, codec de quadros, armazenamento, sincronização (com pares falsos), limites.
- **Integração:** dois e três motores no mesmo processo sobre `hyperdht/testnet`: pedido por código, pedidos cruzados, amigo offline e entrega depois, grupo com entrega por terceiro, arquivo com retomada, firewall recusando desconhecido, inbox com limite, código novo invalidando o antigo.
- **Servidor:** `member.key` e `friend.offer` com esquema estrito, limites, fila offline e o caminho proibido.
- **e2e (Playwright `_electron`):** dois apps com `GHOSTLINK_DHT_BOOTSTRAP` local: adicionar por código, conversar, enviar imagem, criar grupo com um terceiro app, ligar e ouvir áudio dos dois lados (dispositivos falsos, sem STUN, em loopback).
- **Segurança:** conexão de chave desconhecida nunca chega a uma sessão de amigo; entrada com assinatura errada, de não membro ou com buraco de `seq` é recusada; quadro gigante derruba a conexão; SVG e HTML não renderizam.

## 12. Fases

Cada fase tem plano próprio, termina com `lint`, `typecheck` e testes verdes, e é utilizável sozinha.

| Fase | Entrega |
|---|---|
| 0 | **Prova técnica:** Hyperswarm no Electron (processo principal ou `utilityProcess`) no Windows, empacotado com as fuses atuais; dois apps se conectam por `joinPeer` numa rede de teste local e pela DHT pública. Decide onde o motor roda. |
| 1 | Identidade de amigo, código, motor, firewall, inbox, pedidos por código, presença, e a Home de Amigos (Online, Todos, Pendentes, Bloqueados, Adicionar amigo). |
| 2 | DM 1:1 de texto: entradas assinadas, sincronização, fila offline, editar, apagar, responder, não lidas, notificações. |
| 3 | Imagens e arquivos. |
| 4 | Grupos. |
| 5 | Chamadas de voz 1:1 e em grupo. |
| 6 | "Adicionar amigo" por servidor (módulo do servidor e menu do membro), textos de privacidade no site e no README, e2e completo, release v0.3.0. |

## 13. Riscos

| Risco | Mitigação |
|---|---|
| Módulos nativos do Hyperswarm não carregam no Electron empacotado | Fase 0 antes de tudo; alternativa com `utilityProcess`. |
| Conexão direta não abre em redes com NAT fechado dos dois lados | Mensagem clara na interface; relay fica para uma versão futura. |
| A DHT pública e o STUN são infraestrutura de terceiros | Só bootstrap e descoberta de endereço; o conteúdo é ponta a ponta. Bootstrap e STUN são configuráveis. |
| Relógios errados bagunçam a ordem | Ordem por `ts` com desempate estável; recusa de `ts` muito no futuro. |
| Abuso por quem tem o código | Inbox com limites, código novo, bloqueio, desligar pedidos por código. |
| Banco local cresce | Arquivos e conversas podem ser apagados pela interface; limite de 100 MB por arquivo. |
