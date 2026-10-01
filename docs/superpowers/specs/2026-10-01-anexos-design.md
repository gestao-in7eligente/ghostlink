# GhostLink — Anexos (imagens e documentos)

Desenho aprovado pelo dono em 2026-10-01 ("Adicione também a função para enviar imagens e documentos"; "Os dois juntos": canais dos servidores **e** mensagens diretas). Detalha a spec principal §7 (arquivos) e a spec de amigos §4 (DM), fase 3.

## 1. Experiência (igual nos canais e nas DMs)

- **Enviar:** o **+** da caixa de mensagem abre o seletor de arquivos; também **arrastar e soltar** no chat e **Ctrl+V** de uma imagem. Até **10 arquivos** por mensagem. Antes de enviar, uma bandeja mostra cada arquivo (miniatura para imagem, ícone e nome para os outros), com **×** para tirar. O texto é opcional quando há anexo.
- **Enviando:** a mensagem aparece na hora com uma barra de progresso por arquivo; erro mostra "Tentar de novo".
- **Mostrar:**
  - **imagens** (PNG, JPEG, GIF, WebP): dentro da mensagem, até 400×300 mantendo a proporção; várias formam uma grade; clicar abre a imagem grande (lightbox) com **Baixar**;
  - **vídeo** (MP4, WebM) e **áudio** (MP3, OGG): player nativo dentro da mensagem;
  - **outros** (PDF, ZIP, planilhas…): cartão com ícone, nome, tamanho e **Baixar**.
- **Baixar:** sempre pergunta onde salvar (diálogo do sistema); o app **nunca abre** o arquivo sozinho.
- **Apagar a mensagem** apaga os anexos dela (no servidor; na DM, some para os dois e o arquivo é removido do disco quando ninguém mais referencia).

## 2. Servidores

- **Limites:** por arquivo `upload_limit_mb` (padrão 25) e total `storage_quota_mb` (padrão 10 240), já no banco; o dono ajusta em Configurações do servidor → Visão geral, que também mostra o espaço usado. `QUOTA_EXCEEDED` e `FILE_TOO_LARGE` com textos no app.
- **Permissão:** `ATTACH_FILES` (+ `VIEW_CHANNEL` e `SEND_MESSAGES` no canal).
- **Protocolo:**
  - `upload.begin { purpose: 'attachment', channelId, name, size, sha256 }` → `{ uploadToken, fileId }` (o mesmo mecanismo de token dos avatares: uso único, 60 s; o `POST /upload` do avatar é generalizado);
  - `POST /upload?u=…` → `{ fileId }`; o tipo vem dos bytes (magic bytes: PNG, JPEG, GIF, WebP, MP4, WebM, OGG, MP3, PDF; o resto vira `file`); imagens têm as dimensões lidas do cabeçalho e recusadas acima de 8192 px de lado ou 40 MP (`IMAGE_TOO_LARGE`);
  - `msg.send { …, attachmentIds ≤ 10 }`: só arquivos enviados por quem manda, no mesmo canal, ainda não usados;
  - a mensagem ganha `attachments: [{ id, name, size, kind: 'image'|'video'|'audio'|'file', mime, width?, height? }]`;
  - `GET /files/<fileId>?sid&e&s` com a URL assinada da spec principal §7 (alvo = `fileId`); confere **VIEW_CHANNEL do canal do arquivo naquele momento**; `Range`; `Content-Disposition: attachment` para o que não é imagem/vídeo/áudio; `nosniff`.
- **Limpeza:** arquivo enviado e não usado em 1 h é apagado; apagar a mensagem (ou o canal) apaga os arquivos; a exclusão do servidor já apaga tudo.
- `features` ganha `attachments`.

## 3. Mensagens diretas (P2P)

- O arquivo vai **direto entre os dois computadores**, como as mensagens.
- **Limite:** 25 MB por arquivo; 10 por mensagem.
- **Entrada (entry) `msg`** ganha `attachments: [{ hash (SHA-256), name, size, kind, mime, width?, height? }]` — assinada como o resto.
- **Arquivos:** guardados em `<userData>/friends/files/<hash>` (quem enviou guarda ao enviar; quem recebe, ao baixar).
- **Transferência:** `blob.want { hash }` / `blob.part { hash, index, total, data }` em pedaços de 32 KB pelo link do amigo, só entre amigos e só para hashes que aparecem em entradas daquela conversa; o recebido só é guardado se o SHA-256 bater. Imagens até 5 MB baixam sozinhas quando a mensagem chega; o resto, ao clicar (ou ao abrir a conversa, se couber).
- Sem o amigo online, o anexo mostra "Chega quando {nome} estiver online".

## 4. App (como mostra)

- **Main** serve os anexos ao renderer por `app://ghostlink/_file/<serverId>/<fileId>` (servidores: baixa com o pin e a URL assinada; cache em disco de imagens até 200 MB) e `app://ghostlink/_dmfile/<hash>` (DMs: o arquivo local). O renderer nunca vê caminhos nem o `fileToken`.
- **Upload** do renderer para o main por IPC em `ArrayBuffer` (até o limite), com eventos de progresso; o main faz `upload.begin` + `POST /upload` (servidores) ou guarda e anuncia (DMs).
- **Peças compartilhadas** em `renderer/features/attachments/**`: bandeja do compositor, lista de anexos de uma mensagem (grade de imagens, player, cartão), lightbox, botão Baixar.

## 5. Testes (enxutos)

- Servidor: upload + `msg.send` com anexo, permissão, limite, cota, `GET /files` com e sem `VIEW_CHANNEL`, limpeza.
- DM: transferência por hash na DHT de teste (com um pedaço adulterado recusado).
- e2e: Ana manda uma imagem e um PDF num canal → Bia vê a imagem e baixa o PDF; Ana manda uma imagem na DM → Bia vê.
