# GhostLink — Ghost DJ, o bot de música padrão

Aprovado pelo dono em 2026-10-02 ("quero adicionar um bot padrão em todos os servidores, que é Ghost DJ; vai ser a mesma arquitetura do Flavibot do Discord"). Escolhas: **YouTube (link e busca)**, **dentro de cada servidor**, **só música** na primeira versão. Sai na **v0.5.0**.

## 1. Como aparece

- Todo servidor com a função já tem o membro **Ghost DJ** (etiqueta BOT), criado pelo próprio servidor, sem código de conexão. Ele não pode ser excluído nem ter o código regenerado (o menu do bot não mostra essas ações para ele); cargos funcionam como em qualquer membro.
- Comandos de barra, no `/` do chat como os de qualquer bot:

| Comando | O que faz |
|---|---|
| `/play busca` | toca ou põe na fila; `busca` é um nome (busca no YouTube, primeiro resultado) ou um link do YouTube (vídeo ou playlist, até 50 itens). O DJ entra no canal de voz de quem pediu. |
| `/pause`, `/resume` | pausa e retoma |
| `/skip` | pula para a próxima |
| `/stop` | para, limpa a fila e sai do canal |
| `/queue` | mostra a fila (resposta só para quem pediu) |
| `/nowplaying` | mostra o que está tocando |
| `/volume nivel` | 0 a 100 (começa em 50) |
| `/loop modo` | `musica`, `fila` ou `desligado` |

- **Painel "Tocando agora"**: uma mensagem do Ghost DJ no canal de texto onde o primeiro `/play` foi dado, com título, duração, quem pediu e as próximas 3; editada a cada mudança (não uma mensagem nova por música).
- **Quem manda**: quem está no mesmo canal de voz que o DJ. Com o DJ parado, qualquer pessoa que possa entrar no canal de voz em que está (precisa estar num canal de voz para `/play`). Erros (não está em voz, link inválido, vídeo indisponível) respondem só para quem pediu.
- Ele sai sozinho depois de 5 min sem tocar ou quando fica sozinho no canal. Um DJ por servidor (um canal de voz por vez); `/play` de outro canal com o DJ ocupado responde "O Ghost DJ está tocando em #canal".

## 2. Por dentro do servidor

- **Membro de sistema**: na primeira vez que o servidor sobe com a função, cria o membro bot `Ghost DJ` (marcado como de sistema) e registra os comandos. As interações dele não vão por WebSocket: o módulo trata `interaction.invoke` para o DJ dentro do processo (mesmo prazo de 3 s: responde `defer` e depois edita).
- **Áudio**: `yt-dlp` resolve a busca/link e a melhor fonte de áudio; `ffmpeg` decodifica para PCM 48 kHz estéreo; o DJ entra na sala do LiveKit do próprio servidor como participante (token emitido pelo servidor, só publicar áudio) e publica com `@livekit/rtc-node` (AudioSource). Volume aplicado no PCM. Uma faixa por vez; a próxima começa sem silêncio longo.
- **yt-dlp**: o servidor baixa o binário oficial (`yt-dlp_linux` / `yt-dlp_linux_aarch64`) das releases do GitHub, confere o SHA-256 do `SHA2-256SUMS` da mesma release e o guarda em `data/ghost-dj/`; procura versão nova uma vez por dia (sem interromper o que toca). **ffmpeg** vem na imagem Docker; o `install.sh` da VPS instala pelo `apt`.
- **Bloqueio do YouTube** ("Sign in to confirm you're not a bot", comum em IPs de nuvem): o dono do servidor pode colocar um arquivo de cookies do YouTube (formato Netscape) em `data/ghost-dj/cookies.txt`; o DJ passa para o `yt-dlp` quando existe. Sem cookies e bloqueado, o `/play` responde com essa explicação.
- **Função**: o servidor anuncia `ghostDj` só quando tem `ffmpeg` e LiveKit; servidores hospedados pelo app no Windows não têm a função nesta versão.

## 3. App

- O Ghost DJ aparece na seção BOTS e na lista de membros como qualquer bot, com a foto padrão do DJ. O menu do bot esconde "Gerar novo código" e "Excluir bot" para ele; as Configurações mostram "Bot do sistema".
- Sem tela nova: os comandos usam o `/` que já existe e o painel é uma mensagem do bot.

## 4. Fora desta versão

Filtros de áudio, letras, playlists salvas, Spotify, SoundCloud, arquivos enviados, mais de um canal por vez, servidores hospedados pelo app no Windows.

## 5. Testes (enxutos)

- Fila e comandos (play, skip, loop, volume, stop, quem pode mandar, saída por inatividade) com uma fonte de áudio falsa.
- yt-dlp: download com checksum certo e errado (servidor HTTP falso), uso dos cookies quando o arquivo existe.
- Um teste com o LiveKit de verdade: o DJ publica e um participante recebe áudio.
- O YouTube real não entra no CI.
