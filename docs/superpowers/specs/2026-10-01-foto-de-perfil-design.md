# GhostLink — Foto de perfil

Desenho aprovado pelo dono em 2026-10-01. Detalha e muda a parte de avatares da spec principal ([`2026-09-27-ghostlink-design.md`](2026-09-27-ghostlink-design.md) §5.2 `upload.begin`/`profile.update`, §7 arquivos, rotas `/upload` e `/avatars`). Onde este documento não diz nada, vale a spec principal.

## 1. Decisões

| Tema | Decisão |
|---|---|
| Alcance | **Uma foto para tudo**, como no Discord: escolhida uma vez no app, aparece em todos os servidores e para os amigos. Muda a spec principal, que previa uma foto por servidor. |
| Onde se escolhe | Configurações do usuário → **Perfil**. A aba passa a existir também na Home (hoje ela some fora de um servidor). |
| Enquadramento | Modal com a imagem num círculo: **arrastar e zoom**, como no Discord. |
| Formatos | PNG, JPEG, WebP e GIF na entrada (até 10 MB). **GIF animado é aceito** e continua animado. |
| Saída | Imagem parada → WebP 256×256. Animada (GIF ou WebP animado) → GIF 256×256. No máximo **2 MB** (o limite de avatar da spec principal). |
| Servidores | A imagem viaja por HTTPS, separada das mensagens: `POST /upload` e `GET /avatars/<hash>` com URL assinada (spec principal §7), só a parte de avatar. |
| Amigos | Transferência P2P "arquivo por hash", em pedaços, pela conexão entre amigos. A fase 3 (arquivos na DM) reaproveita a mesma peça. |
| Sem foto | Iniciais do nome num círculo, em todo lugar (substitui o boneco cinza). |
| Animação | GIFs animam sempre. |
| Lançamento | Fotos nos servidores na **v0.2.2**, junto com a transmissão de tela (branch `v0.2-avatar`, a partir da `main`). Fotos para amigos na **v0.3**, na branch `v0.3-friends`. |

**Fora:** foto diferente por servidor, banner, cor de perfil, "sobre mim", ícone do servidor e anexos em canais (continuam no marco de arquivos da spec principal).

## 2. Escolher e recortar (renderer)

**Aba Perfil.**
- No topo, a foto atual (80 px) com **Alterar foto** e, se houver foto, **Remover foto**.
- Abaixo, como hoje, o apelido daquele servidor (só dentro de um servidor).

**Escolha do arquivo.**
- `<input type="file" accept="image/png,image/jpeg,image/webp,image/gif">`.
- Acima de 10 MB, ou um arquivo que não decodifica, mostra "Não deu para abrir essa imagem." sem abrir o modal.

**Modal de recorte.**
- A imagem ocupa um quadro de 320×320 com uma máscara circular. Arrastar move a imagem; a barra de **zoom** vai de 1× (a imagem cobre o círculo) a 5×.
- O recorte nunca deixa área vazia dentro do círculo: a posição é limitada às bordas da imagem.
- Imagens animadas tocam no modal.
- **Aplicar** e **Cancelar**.

**Codificação, toda no renderer.**
- O recorte é um quadrado `{ x, y, lado }` em pixels da imagem original, calculado por uma função pura a partir do zoom e do deslocamento.
- **Parada:** desenha o recorte num `OffscreenCanvas` de 256×256 e grava `image/webp` com qualidade 0,9.
- **Animada:**
  - decodifica com `ImageDecoder` (WebCodecs), quadro a quadro, com a duração de cada um;
  - desenha cada recorte em 256×256;
  - grava um GIF com `gifenc` (MIT), com paleta por quadro;
  - no máximo 300 quadros; o resto é cortado;
  - se o resultado passar de 2 MB, o modal avisa "GIF grande demais. Tente um mais curto ou com menos cores." e não aplica.
- Uma imagem com um só quadro segue o caminho da parada, mesmo que seja GIF.

## 3. No app (main)

**A sua foto.**
- Fica em `<userData>/profile/avatar.webp` ou `avatar.gif`, com o hash (SHA-256 em hex) e o tipo em `profile/avatar.json`.
- IPC novo, com schemas zod estritos:
  - `profile.avatar()` → `{ hash, mime } | null`;
  - `profile.setAvatar(bytes: Uint8Array)` → `{ hash, mime }`;
  - `profile.clearAvatar()` → `null`.
- O main confere tudo de novo antes de gravar: tipo pelos bytes mágicos (só WebP e GIF), 256×256 no cabeçalho, até 2 MB. Senão `BAD_REQUEST`.
- O renderer nunca recebe caminhos de arquivo.

**Cache das fotos dos outros.**
- `<userData>/avatars/<hash>`, até **100 MB**. Acima disso, apaga as menos usadas.
- Nada entra no cache sem que o SHA-256 dos bytes bata com o hash pedido.

**Mostrar na tela.**
- O renderer usa `<img src="app://ghostlink/_avatar/<hash>">`. O handler do protocolo `app://` (que já serve o app) atende esse caminho:
  - o hash precisa ser 64 caracteres hex;
  - se está no cache (ou é a sua foto), responde com o `Content-Type` certo e `nosniff`;
  - se não está, pede ao **servidor conectado** (§4) ou, na v0.3, ao **amigo** dono dela (§5), confere o hash, guarda e responde;
  - se não conseguir, `404`, e o componente mostra as iniciais.
- A CSP não muda: o `img-src 'self' https: blob: data:` atual já cobre `app://ghostlink`.
- Em desenvolvimento a página vem do servidor do Vite, não do `app://`. O primeiro passo do plano confere se a imagem do `app://ghostlink/_avatar/…` carrega ali também.

## 4. Servidores

**Anúncio.** O servidor novo põe `avatars` em `features`. Um app novo num servidor antigo não envia nada e mostra iniciais. Um app antigo num servidor novo ignora o campo novo (os schemas do cliente descartam chaves desconhecidas).

**Membro.** `Member` ganha `avatar: string | null` (o hash). O servidor guarda o hash em `users.avatar_file_id` (a coluna já existe) e o arquivo em `<dataDir>/avatars/<hash>.webp` ou `.gif`.

**Enviar.**
1. Ao receber `welcome` com `avatars`, e sempre que a pessoa troca a foto, o main compara o `avatar` do próprio membro com a foto local.
2. Se forem diferentes:
   - **com foto:** `upload.begin { purpose: 'avatar', size, sha256 }` → `{ uploadToken }` (uso único, 60 s), depois `POST /upload?u=<uploadToken>` com os bytes;
   - **sem foto:** `avatar.clear {}`.
3. O `POST` confere, nesta ordem:
   - o corpo é cortado assim que passa do `size` declarado;
   - o SHA-256 bate com o declarado;
   - o tipo pelos bytes mágicos (WebP, GIF, PNG, JPEG);
   - as dimensões no cabeçalho (de 16 a 512 px por lado);
   - até 2 MB.
4. Deu certo: grava o arquivo, troca o hash do usuário, responde `{ avatar: <hash> }` e manda `member.updated` para todos. O `POST` de avatar já aplica a foto; não há `profile.update` separado (diferença da spec principal, que fica para os anexos).
5. Erros: `BAD_REQUEST` (tipo, tamanho, dimensões, hash), `RATE_LIMITED` (no máximo 5 trocas por minuto por pessoa).

**Baixar.**
- `GET /avatars/<hash>?sid=<sessionId>&e=<exp>&s=<assinatura>`, com a assinatura da spec principal §7 e o alvo `avatar:<hash>`.
- Vale para qualquer sessão ativa do servidor. Responde com `Content-Type` certo, `nosniff` e `Cache-Control: private, max-age=86400` (o conteúdo nunca muda para o mesmo hash).
- Quem baixa é o main, com o certificado fixado da conexão atual. O renderer não ganha pins novos.

**Limpeza.** Quando nenhum usuário aponta mais para um hash (trocou a foto, saiu, foi expulso ou banido), o arquivo é apagado. A expulsão já limpa `avatar_file_id`.

## 5. Amigos (v0.3)

- O `hello` da conexão entre amigos passa a levar `avatar: <hash> | null`, e uma troca de foto manda um quadro `profile` com o hash novo.
- Quem não tem aquela foto no cache pede `blob.want { hash }` e recebe `blob.part { hash, index, total, data }` em pedaços de 32 KB, até 2 MB.
- O lado que pede confere o SHA-256 no fim e só guarda se bater. Só se aceita `blob.want` de amigos, só para hashes que você mesmo anunciou, com no máximo 2 transferências simultâneas por link.
- A fase 3 (arquivos na DM) usa os mesmos quadros, com outros limites.

## 6. Onde a foto aparece

Um único `Avatar` (`{ hash, name, size, online }`): mostra a imagem quando há hash e as iniciais quando não há, ou quando a imagem falha.
- **Servidores:** lista de membros, mensagens (cabeçalho do grupo), participantes do canal de voz, palco de voz, painel do usuário e o modal de perfil/menu do membro.
- **Home:** painel do usuário, linhas de amigos, conversas da barra lateral e mensagens diretas (estas na v0.3).

## 7. Segurança

- Os bytes chegam de outras pessoas. O main confere tipo, dimensões, tamanho e hash antes de guardar; a decodificação acontece só no renderer, que é isolado.
- URLs de avatar são assinadas e expiram (spec principal §7); o `fileToken` nunca sai do main.
- Nada de URL, hash ou bytes de foto nos logs.

## 8. Testes

- **Unitários:**
  - recorte (zoom, limites, arredondamento);
  - detecção de tipo e dimensões pelos bytes (WebP, GIF, PNG, JPEG, truncados, mentirosos);
  - assinatura da URL;
  - cache (hash errado recusado, limite de 100 MB);
  - IPC (schemas).
- **Servidor:** `upload.begin` → `POST /upload` → `member.updated`, com hash errado, tipo errado, grande demais, token reusado e vencido; `GET /avatars` sem assinatura, vencida e válida; limpeza do arquivo órfão.
- **e2e:** Ana coloca uma foto (uma imagem PNG de teste) e Bia vê a foto na lista de membros e nas mensagens; Ana remove e Bia volta a ver as iniciais.
- **Amigos (v0.3):** a transferência por hash na DHT de teste, com um pedaço adulterado sendo recusado.

## 9. Checklist manual

- Um GIF animado grande (perto de 2 MB) é aceito e anima para os outros.
- Um GIF grande demais mostra o aviso.
- O recorte com zoom máximo não deixa borda vazia.
- A foto aparece num servidor no Railway (modo proxy).
