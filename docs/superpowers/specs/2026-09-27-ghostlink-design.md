# GhostLink — Especificação de design

- **Data:** 2026-09-27. Esta é a v3, revisada depois de duas rodadas de verificação técnica contra o código-fonte do LiveKit, do Electron, do electron-builder, do electron-updater e das dependências, e de uma crítica de segurança.
- **Status:** design aprovado. A spec está pronta para o plano de implementação.
- **Licença:** GPL-3.0-or-later.
- **Inspiração:** [Monky](https://monkyorg.github.io/Monky/) (GPL-3.0). O GhostLink é escrito do zero. Reaproveita ideias e o formato geral do protocolo, nunca código, nome, logo ou assets.

## 1. Visão geral

GhostLink é um app desktop gratuito e de código aberto para **Windows e macOS**, com chat de texto, voz, câmera e compartilhamento de tela, no estilo do Discord. **Qualquer pessoa pode baixar e hospedar o próprio servidor**, pelo app ou numa VPS. Não existe conta central: a identidade de cada pessoa é uma chave criptográfica guardada no próprio dispositivo.

### 1.1 Objetivo e critérios de sucesso

O GhostLink é um produto público no molde do Monky: releases no GitHub, site de documentação e download, e atualização automática. O MVP está pronto quando:

1. Uma pessoa que nunca ouviu falar do app encontra o site, baixa o instalador (Windows ou macOS), clica em **Hospedar**, gera um convite e o compartilha.
2. Outras pessoas, em outras redes (internet ou VPN tipo Radmin, Tailscale ou ZeroTier), abrem o link do convite, instalam o app se ainda não tiverem e entram. Não criam conta, não configuram certificado e não compram domínio.
3. O grupo conversa por texto: histórico, imagens, arquivos, respostas, reações e menções.
4. **Mais de 12 pessoas** ficam na mesma sala de voz com áudio estável. Algumas ligam a câmera e uma compartilha a tela em 1080p.
5. O dono cria cargos, canais privados e convites, expulsa e bane. Tudo é aplicado pelo servidor, e não só escondido na interface.
6. O mesmo servidor roda sozinho numa VPS Linux, com script de instalação e guia.
7. Todo o tráfego entre app e servidor é criptografado. Na configuração padrão, nem o app nem o servidor falam com terceiros. A única exceção é a checagem de atualização (GitHub Releases), que pode ser desligada.
8. Quando sai uma versão nova, ela chega a todos: no Windows por atualização automática verificada, no macOS por um aviso com link.
9. O app e o site estão em **português e inglês**.

### 1.2 Decisões tomadas

| Tema | Decisão |
|---|---|
| Público | Produto aberto: qualquer pessoa baixa e hospeda |
| Nome | **GhostLink**, mantido mesmo sabendo que o nome já existe em outros apps (§18). As strings criptográficas ficam congeladas (§3.6). |
| Licença | GPL-3.0-or-later |
| Plataformas | Windows x64 (instalador NSIS) e macOS 13+ (arm64 e x64), em Electron. Servidor standalone em Linux (x64 e arm64). |
| Tamanho de call | Mais de 12 pessoas, por isso SFU |
| SFU | LiveKit 1.13.7 (binário separado, Apache-2.0), controlado pelo servidor GhostLink |
| Privacidade | Sem conta; identidade derivada por servidor; TLS com certificado fixado (pin); mídia criptografada em trânsito. **O host consegue ler o texto e a mídia que passam pelo servidor dele.** Não há criptografia ponta a ponta nem telemetria. |
| Hospedagem | Pelo app (Hospedar) e standalone em VPS Linux |
| Recursos do MVP | Chat completo, voz, câmera, tela (só vídeo), arquivos e imagens, cargos, permissões, canais privados, convites e moderação |
| Entrada padrão | Por convite, tanto no Hospedar quanto na VPS. Criar convites é permissão de admins por padrão. |
| Idiomas | pt-BR e en no app e no site. O app detecta o idioma do sistema, e dá para trocar. |
| Distribuição | GitHub Releases gerados no CI; checksums assinados com Sigstore; instaladores assinados com Ed25519 próprio; atualização automática no Windows; site VitePress no GitHub Pages |

### 1.3 Fora do escopo do MVP

- Bots e SDK de bots.
- Conexão simultânea a vários servidores. A barra mostra os servidores salvos, mas só um fica conectado por vez.
- Áudio do sistema na tela compartilhada.
- Criptografia ponta a ponta de texto.
- Cliente para Linux e para celular.
- Versão portable do Windows (daria problema com firewall e atualização).
- TURN na VPS (o ICE-TCP na porta 7881 já cobre redes sem UDP).
- Canal de atualização beta.
- Assinatura de código paga (certificado para Windows e Apple Developer ID). O impacto está na §15.
- Descoberta de servidores na LAN por broadcast.
- Várias sessões da mesma identidade ao mesmo tempo. Um login novo derruba o anterior.
- Diretório público de servidores.
- Retenção automática de mensagens (apagar mensagens antigas).

## 2. Arquitetura

```
┌───────────────────── App GhostLink (Electron 44, Windows/macOS) ──────────────────┐
│ Renderer (React, sandbox, app://ghostlink)   Main process                          │
│  UI, estado, i18n, livekit-client ◄─IPC─►  Identidade (seed via safeStorage)       │
│  /files, /avatars, /rtc via https/wss      WSS com pin exato por host:porta         │
│  (pin só do servidor conectado)            URLs assinadas, UPnP, bandeja, updater   │
│                                            utilityProcess ─► Servidor (Hospedar)    │
└────────────┬───────────────────────────────────────────────────────────────────────┘
             │ wss/https :7700 (TLS autoassinado, fixado)     UDP :7882 / TCP :7881 (mídia)
             ▼                                                          ▼
┌─────────────── Servidor GhostLink (Node 24) ─────────────┐   ┌──────────────────────┐
│ HTTPS + WSS na porta pública (padrão 7700)                │   │ livekit-server        │
│  /ws · /files · /avatars · /icon · /upload · /health · /  │   │ sinalização em        │
│  /rtc* → proxy AUTORIZADO p/ LiveKit (127.0.0.1:<livre>)  │──►│  127.0.0.1:<livre>    │
│ webhooks do LiveKit em 127.0.0.1:<livre>                  │◄──│ mídia UDP 7882 (mux)  │
│ SQLite (node:sqlite) · arquivos em data/files             │   │ ICE-TCP 7881          │
└───────────────────────────────────────────────────────────┘   └──────────────────────┘
  Roda no app (utilityProcess) ou sozinho (CLI `ghostlink-server`, systemd na VPS)
```

### 2.1 Repositório (npm workspaces, tudo em TypeScript)

```
ALONE_IN_THE_DARK/                 # vira o repositório público "ghostlink"
├─ package.json                    # workspaces + scripts: dev, test, test:e2e, build, dist, docs:*
├─ tsconfig.base.json · LICENSE (GPL-3.0) · README.md (pt-BR) · README.en.md · CONTRIBUTING.md · SECURITY.md
├─ packages/shared/                # @ghostlink/shared: sem APIs exclusivas do Node e sem DOM
│  └─ src/ protocol.ts schemas.ts errors.ts permissions.ts constants.ts invite.ts auth.ts
│          version.ts text.ts (normalização de apelido, emoji)
├─ apps/server/                    # @ghostlink/server: biblioteca + CLI
│  ├─ src/ index.ts (startServer) cli.ts
│  │   config/ tls/ db/ (migrations/*.sql) auth/ invites/ membership/ files/
│  │   handlers/{channels,messages,roles,members,voice,uploads,server}
│  │   livekit/{process,config,tokens,webhooks,rooms,permissions}
│  │   http/{router,files,upload,rtc-proxy} net/{upnp,addresses,ports} ratelimit/ util/
│  ├─ scripts/install.sh           # instala e atualiza na VPS
│  └─ test/
├─ apps/desktop/                   # @ghostlink/desktop: Electron
│  ├─ src/main/     app.ts protocol.ts identity.ts connection.ts pinning.ts fileUrls.ts host.ts
│  │                tray.ts notifications.ts ptt.ts screenPicker.ts deeplink.ts updater.ts
│  │                permissions.ts ipc.ts smoke.ts
│  ├─ src/preload/  index.ts (API mínima e tipada via contextBridge)
│  ├─ src/renderer/ React: app/, features/{onboarding,join,host,chat,voice,members,server-settings,
│  │                 user-settings}, components/, stores/, i18n/{pt-BR,en}.ts, styles/tokens.css
│  ├─ build/        entitlements.mac.plist installer.nsh ícones
│  ├─ resources/    livekit/{win-x64,mac-arm64,mac-x64}/livekit-server[.exe] (gerado no build), sons
│  └─ test/e2e/     Playwright + Electron (build de dev)
├─ docs-site/                      # VitePress: pt-BR na raiz, en/ em inglês
├─ scripts/        fetch-livekit.mjs build-livekit-darwin.sh gen-sounds.mjs checksums.mjs sign-release.mjs
└─ .github/workflows/ ci.yml release.yml docs.yml
```

**Regras de fronteira**
- O `shared` não depende de APIs exclusivas do Node nem do DOM.
- O servidor não conhece o Electron.
- O renderer não usa Node.
- Toda string visível ao usuário vem do i18n.
- O servidor envia só **códigos** de erro, e o cliente os traduz.

### 2.2 Stack

| Camada | Escolha (versões verificadas em 2026-09-27) |
|---|---|
| Linguagem | TypeScript 5.x com `strict` |
| Runtime | Node ≥ 24.14 (`engines`). Em Node < 24.15 o `node:sqlite` avisa que é experimental, e os scripts rodam com `--disable-warning=ExperimentalWarning`. O Electron 44 traz Node 24.21. |
| Servidor | `node:https` + `ws` 8.x · `node:sqlite` · `zod` · `livekit-server-sdk` 2.x · `@peculiar/x509` 2.x + `reflect-metadata` (polyfill obrigatório, importado **antes** do x509) |
| Desktop | Electron 44 · `electron-vite@5.0.0` + `vite@^7` + `@vitejs/plugin-react@^5.2` (o plugin-react 6 exige vite 8, que o electron-vite 5 não suporta) · React 19 · `zustand` · CSS Modules + tokens · `lucide-react` · fonte Inter embutida · `livekit-client` 2.x · `electron-updater` (versão fixada) |
| Build targets | main/preload `node24`; renderer `chrome152` |
| Nativos | Só o `uiohook-napi` 1.5.x (push-to-talk global). Tem prebuild N-API para win32-x64, darwin-x64 e darwin-arm64, e carrega no Electron 44 sem rebuild. |
| UPnP | Implementação própria e mínima em `net/upnp.ts`: SSDP M-SEARCH, XML de descrição e SOAP `GetExternalIPAddress`/`AddPortMapping`/`DeletePortMapping`, com IGD v1/v2 e WANIPConnection/WANPPPConnection. As bibliotecas prontas foram descartadas: estão abandonadas, só suportam IGD2 ou dependem do `wmic`, que não existe no Windows 11 24H2+. É testada contra um IGD falso. |
| Testes | `vitest` (unidade e integração) · Playwright `_electron` (e2e no build de dev) · `livekit-cli load-test` (carga) |
| Empacotamento | `electron-builder` 26 (versão fixada) com fuses nativos (`electronFuses`) |
| Site | VitePress 1.6.4, no GitHub Pages |

## 3. Identidade e autenticação

### 3.1 Semente-mestra

- **Geração:** na primeira execução, **depois de `app.whenReady()`**, o main gera a `masterSeed` com 32 bytes aleatórios.
- **Armazenamento:**
  - A seed é convertida para base64, porque `encryptString` só aceita string.
  - Depois é cifrada com `safeStorage.encryptString` e gravada em `<userData>/identity.bin`.
  - No Windows, isso usa AES-256-GCM com uma chave guardada em `<userData>/Local State`, protegida pelo DPAPI do usuário.
  - No macOS, a chave fica no Chaveiro, no item "GhostLink Safe Storage".
  - Se `safeStorage.isEncryptionAvailable()` for falso, o app não cria a identidade e mostra um erro explicativo.
- **Falha ao decifrar não é primeira execução:**
  - Se `identity.bin` existe e `decryptString` falha (Chaveiro negado, `Local State` apagado ou corrompido), o app **nunca** gera uma seed nova nem sobrescreve o arquivo.
  - Em vez disso mostra a tela "Não foi possível abrir sua identidade", com **Tentar de novo**, **Importar backup** e, só com confirmação dupla, **Criar identidade nova**.
  - Na última opção, o arquivo antigo é renomeado para `identity.bin.bak-<data>`.
- **Isolamento:** o renderer **nunca** recebe a seed, as chaves privadas nem o `fileToken`.
- **Apelido:** a pessoa escolhe um apelido global, que pode ser trocado por servidor.
- **Apagar a identidade:** nas configurações, com confirmação dupla e a oferta de exportar antes. O main nunca destrói a chave: renomeia `identity.bin` para `identity.bin.bak-<data>`, como na importação, e a tela diz onde o arquivo ficou.

### 3.2 Identidade do servidor e chave por servidor

- **`serverKeyId`:** é `base64url(SHA-256(SPKI DER do certificado TLS))`.
  - O cálculo é `new X509Certificate(raw).publicKey.export({ type: 'spki', format: 'der' })`.
  - **Nunca** usar `cert.pubkey`, que em EC é o ponto cru, nem `fingerprint256`, que é o hash do certificado inteiro.
- **Certificado:** gerado na primeira execução com `@peculiar/x509` e guardado em `data/tls/`, com a chave em `0600`.
  - ECDSA P-256 com SHA-256.
  - Serial aleatório de 16 bytes, positivo.
  - `CN=GhostLink`, `BasicConstraints CA:false`.
  - **`KeyUsage = digitalSignature` (crítico).** Sem isso, o BoringSSL recusa o certificado antes de o pin ser checado.
  - `EKU = serverAuth`.
  - SAN `localhost` e `127.0.0.1`.
  - Validade de 10 anos.
  - Renovar o certificado mantendo a mesma chave preserva o `serverKeyId`.
- **Chave por servidor:**
  - `seed_srv = HKDF-SHA256(ikm=masterSeed, salt="ghostlink/identity/v1", info=serverKeyId, len=32)`.
  - A chave Ed25519 sai de `createPrivateKey({ key: 302e020100300506032b657004220420 ‖ seed_srv, format: 'der', type: 'pkcs8' })`.
  - Servidores diferentes recebem chaves diferentes e não conseguem ligar uma pessoa entre eles. Um servidor também não consegue se passar pelo ID de outro.
- **userId:** `hex(SHA-256(chave pública raw de 32 bytes))[0:32]`, ou seja, 128 bits.
  - A busca é sempre pela chave pública completa.
  - Uma chave nunca é trocada a partir de um ID parcial.

### 3.3 Conexão, pin e handshake

**Pin no main (exato por `host:porta`)**
- O `connection.ts` passa um `createConnection` próprio ao `ws`, que chama `tls.connect({ ...opts, rejectUnauthorized: false })`.
- No evento `secureConnect`, calcula o `serverKeyId` a partir de `getPeerCertificate(true).raw`, chamado **uma vez só**.
- Se o valor divergir do pin, faz `socket.destroy(PIN_MISMATCH)` **antes** de enviar o pedido de upgrade.
- **Não** usar `checkServerIdentity` (não é chamado para certificado autoassinado) nem chamar `getPeerX509Certificate()` repetidamente.

**Várias rotas até o mesmo servidor:** o convite pode trazer vários endereços. O app tenta todos em paralelo, começando um a cada 250 ms, com timeout de 5 s cada, e usa o primeiro que passa no pin.

**TOFU (entrada sem convite)**
- Uma conexão-sonda sem pin só lê o `serverKeyId` e fecha.
- O app mostra os **primeiros 20 bytes do `serverKeyId` em base32, em 4 grupos de 8 caracteres** (160 bits), pede confirmação e reconecta com o pin.
- O painel do Hospedar e o `ghostlink-server status` mostram a impressão digital no mesmo formato.
- Se o pin de um servidor já salvo mudar, a conexão é bloqueada e o app mostra um aviso claro.

**Handshake**
```
C→S  hello       { protocol: 1, publicKey, nickname, locale, password?, inviteCode?, setupCode?,
                   client: "ghostlink/0.1.0 (win32|darwin)" }
S→C  challenge   { nonce (32 bytes b64url, uso único, expira em 30 s), serverKeyId }
C→S  auth.proof  { signature }  // Ed25519 sobre UTF-8: "ghostlink-auth-v1\n" + serverKeyId + "\n" + nonce
S→C  welcome     { ...snapshot (§5.3) }   |   error { code, min?, max? }
```

- **Prazos:** o `hello` precisa chegar até 5 s depois do TLS, e o `auth.proof` até 10 s depois. Fora disso, a conexão fecha.
- **Vínculo com o canal TLS:** a assinatura cobre o `serverKeyId` que **o main calculou a partir do certificado que ele próprio validou**. Se alguém repassar a prova para outro servidor, ela é rejeitada.
- **Onde se assina:** a assinatura é feita no main. O renderer recebe o `welcome` sem o `fileToken`, e depois os eventos.
- **Códigos de erro:** `PROTOCOL_UNSUPPORTED` (vem com `min`/`max`), `BAD_PASSWORD`, `INVITE_REQUIRED`, `INVITE_INVALID`, `BAD_SIGNATURE`, `CHALLENGE_EXPIRED`, `SERVER_FULL`, `BANNED`, `REJOIN_BLOCKED`, `NICK_TAKEN`, `RATE_LIMITED`, `BAD_SETUP_CODE`.

**Modos de entrada (`server_meta.join_mode`)**
- **Padrão: `invite`**, no Hospedar e na VPS.
- `open`: qualquer pessoa com o endereço entra.
- `password`: a senha é pedida **só no primeiro acesso** de cada identidade.
  - É guardada com `scrypt` (N=2^14, r=8, p=1, salt de 16 bytes, no máximo 2 cálculos simultâneos, sempre depois do rate limit) e comparada com `timingSafeEqual`.
  - O app não guarda a senha, e trocá-la não expulsa ninguém.
- `invite`: o primeiro acesso de cada identidade exige um `inviteCode` válido (§3.5).
- **Quem já é membro** (usuário com `removed_at IS NULL`) entra sem senha e sem convite.

**Dono**
- Na primeira execução, o servidor gera um **código de setup** de 128 bits, mostrado em 4 grupos.
  - Ele é impresso no console e gravado em `data/setup-code.txt` (`0600`). O banco guarda só o hash.
- Um `hello` com `setupCode` válido torna aquela pessoa dona.
  - Isso **dispensa convite, senha e `max_members`**.
  - O código é consumido na mesma transação que grava `owner_user_id`, e o arquivo é apagado.
- No Hospedar, o app lê o código localmente e o envia sozinho.
- **Recuperar a posse:**
  - No Hospedar, é o botão **Configurações do servidor > Recuperar posse**, que faz o equivalente ao `reset-owner` localmente e usa o código na hora.
  - Na VPS, é `ghostlink-server reset-owner`.
- **Transferir a posse:**
  - É `server.transferOwnership { userId }`, com confirmação dupla.
  - O dono antigo recebe o cargo `Admin`.

**Sessão única:** um login novo da mesma identidade encerra a sessão anterior com `error { code: "SESSION_REPLACED" }`.

### 3.4 Backup da identidade

- **Arquivo `.ghostkey`:**
  - cabeçalho com o magic `GLKEY`, a versão e os parâmetros;
  - chave derivada com `scrypt(senha, salt de 16 bytes, N=2^17, r=8, p=1, maxmem=256 MiB)`, que gera 32 bytes;
  - cifra AES-256-GCM, com IV de 12 bytes e o cabeçalho como AAD, aplicada sobre a `masterSeed`.
- **Importar:** substitui a seed atual, com confirmação dupla.
- **Avisos:** o onboarding e as configurações avisam que, sem backup, perder o dispositivo é perder a identidade.

### 3.5 Convites

- **Tabela `invites`:** `code` (10 caracteres base32 aleatórios), `created_by`, `expires_at?`, `max_uses?`, `uses` e `revoked`.
  - Força bruta fica inviável pelo espaço de códigos e pelo rate limit de autenticação.
- **Consumo atômico:**
  - A checagem no `hello` é só prévia. O consumo acontece depois do `auth.proof`, numa **única transação síncrona do SQLite, sem nenhum `await` no meio**.
  - Nessa transação, `UPDATE invites SET uses = uses + 1 WHERE code = ? AND revoked = 0 AND (max_uses IS NULL OR uses < max_uses) AND (expires_at IS NULL OR expires_at > ?)` precisa retornar `changes === 1`.
  - Na mesma transação, o servidor checa `max_members` e faz o `INSERT` ou a reativação do usuário.
  - Se `changes === 0`, o resultado é `INVITE_INVALID`.
  - O convite só é consumido por identidade **nova ou que volta** depois de ter sido removida.
- **Endereços:**
  - Vêm do servidor, nunca do cliente que cria o convite, e ficam em `server_meta.public_addresses` (JSON com a lista de `host:porta`).
  - No Hospedar, a lista é preenchida com o IP WAN, o da LAN e os das VPNs detectadas, e atualizada quando eles mudam.
  - Na VPS, vem da config ou de `--public-address`.
- **Formatos que o servidor monta** (resposta de `invite.create`: `{ code, link, pasteCode, webLink }`):
  - `link`: `ghostlink://join?h=<host:porta>[,…]&k=<serverKeyId>&i=<code>&n=<nome>`.
  - `pasteCode`: `GL1-<base64url do mesmo conteúdo>`, para colar dentro do app.
  - `webLink`: `https://<site>/j/#GL1-<…>`. É o que **"Copiar convite"** copia, porque WhatsApp, Discord e Telegram não deixam `ghostlink://` clicável.
- **Página `/j/`:**
  - É uma página estática do site. Lê o fragmento **só no navegador** (o fragmento nunca chega a servidor nenhum) e tenta abrir o `ghostlink://join?…`.
  - Se o app não abrir em 1,5 s, mostra o download para o sistema detectado e o `GL1-` para colar depois de instalar.
  - Não tem trackers nem chamadas externas.

### 3.6 Constantes congeladas

As strings de domínio criptográfico e de protocolo ficam em `shared/constants.ts` como `CRYPTO_LABELS` e **nunca mudam**, mesmo que a marca mude um dia:

- `ghostlink/identity/v1`
- `ghostlink-auth-v1`
- `ghostlink-file-v1`
- `GLKEY`
- o prefixo `GL1-`
- o esquema `ghostlink://`

O `appId` (`app.ghostlink.desktop`) e o nome da pasta de `userData` também ficam fixos desde a 0.1.0.

## 4. Transporte, rotas e pinning no renderer

**Rotas do servidor (HTTPS e WSS na porta pública, padrão 7700)**
- `GET /health` → `{ ok, name, version, protocol: { min, max } }`, sem nenhum dado sensível.
- `HEAD /` e `GET /` → `200` com `Access-Control-Allow-Origin: *`. O `livekit-client` usa isso para reconectar rápido.
- `GET /ws`: upgrade do protocolo.
- `POST /upload?u=<uploadToken>` → `{ fileId }`.
  - O corpo é cortado assim que passa do `size` declarado.
  - São no máximo 3 uploads simultâneos por sessão, e a conexão cai depois de 60 s sem progresso.
- `GET /files/:fileId`, `GET /avatars/:userId` e `GET /icon`: exigem **URL assinada** (§7). O nome do arquivo sai do banco, nunca do path.
- Tudo em `/upload`, `/files`, `/avatars` e `/icon` responde com `Access-Control-Allow-Origin: *`, sem credenciais, e aceita `OPTIONS`. A autorização vem só do token na URL.
- `/rtc`, `/rtc/v1`, `/rtc/validate` e `/rtc/v1/validate`: **proxy autorizado**, HTTP e WebSocket, para a porta interna do LiveKit.
  - Repassa path e query byte a byte. O `join_request` pode ter vários KB, então o `maxHeaderSize` fica em pelo menos 16 KB.
  - Repassa status e corpo sem alterar nada.
  - **Não registra URLs no log.**
- O servidor HTTP usa `headersTimeout` de 10 s e `requestTimeout` de 30 s.

**Autorização no proxy `/rtc*`**
- O LiveKit OSS não revoga tokens. Por isso o proxy valida o `access_token` (JWT HS256 com o `apiSecret`, conferindo `exp` e `nbf`) e **aceita também os tokens de renovação que o próprio LiveKit emite**: mesmo `sub` e `video.room`, validade de cerca de 10 min. Não exige claim própria do GhostLink.
- Do token, o proxy extrai `sub = u_<userId>` e `video.room = ch_<channelId>`.
- A conexão só é encaminhada se, **naquele momento**, todas as condições valem:
  - existe uma sessão GhostLink desse usuário **ativa ou em período de graça** (até 20 s depois de o WSS cair);
  - a sala é a que o servidor atribuiu a ele;
  - ele tem VIEW_CHANNEL e CONNECT_VOICE;
  - ele não está banido nem removido.
- Se alguma falhar, a resposta é `403`, **nunca** `404`. Um `404` faz o cliente tentar a rota antiga, `/rtc`.
- Quando a graça acaba sem reconexão, o **servidor** chama `removeParticipant` e limpa a sala atribuída.

**Pinning no renderer (LiveKit, arquivos e avatares)**
- O `session.setCertificateVerifyProc` tem três respostas:
  - hostname com pin e SPKI igual → `callback(0)`;
  - hostname com pin e SPKI diferente → `callback(-2)`;
  - hostname sem pin → `callback(-3)`, que é a verificação padrão do Chromium.
- A API não informa a porta. Por isso **o renderer só tem o pin do servidor conectado no momento** (o hostname usado e a SPKI dele).
  - O pin entra depois que o handshake no main termina com `welcome`.
  - Sai quando a pessoa troca de servidor ou desconecta.
- Convites e servidores salvos **nunca** acrescentam pins ao renderer.
- **Obrigatório:** `app.commandLine.appendSwitch('disable-features', 'CacheCertVerification')` antes do `ready`, numa lista única de features. Sem isso, o Chromium guarda o resultado da verificação, inclusive recusas, por até 30 min.
- Chamar `session.defaultSession.closeAllConnections()` a cada mudança de pin.

**Mídia**
- A sinalização do LiveKit passa pelo proxy, dentro do TLS fixado.
- A mídia é WebRTC com DTLS-SRTP.

**Sem terceiros**
- Por padrão, o LiveKit usaria STUN do Google e da Twilio em três pontos. Contramedidas:
  - `use_external_ip: false` com `node_ip` explícito (§8.1);
  - o renderer conecta com `rtcConfig: { iceServers }`, usando a lista que vem do `voice.join`, que é vazia no MVP. Assim o cliente ignora a lista enviada pelo LiveKit.
- STUN externo é só uma opção explícita da config.
- O `install.sh` descobre o IP sem consultar serviços externos (§10).
- O único contato com terceiros é a checagem de atualização (§15).

## 5. Protocolo WebSocket

### 5.1 Envelope e regras

- **Envelope:** `{ "t": string, "id"?: number, "d"?: object }`.
  - Resposta de sucesso: `{ t: "res", id, ok: true, d }`.
  - Resposta de erro: `{ t: "res", id, ok: false, error: { code, message } }`.
  - Eventos do servidor não têm `id`.
- **Códigos de erro:** formam um **enum fechado** em `shared/errors.ts`. São os da §3.3 mais `BAD_REQUEST`, `NOT_FOUND`, `FORBIDDEN`, `HIERARCHY`, `RATE_LIMITED`, `CHANNEL_FULL`, `FILE_TOO_LARGE`, `IMAGE_TOO_LARGE`, `QUOTA_EXCEEDED`, `BAD_ATTACHMENT`, `NICK_TAKEN`, `OWNER_MUST_TRANSFER` e `INTERNAL`. Cada um tem chave de i18n tipada.
- **Validação:**
  - No servidor, todo payload recebido passa por um schema `zod` **estrito**. Se falhar, a resposta é `BAD_REQUEST`.
  - No cliente, os schemas **descartam campos desconhecidos**, e tipos de evento desconhecidos são ignorados.
- **Ordem de processamento:** as mensagens de um mesmo socket são tratadas em série, numa cadeia de promises. Depois de todo `await`, o handler reconfere se a sessão continua sendo a atual.
- **Limites e presença:**
  - `maxPayload` de 256 KiB.
  - Ping do WS a cada 15 s. Sem pong em 30 s, a conexão cai.
  - A presença só muda para offline depois de 20 s de graça.
- **Compatibilidade:**
  - O servidor aceita `protocol` de `min` a `max`.
  - Mudanças aditivas não sobem a versão.
  - Uma quebra sobe o `max`, e o `max-1` continua aceito por pelo menos uma versão minor.
  - O `welcome` traz `features: string[]`.
  - O cliente mostra `PROTOCOL_UNSUPPORTED` como "Atualize o app" ou "Este servidor está desatualizado; avise o dono".

### 5.2 Requisições do cliente

| Tipo | Payload | Permissão |
|---|---|---|
| `channel.create` | `{ name, type: "text"\|"voice", topic?, private?, allowedRoleIds?, userLimit? }` → `{ channel }` | MANAGE_CHANNELS |
| `channel.update` | `{ id, name?, topic?, private?, allowedRoleIds?, userLimit? }` | MANAGE_CHANNELS |
| `channel.delete` / `channel.reorder` | `{ id }` / `{ ids }` | MANAGE_CHANNELS |
| `msg.history` | `{ channelId, before?: number, limit ≤ 50 }` → `{ messages, hasMore }` | VIEW_CHANNEL |
| `msg.send` | `{ channelId, content ≤ 4000, clientMsgId, replyTo?, attachmentIds? (≤10) }` → `{ message }` | SEND_MESSAGES; ATTACH_FILES se houver anexos; `@everyone` sem MENTION_EVERYONE vira texto comum |
| `msg.edit` | `{ id, content }` | só o autor + VIEW_CHANNEL atual |
| `msg.delete` | `{ id }` | (autor ou MANAGE_MESSAGES) + VIEW_CHANNEL atual |
| `msg.react` / `msg.unreact` | `{ id, emoji }`: o emoji precisa casar com `^\p{RGI_Emoji}$` (regex com flag `v`), e vale no máximo 20 distintos por mensagem | VIEW_CHANNEL + ADD_REACTIONS |
| `channel.read` | `{ channelId, messageId }` | VIEW_CHANNEL |
| `typing` | `{ channelId }` | SEND_MESSAGES |
| `upload.begin` | `{ purpose: "attachment"\|"avatar"\|"icon", channelId?, name, size }` → `{ uploadToken }` | ATTACH_FILES (+ VIEW_CHANNEL no canal) / própria conta / MANAGE_SERVER |
| `profile.update` | `{ nickname?, avatarFileId?: string\|null }` | própria conta |
| `role.create` | `{ name, color, permissions, hoist, mentionable }` → `{ role }` | MANAGE_ROLES + hierarquia |
| `role.update` | `{ id, name?, color?, permissions?, hoist?, mentionable? }` | MANAGE_ROLES + hierarquia |
| `role.delete` | `{ id }` | MANAGE_ROLES + hierarquia |
| `role.reorder` | `{ ids }`: só cargos abaixo do seu mais alto, e `@todos` sempre por último | MANAGE_ROLES + hierarquia |
| `member.setRoles` | `{ userId, roleIds }` | MANAGE_ROLES + hierarquia |
| `member.kick` | `{ userId }` | KICK_MEMBERS + hierarquia |
| `member.ban` / `member.unban` / `bans.list` | `{ userId, reason?, banIp?: boolean }` | BAN_MEMBERS + hierarquia |
| `invite.create` | `{ maxUses?, expiresInHours? }` → `{ code, link, pasteCode, webLink }` | CREATE_INVITES |
| `invite.list` / `invite.revoke` | `{}` / `{ code }` | próprios: CREATE_INVITES; de outros: MANAGE_SERVER |
| `server.update` | `{ name?, iconFileId?, joinMode?, password?: string\|null, maxMembers?, uploadLimitMb?, storageQuotaMb? }` | MANAGE_SERVER |
| `server.transferOwnership` | `{ userId }` | só o dono |
| `server.leave` | `{ deleteMyMessages?: boolean }` | própria conta. O dono recebe `OWNER_MUST_TRANSFER` |
| `voice.join` | `{ channelId }` → `{ livekitUrl, token, iceServers }` | VIEW_CHANNEL + CONNECT_VOICE + lotação |
| `voice.leave` | `{}` | — |
| `voice.selfState` | `{ muted, deafened }` | — |
| `voice.moderate` | `{ userId, action: "mute"\|"unmute"\|"disconnect"\|"move", toChannelId? }` | `mute`/`unmute`: MUTE_MEMBERS · `disconnect`/`move`: MOVE_MEMBERS · hierarquia sempre |
| `ping` | `{}` → `{ t }` | — |

Um `msg.*` enviado a um canal de voz responde `BAD_REQUEST`, porque canal de voz não tem chat no MVP.

### 5.3 Eventos do servidor

- **`welcome`**
  - Campos: `{ self, sessionId, serverTime, server, features, fileToken, channels, roles, members, voice, readStates, protocol }`.
  - `channels[]` traz `lastMessageId`. `readStates` é `[{ channelId, lastReadMessageId, mentionCount }]`.
  - É o snapshot completo, **já filtrado**.
  - O main **retira o `fileToken`** antes de repassar o `welcome` ao renderer.
- **Canais:** `channel.created`, `channel.updated` e `channel.deleted`.
  - Quem perde acesso a um canal (por mudança nele ou nos seus cargos) recebe `channel.deleted`.
  - Quem ganha acesso recebe `channel.created`, junto com o `voice.state` e o estado de leitura correspondentes.
- **Mensagens e digitação:** `msg.new`, `msg.updated`, `msg.deleted`, `msg.reactions { id, reactions }` e `typing { channelId, userId }`.
- **Membros:** `member.joined`, `member.updated`, `member.left { userId, reason: "left"|"kicked"|"banned" }` e `presence { userId, online }`.
- **Cargos e servidor:** `role.created`, `role.updated`, `role.deleted` e `server.updated`.
- **Voz:** `voice.state { channelId, participants: [{ userId, muted, deafened, camera, screen, serverMuted }] }`, `voice.forceMove { toChannelId }` e `voice.forceDisconnect {}`.
- **Encerramento:** `error { code }` chega antes do fechamento, com `KICKED`, `BANNED`, `SESSION_REPLACED` ou `SERVER_SHUTDOWN`.

**Regra de audiência:** todo evento de canal (mensagem, reação, digitação, `voice.state`, leitura) só chega **a quem tem VIEW_CHANNEL nele**, e isso é calculado por destinatário. Canal privado responde `NOT_FOUND`, exatamente como um canal que não existe. A lista de membros e a presença são visíveis a todo o servidor.

**Referências cruzadas (privacidade)**
- **`msg.send.replyTo`:** precisa apontar para uma mensagem do **mesmo `channelId`**, senão a resposta é `NOT_FOUND`. A prévia de resposta só mostra mensagens do mesmo canal.
- **`msg.send.attachmentIds`:** cada arquivo precisa atender a quatro condições:
  - `uploader_id` igual ao remetente;
  - `purpose = 'attachment'`;
  - `channel_id` igual ao da mensagem;
  - `message_id IS NULL`.

  A vinculação acontece na mesma transação da mensagem. Se alguma condição falhar, a resposta é `BAD_ATTACHMENT`.
- **VIEW_CHANNEL atual:** `msg.edit`, `msg.delete`, `msg.react` e `channel.read` checam o acesso **no momento da ação**. Sem ele, a resposta é `NOT_FOUND`, inclusive para o autor da mensagem.
- **`voice.moderate move`:** quem move precisa de VIEW_CHANNEL no `toChannelId`, senão recebe `NOT_FOUND`. O alvo precisa de VIEW_CHANNEL e CONNECT_VOICE nesse canal e precisa caber no `user_limit`.
- **`mentions`:** só são criadas para quem tem VIEW_CHANNEL no momento do envio.
- **Apagar uma mensagem:** apaga também os arquivos dela (a linha no banco e o arquivo no disco), as reações e as menções.
- **IDs:** os de canal, cargo e arquivo são aleatórios (128 bits, base32).
  - O `id` de mensagem é global e crescente. Os saltos revelam o volume total do servidor, mas não o conteúdo nem o canal. Isso é aceito e documentado na página de privacidade.

**Aviso de servidor desatualizado:** se o `server.version` do `welcome` for menor que a versão mais recente conhecida pelo updater do app, quem tem MANAGE_SERVER vê o aviso "Há versão nova do servidor", com link para o guia.

## 6. Permissões

- **Bits:** `VIEW_CHANNEL`, `SEND_MESSAGES`, `ADD_REACTIONS`, `ATTACH_FILES`, `MENTION_EVERYONE`, `CREATE_INVITES`, `CONNECT_VOICE`, `SPEAK`, `VIDEO` (câmera e tela), `MANAGE_MESSAGES`, `MANAGE_CHANNELS`, `MANAGE_ROLES`, `MANAGE_SERVER`, `KICK_MEMBERS`, `BAN_MEMBERS`, `MUTE_MEMBERS`, `MOVE_MEMBERS` e `ADMINISTRATOR`.
  - A posição de cada bit é **fixa** em `shared/permissions.ts` e nunca é renumerada.
- **Permissões efetivas:**
  - O dono tem todas.
  - Para os demais, é o OR de `@todos` com os cargos do usuário.
  - `ADMINISTRATOR` implica todas as outras.
- **Canal privado:**
  - Fica visível a quem tem um dos `allowedRoleIds`, a quem tem `ADMINISTRATOR` e ao dono.
  - VIEW_CHANNEL no cargo não basta sozinho: também é preciso estar na lista.
- **Hierarquia:**
  - Cada cargo tem uma `position`.
  - Só se gerencia cargos e membros cujo cargo mais alto está **abaixo** do seu cargo mais alto.
  - Ninguém concede um bit que não tem.
  - O dono fica acima de todos, e ninguém age sobre ele.
- **Cargos padrão:**
  - `@todos`: VIEW_CHANNEL, SEND_MESSAGES, ADD_REACTIONS, ATTACH_FILES, CONNECT_VOICE, SPEAK e VIDEO. **Sem CREATE_INVITES.** O dono pode ligar em Cargos, e a interface explica o efeito.
  - `Admin` (criado no seed): ADMINISTRATOR.
- **Onde fica a regra:** numa função única, `permissionsFor(user, channel?)`, em `shared/permissions.ts`. O servidor é a fonte da verdade. A interface usa a mesma função só para esconder botões.
- **Permissões no LiveKit:** a função `livekitPermission(user, channel, { serverMuted })` gera o bloco **completo**, usado no token de acesso e em todo `updateParticipant`:
  - `canSubscribe: true`, `canPublishData: false`, `canUpdateMetadata: false` e `hidden: false`.
  - `canPublishSources` usa o enum `TrackSource` do `livekit-server-sdk`:
    - `MICROPHONE`, se a pessoa tem SPEAK e não está `serverMuted`;
    - mais `CAMERA`, `SCREEN_SHARE` e `SCREEN_SHARE_AUDIO`, se tem VIDEO.
  - `canPublish = canPublishSources.length > 0`. Lista vazia com `canPublish: true` significaria "todas as fontes", por isso é **proibida**.

## 7. Dados (SQLite via `node:sqlite`)

**Configuração do banco**
- O arquivo é `data/ghostlink.db`, com `PRAGMA journal_mode=WAL; foreign_keys=ON; busy_timeout=5000; secure_delete=ON`.
- **Migrações:**
  - São SQL numerados, controlados por `PRAGMA user_version`, e cada uma roda numa transação.
  - Antes de migrar, o servidor faz `VACUUM INTO data/backups/ghostlink-v<user_version>.db` e mantém as 3 cópias mais recentes.
  - Se o `user_version` do banco for maior do que o que o servidor conhece, ele **não inicia** e explica o motivo.
- **Tipos:** BLOBs chegam como `Uint8Array` e as linhas como objetos sem protótipo. O wrapper converte e compara chaves com `Buffer.compare`.
- **Permissões de arquivo:** `data/config.json`, `data/livekit.yaml`, `data/tls/*.key` e `data/setup-code.txt` ficam com `0600` no Linux e no macOS.

```sql
server_meta(id INTEGER PRIMARY KEY CHECK (id = 1), name, icon_file_id,
            join_mode CHECK (join_mode IN ('open','password','invite')) DEFAULT 'invite',
            password_hash, owner_user_id, setup_code_hash, public_addresses /* JSON */,
            max_members DEFAULT 100, upload_limit_mb DEFAULT 25, storage_quota_mb DEFAULT 10240, created_at)
users(id TEXT PRIMARY KEY, public_key BLOB UNIQUE NOT NULL, nickname, nickname_norm UNIQUE,
      avatar_file_id, locale, joined_at, last_seen_at, last_ip, removed_at NULL, rejoin_blocked_until NULL)
bans(user_id PRIMARY KEY, public_key BLOB, ip NULL, reason, banned_by, created_at)
invites(code TEXT PRIMARY KEY, created_by, created_at, expires_at NULL, max_uses NULL, uses DEFAULT 0, revoked DEFAULT 0)
roles(id TEXT PRIMARY KEY, name, color, permissions INTEGER, position INTEGER, hoist INTEGER,
      mentionable INTEGER, is_default INTEGER)
user_roles(user_id, role_id, PRIMARY KEY(user_id, role_id))
channels(id TEXT PRIMARY KEY, name, type CHECK (type IN ('text','voice')), topic, position,
         private INTEGER, user_limit INTEGER DEFAULT 0 /* 0 = sem limite */, created_at)
channel_allowed_roles(channel_id, role_id, PRIMARY KEY(channel_id, role_id))
messages(id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id, user_id, content, reply_to_id,
         created_at, edited_at, deleted_at, client_msg_id, UNIQUE(user_id, client_msg_id))
  INDEX messages_channel ON messages(channel_id, id DESC)
reactions(message_id, user_id, emoji, PRIMARY KEY(message_id, user_id, emoji))
mentions(message_id, user_id, PRIMARY KEY(message_id, user_id))
read_states(user_id, channel_id, last_read_message_id, PRIMARY KEY(user_id, channel_id))
files(id TEXT PRIMARY KEY, uploader_id, purpose, message_id NULL, channel_id NULL, name, size,
      kind CHECK (kind IN ('image','video','audio','file')), mime, width NULL, height NULL,
      disk_name, created_at)
```

**Mensagens e apelidos**
- A ordem é dada pelo `id`, atribuído pelo servidor.
- Apagar é soft delete: o conteúdo é zerado na hora, e o `secure_delete` evita que sobre na página livre do banco.
- O contador de não lidas vem de `lastMessageId > lastReadMessageId`. O de menções usa a tabela `mentions`, que inclui `@everyone` e cargos `mentionable`.
- **Apelidos:**
  - Passam por **NFKC**.
  - Perdem caracteres de controle, bidi (U+202A–U+202E, U+2066–U+2069) e de largura zero.
  - Precisam ter de 1 a 32 caracteres visíveis.
  - Unicidade por servidor sobre `nickname_norm`, que é a forma normalizada em minúsculas.
  - Se já existir, o servidor responde `NICK_TAKEN`, e a interface sugere `apelido#2`.

**Filiação, expulsão e saída**
- **Expulsar (`member.kick`):**
  - Encerra a sessão com `KICKED` e tira a pessoa da voz.
  - **Remove a filiação:** apaga `user_roles` e `read_states` e grava `removed_at` e `rejoin_blocked_until = agora + 10 min`.
  - As mensagens continuam.
  - Para voltar, a pessoa passa de novo pelo modo de entrada: no modo `invite`, precisa de um convite novo. Nos modos `open` e `password`, só o bloqueio de 10 min impede a volta imediata, e a interface avisa isso a quem expulsa.
- **Banir:** faz o mesmo que expulsar e ainda grava em `bans`, bloqueando a identidade (e o IP, se `banIp`) sem prazo.
- **Sair (`server.leave`):**
  - Remove a filiação, o avatar, as reações e o estado de leitura. O nome passa a aparecer como "ex-membro".
  - Com `deleteMyMessages`, também zera o conteúdo e os anexos das mensagens da pessoa.
- **Retenção de IP:**
  - `last_ip` guarda só o último IP e é apagado quando a filiação termina, a não ser que exista um ban por IP.
  - Os logs do servidor não guardam conteúdo nem tokens, e registram IP só em falhas de autenticação.

**Arquivos**
- **Armazenamento:** `data/files/<disk_name>`, com nome aleatório.
- **Tipo:** detectado pelos magic bytes (PNG, JPEG, GIF, WebP, MP4, WebM, OGG, MP3). O que não for reconhecido vira `file`.
- **Imagens:**
  - O servidor lê as dimensões no cabeçalho (IHDR, SOF, GIF, WebP).
  - Recusa com `IMAGE_TOO_LARGE` imagens com mais de 8192 px de lado ou mais de 40 MP.
- **Download:**
  - `Content-Disposition: attachment; filename*=UTF-8''<nome codificado>`, sem caracteres de controle nem `/ \ : * ? < > |`, para qualquer arquivo que não seja imagem, vídeo ou áudio.
  - `X-Content-Type-Options: nosniff`, `Cache-Control: private, max-age=600` e suporte a `Range`.
- **Limites:**
  - Tamanho por arquivo definido por `upload_limit_mb`.
  - Cota total de `storage_quota_mb`, que responde `QUOTA_EXCEEDED`.
  - Avatar e ícone: até 2 MB, só imagem.
  - Uploads órfãos são apagados depois de 1 h.
- **URLs assinadas:**
  - O `fileToken` (256 bits por sessão) nunca sai do main.
  - Toda leitura feita pelo renderer (`<img>`, `<video>`, `<audio>`, downloads) usa uma URL pedida por IPC com `files.url(kind, id)`: `GET /files/<fileId>?sid=<sessionId>&e=<expUnix>&s=<base64url(HMAC-SHA256(key=fileToken, "ghostlink-file-v1\n" + alvo + "\n" + sid + "\n" + e))>`.
  - O alvo é o `fileId`, ou `avatar:<userId>`, ou `icon`.
  - `e` segue o relógio do servidor (o main guarda a diferença em relação ao `serverTime`) e é arredondado para o fim da próxima janela de 10 min. Isso deixa as URLs estáveis e o cache funciona.
- **Verificação no servidor:**
  - Encontra a sessão pelo `sid`, recalcula o HMAC e compara com `timingSafeEqual`.
  - Recusa `e` vencido ou mais de 20 min no futuro.
  - Para anexos, confere o VIEW_CHANNEL da pessoa daquela sessão. Para avatar e ícone, basta a sessão existir.
  - Quando a sessão termina, as URLs dela deixam de valer.
- **Uploads:** o `uploadToken` é de uso único e expira em 60 s.

**Em memória:** sessões e períodos de graça, desafios, janelas de rate limit, digitação e estado de voz. O estado de voz é reconstruído com `listRooms()` + `listParticipants(room)` sempre que o LiveKit (re)inicia, e reconciliado a cada 60 s.

## 8. Voz, vídeo e tela (LiveKit)

### 8.1 Processo e configuração

**Portas internas:** a sinalização do LiveKit e o webhook usam **portas livres escolhidas a cada início** em `127.0.0.1`. Só 7700/TCP, 7882/UDP e 7881/TCP são públicas e configuráveis.

**Início do processo:**
- O servidor inicia `livekit-server --config data/livekit.yaml`, sem `--dev` e sem `detached`.
- Um `pidfile` limpa LiveKit órfão. Antes de matar o processo, confere que o executável daquele PID é o `livekit-server` esperado.
- O YAML só usa chaves verificadas, porque o LiveKit é estrito e aborta ao encontrar chave desconhecida:

```yaml
port: <porta interna livre>
bind_addresses: ["127.0.0.1"]     # só a sinalização; a mídia não é afetada
rtc:
  udp_port: 7882                  # uma porta UDP para toda a mídia (mux)
  tcp_port: 7881                  # ICE-TCP
  use_external_ip: false          # true exige STUN e aborta sem internet
  node_ip: <IP anunciado>
  advertise_internal_ip: true     # mantém candidatos de LAN/Radmin/Tailscale ao lado do público
keys: { <apiKey>: <apiSecret> }   # gerados na 1ª execução, em data/config.json
webhook: { api_key: <apiKey>, urls: ["http://127.0.0.1:<porta interna livre>/livekit/webhook"] }
```

**`node_ip` (IP anunciado):**
1. Se houver um valor explícito, ele é usado. Na VPS, o `install.sh` grava o IP público.
2. Senão, o IP WAN via UPnP `GetExternalIPAddress`.
3. Senão, o IP da LAN.

Um IP WAN em `100.64.0.0/10` ou em faixa RFC1918 indica **CGNAT ou NAT duplo**. O Hospedar avisa e recomenda VPN ou VPS.

**Supervisão:**
- Se o LiveKit cair, ele é reiniciado com backoff, até 5 tentativas. Depois disso, o erro aparece no painel.
- Quando **surge** um IPv4 local novo e ele continua presente por 30 s, o LiveKit é reiniciado. O mux UDP só escuta as interfaces que existiam quando ele iniciou.
  - Se houver gente em call, o painel pergunta antes de reiniciar.
  - Uma interface que some não causa reinício.

**Binários:**
- **Windows x64:** o `.exe` oficial.
- **Linux x64 e arm64 (VPS):** o `.tar.gz` oficial, conferido contra o `checksums.txt`.
- **macOS:** não existe binário oficial. O `scripts/build-livekit-darwin.sh` roda no CI, no runner `macos-latest`:
  - clona a tag `v1.13.7` e **confere o commit `8d11efdfcd4220092b6ac7b8a21af28526da5a6b`**, em vez do hash do tarball, que o GitHub não garante estável;
  - usa Go ≥ 1.26;
  - compila com **cgo ligado**, porque com `CGO_ENABLED=0` o build falha no `hwstats`/`go-osstat`: `CGO_ENABLED=1 MACOSX_DEPLOYMENT_TARGET=13.0 GOOS=darwin GOARCH={arm64,amd64} go build -trimpath -o resources/livekit/mac-{arm64,x64}/livekit-server ./cmd/server`;
  - não roda `go mod tidy` nem `go generate`. As dependências são conferidas pelo `go.sum`.

### 8.2 Entrar numa sala

1. **Pedido:** o cliente envia `voice.join { channelId }`, com rate limit (§13).
2. **Checagens do servidor:** VIEW_CHANNEL, CONNECT_VOICE e lotação (`user_limit`).
   - Se a pessoa estava em outra sala, ela é removida de lá com `removeParticipant`. `ParticipantNotFound` é ignorado.
   - O servidor registra a sala atribuída.
3. **Token:**
   - sala `ch_<channelId>`, identidade `u_<userId>`, `name` = apelido e `metadata` = `{"userId"}`;
   - permissões geradas por `livekitPermission` (§6);
   - validade de 60 s para o join. Depois disso o LiveKit renova o token sozinho.
4. **Resposta:** `{ livekitUrl: "wss://<host:porta usado pelo cliente>", token, iceServers: [] }`.
5. **Renderer:**
   - antes de tudo, confere o destino: `livekitUrl` precisa ser `wss:` no **mesmo host e porta** da conexão atual (o endereço que o main informa no welcome do renderer, o mesmo que o pin cobre), sem credenciais; cada ICE server só pode ser `stun:`/`turn:`/`turns:` nesse mesmo host. Qualquer outra coisa é recusada com `VOICE_URL_REJECTED`, sem chamar o LiveKit, e o cliente envia `voice.leave`;
   - `new Room({ adaptiveStream: true, dynacast: true, webAudioMix: true, audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceIsolation: false } })`;
   - `room.connect(livekitUrl, token, { autoSubscribe: false, rtcConfig: { iceServers } })`.

### 8.3 Estado e moderação

- **Mapa de voz:** os webhooks `participant_joined`, `participant_left`, `track_published` e `track_unpublished`, validados com o `WebhookReceiver`, atualizam o mapa e disparam `voice.state`.
- **Mute e deafen próprios:** vêm de `voice.selfState` e servem só para exibição. O mute de verdade é o microfone desligado no cliente.
- **Mudança de permissão:** `updateParticipant(room, identity, { permission: livekitPermission(...) })`, sempre com o bloco **completo**. Se a pessoa perder VIEW ou CONNECT, ela é removida com `removeParticipant`, e o proxy impede a volta.
- **Server mute:**
  - Liga `serverMuted = true` e faz `updateParticipant` sem `MICROPHONE`. O LiveKit tira o microfone do ar e recusa republicar.
  - Desfazer é outro `updateParticipant` com o microfone de volta.
  - `mutePublishedTrack` **não** é usado.
- **Mover:** remove a pessoa da sala e envia `voice.forceMove`. O cliente entra sozinho na sala nova.
- **Expulsar e banir (§7):** a sessão termina, então o proxy barra a volta à voz. A volta ao servidor fica barrada pelo modo de entrada, pelo bloqueio temporário ou pelo ban.

### 8.4 Mídia no cliente

**Assinatura seletiva**
- A pessoa se conecta com `autoSubscribe: false`.
- Em `RoomEvent.TrackPublished`, o cliente chama `pub.setSubscribed(true)` para fontes `Microphone` e `Camera`.
- Logo depois do `connect()`, o cliente percorre `room.remoteParticipants` → `trackPublications` e faz o mesmo. O `TrackPublished` não dispara para faixas que já existiam antes da entrada.
- **Tela:** só é assinada quando a pessoa clica em **"Assistir"** (`setSubscribed(true)` na publicação `ScreenShare`). "Parar" chama `setSubscribed(false)`.
  - O conjunto de telas que a pessoa está assistindo fica no estado local e é reaplicado no `TrackPublished`, inclusive depois de uma reconexão completa.

**Elementos de mídia**
- Faixas remotas sempre usam `track.attach(el)` e `detach()`, **nunca** `srcObject` manual.

**Autoplay**
- A janela usa `autoplayPolicy: 'no-user-gesture-required'`.
- Se `canPlaybackAudio === false`, o app chama `room.startAudio()` no próximo clique.

**Áudio**
- Opus com DTX e RED (o padrão).
- Detecção por **atividade de voz**, com limiar e medidor.
- Volume por pessoa de 0–200% (`setVolume`), salvo por `userId` e por servidor.
- Troca de dispositivo com `switchActiveDevice`, teste de microfone com loopback e anel de "falando" via `ActiveSpeakersChanged`.

**Push-to-talk**
- O `uiohook` só é carregado e iniciado quando o push-to-talk está ligado, e para quando ele é desligado.
- **macOS:** o gancho exige permissão de **Acessibilidade**. Antes de ligar o push-to-talk, o app chama `systemPreferences.isTrustedAccessibilityClient(true)`.
  - Sem a permissão, o app explica como liberar e mantém a detecção por voz.
  - Se o GhostLink já aparece marcado na lista, o app orienta a removê-lo e adicioná-lo de novo.

**Câmera**
- 1280×720 a 30 fps.
- Simulcast de 3 camadas (180p, 360p e 720p) com `VideoPresets`.

**Tela**
- **Seletor próprio:**
  - Usa `session.setDisplayMediaRequestHandler((req, cb) => …)` com `desktopCapturer.getSources({ types: ['screen','window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true })`.
  - O renderer recebe `{ id, name, thumbnail, icon }`. Se a miniatura vier vazia, mostra o ícone.
  - O seletor abre com estado de carregando, porque as miniaturas levam de 0,7 a 3,6 s no Windows.
  - Escolher chama `cb({ video: fonte })`. Cancelar chama `cb(null)` (com cast), e o renderer recebe `AbortError`.
  - O callback é **sempre** chamado. `useSystemPicker` não é usado.
- **Presets:** `setScreenShareEnabled(true, { resolution, contentHint }, { screenShareEncoding, screenShareSimulcastLayers })`.
  - 720p30 = `ScreenSharePresets.h720fps30`.
  - **1080p30 (padrão)** = `ScreenSharePresets.h1080fps30`.
  - 1080p60 = `new VideoPreset(1920, 1080, 8_000_000, 60)`.
  - Sem isso, o LiveKit limita a 15 fps.
- **Tipo de conteúdo:** `contentHint` é `detail` (texto) ou `motion` (jogos). Com `motion`, também `degradationPreference: 'maintain-framerate'`.
- Simulcast de 2 camadas. **Só vídeo.**
- **macOS:**
  - Checa `systemPreferences.getMediaAccessStatus('screen')` e orienta a liberar em Ajustes > Privacidade > Gravação de Tela, com um botão que abre o painel.
  - Microfone e câmera usam `systemPreferences.askForMediaAccess`.
  - O `Info.plist` tem `NSMicrophoneUsageDescription` e `NSCameraUsageDescription`.

**Reconexão**
- Fica a cargo do `livekit-client`.
- Se o WSS do GhostLink cair e voltar dentro da graça, a call continua.
- Se a graça acabar, o servidor remove a pessoa da sala, e o cliente sai da call.

### 8.5 Rede do host

- **Portas públicas:** **TCP 7700** (GhostLink), **UDP 7882** (mídia) e **TCP 7881** (mídia de reserva), todas configuráveis.
- **Porta ocupada:**
  - Se der `EADDRINUSE`, o Hospedar mostra "A porta X já está em uso por outro programa" e oferece a próxima livre (7710, 7720…, testando TCP e UDP).
  - Também avisa que convites antigos deixam de funcionar se a porta mudar.
  - A CLI sai com código 2.
- **UPnP:**
  - O `net/upnp.ts` mapeia as portas com lease de 2 h, renovado, e lê o IP WAN. Ao parar, desfaz os mapeamentos.
  - Se não conseguir, mostra o passo a passo de port forwarding e as alternativas por VPN e VPS.
  - Fica **sempre ligado no Hospedar e desligado por padrão na CLI** (liga com `--upnp`). NAT-PMP fica fora do MVP.
- **Firewall do Windows:**
  - Na primeira escuta, o Windows pergunta "Permitir acesso" para o GhostLink e para o `livekit-server.exe`. O Hospedar orienta a marcar as redes privadas e públicas.
  - O botão **"Corrigir firewall"** roda `netsh advfirewall firewall add rule … program=<caminho>` elevado (UAC).
  - O app detecta quando o firewall está bloqueando e explica.
- **Firewall do macOS:** se estiver ligado, o macOS pergunta. O guia explica.
- **`public_addresses`:** IP WAN (quando não é CGNAT), IP da LAN e VPNs (Radmin `26.0.0.0/8`, Tailscale `100.64.0.0/10`, ZeroTier pelo nome da interface).
- **Aviso de banda:** 13 pessoas com câmera exigem cerca de 20–25 Mbps de upload do host. Nesse caso a VPS é recomendada.

### 8.6 Atrás de um proxy TCP (Railway e parecidos)

Algumas plataformas de nuvem só expõem um serviço por HTTP ou por um proxy TCP, **sem UDP**. O Railway permite **um** proxy TCP por instância: um endereço externo aleatório (ex.: `altaria.proxy.rlwy.net:25889`) ligado a uma porta interna (7700). Para isso existe o **modo proxy** (`--proxy <host:porta>`, com o endereço externo do proxy). Nele, a porta pública carrega tudo.

**Uma porta, dois protocolos.** O primeiro byte de cada conexão decide:
- `0x16`, um registro de handshake TLS: a conexão vai para o servidor HTTPS/WSS de sempre, sem nenhum byte lido. O prazo do handshake e os limites de §13 continuam valendo.
- `0x00` a `0x02`: ICE-TCP (RFC 4571). A conexão começa com os 2 bytes do tamanho de um STUN binding request, que o LiveKit lê em até 512 bytes. Ela é encaminhada para a porta ICE-TCP do LiveKit em `127.0.0.1`, com backpressure nos dois sentidos, e sem Nagle. Quando um lado fecha, o outro fecha junto.
- Qualquer outro byte fecha a conexão na hora, e quem não envia nada em 5 s também é desconectado.
- Antes dessa decisão, cada socket já conta para o limite total de §13. Depois, no máximo 1024 conexões ICE-TCP ficam abertas ao mesmo tempo. Sem voz no ar, o ICE-TCP é recusado.

**LiveKit atrás do proxy.** O `livekit.yaml` muda assim (chaves conferidas no `rtcconfig` do LiveKit 1.13.7):
- `rtc.tcp_port` é a porta **externa** do proxy (ex.: 25889). O LiveKit escuta nela dentro do contêiner e a anuncia nos candidatos ICE-TCP. O proxy leva essa porta até a 7700, e a 7700 encaminha o ICE-TCP para `127.0.0.1:25889`. Por isso a porta externa precisa ser diferente de `--port`; se forem iguais, a voz fica indisponível e o log explica.
- `rtc.node_ip` é o IPv4 do host do proxy. Ele é resolvido no início e de novo a cada 5 min, e uma mudança reinicia o LiveKit quando ninguém está em voz, como em §8.1. Se o nome não resolver, o LiveKit sobe com o IP da máquina e troca quando o nome resolver. Um `--node-ip` explícito continua ganhando.
- `rtc.force_tcp: true`: o LiveKit não abre nenhum socket UDP, porque nada chegaria nele. O cliente só recebe candidatos TCP e não perde tempo tentando UDP.
- `rtc.enable_loopback_candidate: true` e `rtc.ips.includes: ["127.0.0.1/32"]`: o único candidato é o de loopback, que o `node_ip` reescreve para o IP do proxy. O mux TCP do pion acha cada conexão pelo endereço local em que ela chegou, e o encaminhamento chega por `127.0.0.1`. Sem isso, a conexão encaminhada não casaria com nenhum agente ICE, e os IPs internos do contêiner, inúteis para o cliente, seriam anunciados.
- `use_external_ip: false`, e `advertise_internal_ip` fica desligado.
- A sinalização (`/rtc`) passa pela mesma porta, dentro do TLS, como sempre.
- **Limitação:** toda a mídia vai por TCP. Com perda de pacotes, a latência sobe mais do que com UDP, porque um pacote perdido segura os seguintes.

## 9. Modo Hospedar (no app)

**Processo do servidor**
- Depois de `app.whenReady()`, o app roda `utilityProcess.fork(serverEntry, ['--data', dataDir, '--port', String(port), '--upnp'], { stdio: 'pipe', serviceName: 'GhostLink Server' })`.
  - O segundo argumento **precisa ser um array**.
  - `stdio: 'pipe'` alimenta o buffer de logs (500 linhas).
- **Controle** via `process.parentPort`:
  - `{ cmd: "status" }`, `{ cmd: "logs" }`, `{ cmd: "invite", maxUses?, expiresInHours? }` e `{ cmd: "shutdown" }`.
  - O servidor inicia no próprio `fork`. "Reiniciar" é `shutdown` seguido de um `fork` novo.
- **Parar:**
  - Com `shutdown`, o servidor fecha HTTP/WS, encerra o LiveKit e o SQLite, desfaz os mapeamentos UPnP e chama `process.exit(0)`.
  - `child.kill()` só entra como fallback depois de 5 s. No Windows ele é `TerminateProcess`, e nenhum handler roda.

**Comportamento**
- **Dados:** ficam em `<userData>/hosted/<serverSlug>/`. É um servidor hospedado por vez.
- **Auto-entrada:** o app lê o código de setup, conecta em `127.0.0.1:<porta>` com o pin recém-gerado e vira dono. Funciona mesmo que o UPnP falhe.
- **Hospedar não depende de estar conectado:** o servidor continua rodando enquanto o host conversa em outro servidor.
- **Bandeja (Windows) e barra de menus (macOS):**
  - Fechar a janela com o servidor ativo mantém o app rodando. Na primeira vez, o app avisa.
  - "Sair" para o servidor e o LiveKit.
- **Iniciar com o sistema:** opcional, desligado por padrão.
- **Atualização:** o servidor vem embutido no app. Atualizar o app atualiza o servidor, com alguns segundos fora do ar.
- **Migrar para VPS:** o guia explica como copiar a pasta de dados. Isso preserva o certificado (e com ele o `serverKeyId`), as identidades e os convites.

## 10. Servidor standalone (VPS)

**CLI** (saída em inglês)
- `ghostlink-server start --data <dir> [--port 7700] [--name "..."] [--node-ip <ip>] [--public-address host:porta]… [--upnp] [--proxy host:porta]`
  - `--proxy` liga o modo proxy (§8.6) com o endereço externo do proxy TCP. Sem `--public-address`, esse endereço também vai nos convites.
- `ghostlink-server invite [--max-uses N] [--expires 24h]`
- `ghostlink-server setup-code`, `reset-owner`, `status` (versão e impressão digital) e `version`.

**`scripts/install.sh`** (Ubuntu 22.04+ ou Debian 12+, como root). É idempotente: rodar de novo **atualiza**.
1. Instala o Node 24.x mais recente via NodeSource.
2. Cria o usuário de sistema `ghostlink`.
3. Baixa o `ghostlink-server-<versão>.tgz` da release mais recente (`releases/latest`) e o confere de duas formas:
   - pelo `checksums-sha256.txt`;
   - pela **assinatura Ed25519 da release** (§15), com `openssl`.
   Se o `cosign` estiver instalado, também confere o bundle Sigstore.
4. Instala em `/opt/ghostlink` e baixa o LiveKit Linux, conferindo o SHA-256. Os dados ficam em `/var/lib/ghostlink`.
5. Descobre o IP público pelo endereço de origem da rota padrão (`ip -4 route get 1.1.1.1`, que só consulta a tabela de rotas e não envia nenhum pacote).
   - Se o IP for privado, pede o IP ao usuário ou aceita `--node-ip`.
   - Grava `node_ip` e `public_addresses`.
6. Cria a unit `systemd` com `User=ghostlink`, `Restart=always`, `NoNewPrivileges=true`, `ProtectSystem=strict`, `StateDirectory=ghostlink`, `ProtectHome=true`, `PrivateTmp=true` e `LimitNOFILE=65536`.
7. Abre as portas no `ufw`, se estiver ativo.
8. Imprime o código de setup, a impressão digital e um convite.

**Guia:** `docs-site/hospedar-em-vps.md`, em pt-BR e em inglês.

## 11. Interface

**Visual e sons**
- Tema escuro quase preto (`#0b0d10` a `#161a20`), cor primária **blurple igual à do Discord** (`#5865F2`, hover `#4752C4`, texto branco por cima) e vermelho para ações destrutivas. Decisão do dono em 2026-09-28: nada de verde-água.
- Fonte Inter embutida e tokens em CSS vars.
- **Ícone e logo:** um **fantasma** (decisão do dono em 2026-09-28), em arte original SVG. Fantasma branco clássico (topo arredondado, barra ondulada, olhos escuros) sobre um quadrado arredondado em blurple `#5865F2`. É o mesmo símbolo no app, no instalador, na bandeja e no site.
- Sons originais sintetizados por `scripts/gen-sounds.mjs`.
- Selo "beta" visível enquanto a versão for `0.x`.

**i18n**
- Arquivos `i18n/pt-BR.ts` e `i18n/en.ts`, com chaves tipadas. Uma chave faltando quebra o typecheck.
- O idioma inicial vem de `app.getLocale()`: `pt*` vira pt-BR, qualquer outro vira en. Dá para trocar nas configurações.
- Datas e números usam `Intl`.
- Os códigos de erro do servidor são traduzidos no cliente.

### 11.1 Telas

1. **Onboarding:**
   - boas-vindas ("sem conta, sua chave fica neste dispositivo");
   - idioma e apelido;
   - aviso de backup, com "Exportar agora";
   - escolher entre **Entrar num servidor** e **Hospedar um servidor**.
2. **Entrar:**
   - colar o link, o `GL1-` ou `host:porta`;
   - TOFU com a impressão digital (§3.3), quando não veio de convite;
   - senha ou convite, se o servidor pedir;
   - apelido para esse servidor.
3. **Hospedar:**
   - formulário: nome, porta, modo de entrada (padrão: convite), limite de membros e limite de upload;
   - progresso: certificado, LiveKit, UPnP e firewall;
   - painel: convite com botão copiar (`webLink`), impressão digital, endereços, status de portas/CGNAT/firewall, logs, e parar/reiniciar.
4. **Principal** (4 colunas):
   - **servidores salvos:** barra com o botão **+** e um indicador de qual está hospedado;
   - **canais:**
     - nome do servidor, com o menu de admin e "Convidar pessoas";
     - canais de texto com contador de não lidas e de menções;
     - canais de voz com os participantes;
     - painel do usuário;
   - **centro:** o chat ou o **palco da voz**;
   - **membros:** agrupados por cargo com `hoist`, depois online e offline.
5. **Mensagens:**
   - agrupadas por autor quando enviadas com menos de 5 min de intervalo;
   - markdown leve, com parser próprio que gera **elementos React, nunca HTML**;
   - links externos abrem no navegador, com confirmação;
   - imagens com lightbox, vídeo e áudio com player, e arquivos em card (o download sempre pergunta onde salvar);
   - arrastar e soltar e Ctrl/Cmd+V com barra de progresso.
6. **Configurações do servidor:**
   - visão geral: nome, ícone, modo de entrada, senha, limites e cota;
   - canais;
   - cargos: permissões com descrição, cor, ordem por arrastar e `mentionable`;
   - membros;
   - convites: criar, listar e revogar;
   - banidos;
   - transferir a posse;
   - recuperar a posse (só no Hospedar).
7. **Configurações do usuário:**
   - perfil;
   - voz e vídeo: dispositivos, medidor, limiar, push-to-talk e tecla, teste de câmera;
   - notificações;
   - idioma;
   - identidade: exportar, importar, ver o ID e apagar deste dispositivo;
   - servidores: sair de um servidor, com a opção de apagar as próprias mensagens;
   - atualizações: checagem automática, ligada por padrão;
   - sobre: versão e licença GPL-3.0.
8. **Notificações do sistema:** menções e respostas. Clicar abre o canal.

### 11.2 Estado no renderer

- Stores `zustand` por domínio: `connection`, `server`, `channels`, `messages`, `members`, `voice`, `ui` e `settings`.
- Redutores puros e testáveis.
- As configurações locais ficam em JSON dentro de `userData`.

## 12. Segurança do app Electron

**Janela e carregamento**
- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` e `webSecurity: true`.
- Preload com API mínima e tipada.
- Em produção, o renderer é servido pelo **protocolo próprio `app://ghostlink/`**, nunca por `file://`.
  - O esquema é registrado com `protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }])`.
  - `protocol.handle` só serve arquivos que estão dentro do asar.
- **CSP:** `default-src 'self'; img-src 'self' https: blob: data:; media-src 'self' https: blob:; connect-src 'self' https: wss:; style-src 'self' 'unsafe-inline'; script-src 'self'`.
  - O que de fato restringe o carregamento é o pin da sessão e o fato de o conteúdo dos usuários nunca virar HTML nem embed.

**Navegação e IPC**
- `app.on('web-contents-created')` aplica a todos os webContents:
  - bloqueio de `will-navigate`;
  - `setWindowOpenHandler` negando tudo;
  - `will-download` sempre abrindo o diálogo de salvar, sem nunca abrir o arquivo sozinho.
- Links externos só abrem com `shell.openExternal`, com confirmação e apenas para `http`/`https`.
- **Todo handler de IPC** confere `event.senderFrame` (frame principal e origem do app) antes de validar com zod.

**Permissões do navegador**
- `setPermissionRequestHandler` libera **só `media`**, e só quando a origem é a do app: `new URL(url).origin === 'app://ghostlink'`, ou a origem do dev server em desenvolvimento.
  - Nunca comparar a URL inteira.
  - Todo o resto é negado.
  - `media` cobre microfone, câmera e o `getDisplayMedia` (que chega com `mediaTypes: []`).
- `setPermissionCheckHandler` segue a mesma regra e permite `media` e `speaker-selection`.

**Links profundos**
- **Instância única:** `app.requestSingleInstanceLock()` no início. Se o lock falhar, o app sai.
- **Windows:**
  - `app.setAsDefaultProtocolClient('ghostlink', process.execPath, args)` registra em HKCU, sem precisar de admin. Em dev, `args = [path.resolve(process.argv[1])]`.
  - O link chega em `process.argv` e no `argv` do `second-instance`. O app procura o item que começa com `ghostlink://`.
  - O desinstalador apaga a chave: `nsis.include: build/installer.nsh` com `customUnInstall` → `DeleteRegKey HKCU "Software\Classes\ghostlink"`.
- **macOS:** `protocols` no electron-builder e o evento `open-url`.
- **Validação:**
  - Todo link passa por zod: no máximo 8 endereços, até 2 KB e portas de 1 a 65535.
  - O `n` é só uma dica. A confirmação mostra "Convite para <n> (nome informado pelo link)", os endereços e o começo do `serverKeyId`.
  - Depois de conectar, vale o nome que vem no `welcome`.
  - Enquanto um diálogo de convite estiver aberto, links novos são ignorados.

**Build**
- Os fuses são aplicados pelo próprio electron-builder (`electronFuses`), logo antes de assinar:
  - `runAsNode: false`
  - `enableNodeCliInspectArguments: false`
  - `enableNodeOptionsEnvironmentVariable: false`
  - `onlyLoadAppFromAsar: true`
  - `enableEmbeddedAsarIntegrityValidation: true` (vale no Windows e no macOS; o hash é gravado automaticamente)
  - `grantFileProtocolExtraPrivileges: false`
- Nada pode alterar o `app.asar` depois do empacotamento.
- `runAsNode: false` não afeta o `utilityProcess`.
- **Ganchos de teste** (`GHOSTLINK_E2E_PICK`, `GHOSTLINK_USER_DATA`, `GHOSTLINK_SMOKE`): só são lidos quando `!app.isPackaged`. A exceção é `GHOSTLINK_SMOKE`, que também funciona empacotado, mas só faz abrir, checar e sair.

## 13. Rate limits e robustez

| Área | Limite |
|---|---|
| Antes do TLS | Handshake TLS em até 10 s · no máximo 4096 sockets TCP abertos no total e 64 por IP (IPv6 agrupado por /64), contados da conexão ao fechamento, inclusive depois de autenticar · o socket que passa do limite é fechado na hora |
| Pré-autenticação | `hello` em até 5 s · `auth.proof` em até 10 s · no máximo 256 conexões não autenticadas no total · 20 conexões por IP · `scrypt` com no máximo 2 simultâneos |
| Autenticação | Falhas por IP: 10/min (sucessos não contam; um membro que entra só com a chave, sem código de setup, nunca é barrado, porque não tem nada a adivinhar) · desafios pendentes por IP: 5 · IPv6 agrupado por /64 |
| Membros novos | 5 identidades novas por IP por hora, em qualquer modo de entrada |
| Chat | `msg.send`: 5 a cada 5 s por usuário, com rajada de 10 · `typing`: 1 a cada 3 s · `msg.react`: 10 a cada 5 s |
| Voz e perfil | `voice.join`: 5 a cada 10 s · `profile.update`: 5/min |
| Geral | `upload.begin`: 10/min · requisições gerais: 30/s por sessão · `invite.create`: 10/h por usuário |
| Upload | Corpo cortado ao passar de `size` · 3 uploads simultâneos por sessão · 60 s sem progresso derruba a conexão |
| Tamanhos | Frame de 256 KiB · mensagem de 4000 caracteres · 10 anexos · apelido de 1 a 32 caracteres visíveis · nome de canal com até 100 |

**Atrás de um proxy TCP (§8.6)**
- Todo cliente chega pelo endereço do proxy, e o proxy TCP do Railway não oferece o PROXY protocol (v1/v2): nenhum cabeçalho com o IP real chega ao servidor. Um limite por IP valeria para todos juntos. Por isso, no modo proxy, os limites por IP viram limites do servidor inteiro, dimensionados para ele:
  - sockets TCP: 4096 no total (o limite de 64 por IP deixa de existir);
  - pré-autenticação: 256 conexões não autenticadas no total e até 256 desafios pendentes;
  - falhas de autenticação: 100/min no servidor inteiro, e um membro que entra só com a chave continua nunca sendo barrado;
  - membros novos: 30 identidades novas por hora no servidor inteiro;
  - o `last_ip` não é gravado, porque seria o do proxy. Banir por IP deixa de ter efeito, e o ban por identidade continua.
- O servidor registra no log, uma vez na inicialização, que o modo proxy está ligado e quais limites valem.
- **Trade-off:** quem abusa atinge todo mundo. Pode ocupar as 256 conexões pré-autenticação, esgotar as 100 falhas por minuto ou as 30 entradas por hora e atrasar a entrada de gente nova. Os membros existentes continuam entrando. A força bruta continua impraticável: os códigos de convite têm 50 bits, o `scrypt` roda no máximo 2 por vez e as falhas têm teto global.

**Reconexão do cliente**
- Backoff exponencial de 1 a 30 s, com jitter.
- O status aparece no painel do usuário.
- O `welcome` substitui todo o estado, e cada canal aberto recarrega a última página.

## 14. Testes

| Nível | O que cobre | Ferramenta |
|---|---|---|
| Unidade (`shared`) | Schemas, permissões, hierarquia e posições fixas dos bits · `livekitPermission` (nunca lista vazia com `canPublish`) · convite e deep link (limites) · HKDF → Ed25519 com vetores fixos · mensagem de autenticação · normalização de apelido e regex de emoji · compatibilidade de protocolo | vitest |
| Unidade (desktop) | Redutores · parser de markdown com tentativas de injeção e entradas patológicas (ReDoS) · agrupamento · paridade das chaves de i18n · extração do deep link do argv · **falha ao decifrar a identidade nunca gera seed nova** · URLs assinadas | vitest |
| Integração (servidor) | Servidor real em porta aleatória, com pasta temporária e clientes `ws` com pin. Cobre:<br>• handshake e todos os erros, prazos de pré-autenticação<br>• modos de entrada, convites (inclusive corrida de consumo e `max_members`), setup code dispensando convite, transferir e recuperar a posse<br>• chat, histórico, edição, exclusão (apagando os anexos), reações, menções e não lidas<br>• cargos e hierarquia<br>• **nenhum vazamento de canal privado**: snapshot, broadcasts, histórico, arquivos e URLs assinadas, `voice.state`, digitação, resposta citando canal privado, anexo reaproveitado de outro canal, mover para canal privado<br>• upload: magic bytes, dimensões, limites, token de uso único, corte do corpo<br>• rate limits · sessão substituída · expulsão (sem convite novo não volta) · ban · `server.leave`<br>• **o proxy `/rtc*` recusa quem foi removido e aceita os tokens de renovação**<br>• portas ocupadas · UPnP contra um IGD falso · backup antes de migrar e recusa de downgrade | vitest |
| Integração LiveKit | `livekit-server` real, pulado se não houver binário. Roda no Windows, no Linux **e no macOS**, depois que o build darwin existir. Cobre:<br>• a config gerada inicia em modo estrito<br>• tokens com as fontes certas<br>• webhooks atualizam `voice.state`<br>• o server mute tira o microfone do ar<br>• `removeParticipant` combinado com o proxy impede a volta<br>• reconciliação com `listRooms` | vitest |
| Carga | 14 participantes sintéticos publicando áudio por 5 min (`livekit-cli load-test`, com tokens emitidos pelo servidor), sem perda de faixas | script `npm run test:load` |
| Ponta a ponta | 3 instâncias de Electron (build de dev), cada uma com `GHOSTLINK_USER_DATA` próprio, e `--use-fake-device-for-media-stream` (**sem** `--use-fake-ui-for-media-stream`). A escolha da tela usa `GHOSTLINK_E2E_PICK=first`. Cenário:<br>• A hospeda; B e C entram pelo convite<br>• conversa e imagem<br>• todos entram na voz e as faixas de áudio chegam<br>• C liga a câmera; A compartilha a tela e B clica em Assistir<br>• o canal privado não aparece para C<br>• A expulsa C, que não volta sem convite novo | Playwright `_electron` |
| Smoke do pacote | O app empacotado abre com `GHOSTLINK_SMOKE=1` e sai com código 0 depois do `did-finish-load` e de iniciar e parar o `livekit-server`, com timeout de 60 s. Roda no Windows e no macOS arm64. Não usa Playwright: o fuse `EnableNodeCliInspectArguments=false` bloqueia o `--inspect` de que ele depende. | CI |
| Manual | `docs/checklist-teste.md`: internet sem VPN, Radmin, VPS · call com mais de 12 pessoas · tela 1080p60 durante um jogo · push-to-talk com o jogo em foco · Mac real (permissões, Chaveiro, Gatekeeper) | — |

**Ambiente:**
- Os scripts de dev e de e2e removem `ELECTRON_RUN_AS_NODE`, que o VS Code injeta. No Playwright: `env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }`.
- `GHOSTLINK_USER_DATA` é aplicado com `app.setPath('userData', …)` **antes** do `requestSingleInstanceLock()`, porque o lock é por pasta.
- No CI do macOS, o job cria e desbloqueia um keychain temporário antes do smoke test.
- `npm test` roda unidade e integração. `npm run test:e2e` roda o ponta a ponta.

## 15. Build, distribuição e atualização

**electron-builder (versão fixada)**
- `npmRebuild: false` é **obrigatório**. O `@electron/rebuild` não reconhece o prebuild do `uiohook-napi` e tentaria compilar com MSVC. Nunca usar `install-app-deps`.
- `appId: app.ghostlink.desktop` e `productName: GhostLink`.
- **Windows:**
  - `win.target: ["nsis"]`, com `publisherName` definido.
  - `nsis: { oneClick: true, perMachine: false, artifactName: "${productName}-Setup-${version}.${ext}", include: "build/installer.nsh" }`.
- **macOS:**
  - `mac.target: [{ target: "dmg", arch: ["arm64", "x64"] }]`, as duas arquiteturas no mesmo job (`--mac --arm64 --x64`).
  - `dmg.artifactName: "${productName}-${version}-mac-${arch}.${ext}"`.
  - Sem `zip`: ele só serviria ao Squirrel.Mac, que não funciona sem Developer ID. O `latest-mac.yml` sai do próprio DMG.
  - `mac.minimumSystemVersion: "13.0"`.
  - Assinatura **ad-hoc** com `mac.identity: "-"`. **Não** usar `null`: isso pula a assinatura, e o binário alterado pelos fuses deixa de abrir.
  - `hardenedRuntime: true`, com `entitlements` e `entitlementsInherit` em `build/entitlements.mac.plist`: `cs.allow-jit`, `cs.allow-unsigned-executable-memory`, `cs.disable-library-validation` (obrigatório com ad-hoc), `device.audio-input` e `device.camera`. O arquivo **substitui** o template padrão.
- `extraResources: [{ from: "resources/livekit/${os}-${arch}", to: "livekit" }]`.
  - Em tempo de execução: `path.join(process.resourcesPath, 'livekit', process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server')`.
  - Não usar `${platform}`, que é a plataforma do host de build.
- `electronFuses` conforme a §12.
- Os builds rodam com `--publish never`. Os arquivos `latest.yml`, `latest-mac.yml` e `*.blockmap` são gerados mesmo assim.

**Atualização (`electron-updater`, provider GitHub, versão fixada)**
- Configuração:
  - `const auto = process.platform === 'win32'`
  - `autoDownload = auto`, `autoInstallOnAppQuit = auto`
  - `allowPrerelease = false`, `disableWebInstaller = true`
- **Windows:**
  - Baixa em segundo plano e mostra "Reiniciar para atualizar".
  - `autoUpdater.verifyUpdateCodeSignature` recebe uma **função própria**: confere a assinatura Ed25519 destacada do instalador (`<instalador>.ed25519`, publicada na release) contra a chave pública embutida em `shared/constants.ts`.
  - Se a verificação falhar, a atualização não é instalada e a pessoa é avisada.
  - Sem isso, o updater hoje só confere o SHA-512 do `latest.yml`, que vem da mesma release, e o electron-builder v28 passa a recusar builds sem `publisherName`.
- **macOS:** só avisa. No `update-available`, mostra "Versão X disponível" com link para a release.
  - O Squirrel.Mac não serve: numa assinatura ad-hoc, o requisito designado é o cdhash, que muda a cada build.
- **Frequência:** a checagem roda na abertura e a cada 6 h, e pode ser desligada. É o único acesso do app a terceiros.

**Chave de release (Ed25519)**
- A chave privada fica num **GitHub Environment `release`**, com revisão manual obrigatória.
- O `scripts/sign-release.mjs` assina cada instalador, DMG e `.tgz`.
- A chave pública fica em `shared/constants.ts` e no `install.sh`.

**Assinatura de código (fora do MVP)**
- **Windows:** o SmartScreen avisa ("Mais informações → Executar assim mesmo").
- **macOS 13 e 14:** botão direito → Abrir.
- **macOS 15 ou mais novo:** abrir o app, fechar o aviso e ir em Ajustes do Sistema > Privacidade e Segurança > "Abrir Mesmo Assim". Alternativa pelo Terminal: `xattr -dr com.apple.quarantine /Applications/GhostLink.app`.
- **Efeito da assinatura ad-hoc no macOS:** a cada atualização, o sistema pode pedir de novo Microfone, Câmera, Gravação de Tela, Acessibilidade e a senha do Chaveiro para "GhostLink Safe Storage". O app nunca recria a identidade por causa disso (§3.1).
- **Próximos passos:** Azure Trusted Signing no Windows e Apple Developer ID com notarização no macOS.

**Confiança nos downloads**
- O CI gera o `checksums-sha256.txt` e assina com **cosign keyless**:
  - `cosign sign-blob --yes --bundle checksums-sha256.txt.sigstore.json checksums-sha256.txt`;
  - `sigstore/cosign-installer`, fixado por SHA (v4.1.2, que instala o cosign v3);
  - `permissions: { contents: write, id-token: write }`.
- **Verificação**, documentada no site: `cosign verify-blob checksums-sha256.txt --bundle checksums-sha256.txt.sigstore.json --certificate-identity "https://github.com/<dono>/ghostlink/.github/workflows/release.yml@refs/tags/v<versão>" --certificate-oidc-issuer https://token.actions.githubusercontent.com`, seguido de `sha256sum --ignore-missing -c` (no Windows, `Get-FileHash`).

**CI (GitHub Actions)**
- **Regras gerais:** actions fixadas por SHA, `permissions` mínimas por job e tags `v*` protegidas por ruleset.
- **`ci.yml`** (push e PR):
  - typecheck, lint, unidade e integração em `windows-latest`, `ubuntu-latest` e `macos-latest`;
  - e2e em `windows-latest`;
  - empacotamento e smoke test em `windows-latest` e `macos-latest`.
- **`release.yml`** (tag `v*`, no environment `release`):
  - build Windows;
  - build macOS (arm64 + x64, com o LiveKit darwin compilado);
  - `ghostlink-server-<versão>.tgz` no `ubuntu-latest`;
  - assinaturas Ed25519, checksums e cosign;
  - um job final roda `gh release create v<versão> --latest --notes-file release-notes/<versão>.md` e anexa instaladores, DMGs, `latest*.yml`, `*.blockmap`, `.tgz`, `.ed25519`, `checksums-sha256.txt` e `.sigstore.json`.
- **`docs.yml`** (push na `main`): build do VitePress e deploy no Pages.

**Versões**
- SemVer, começando em `0.1.0`. O `protocol` do handshake é versionado à parte.
- Enquanto for `0.x`, o app e o site mostram o selo "beta", mas **as releases do GitHub são publicadas como normais**: não são pre-release nem draft, e são marcadas como *latest*.
  - Motivo: a API `releases/latest` (usada pela página de download e pelo `install.sh`) e o `electron-updater` ignoram pre-releases e drafts.
  - "Pre-release" fica só para tags com sufixo (`v0.3.0-rc.1`), que ninguém recebe automaticamente.

**Repositório**
- Esta pasta.
- A publicação no GitHub, e em qual conta, é decidida na etapa 9.
- `.gitignore`: `node_modules`, `dist`, `out`, `resources/livekit/`, dados de teste e `.env`.

## 16. Site (VitePress)

- **Local e versão:** `docs-site/`, com VitePress 1.6.4.
- **`base`:** `'/ghostlink/'`, porque é um site de projeto em `<dono>.github.io/ghostlink/`. Passa a ser `/` se houver domínio próprio.
- **Idiomas:** `locales: { root: { label: 'Português', lang: 'pt-BR' }, en: { label: 'English', lang: 'en-US', link: '/en/' } }`.
- **Busca:** local, com as traduções em `search.options.locales`.
- **Tema:** claro e escuro.
- **Deploy:** `docs.yml`, usando `actions/configure-pages@v6`, `actions/upload-pages-artifact@v5` e `actions/deploy-pages@v5`, com `permissions: { contents: read, pages: write, id-token: write }` e a fonte do Pages configurada como "GitHub Actions".
- **Páginas:**
  - **Início:** hero, cards (Usar, Hospedar, Privacidade) e capturas de tela.
  - **Download:** chama a API `releases/latest` em `onMounted` e mostra o botão certo para o sistema da pessoa. Se falhar, mostra o link da página de releases.
  - **Convite (`/j/`):** ver §3.5.
  - **Guias:** Primeiros passos, Entrar, Usar, Configurações.
  - **Hospedar no app:** portas, UPnP, firewall, CGNAT e VPNs.
  - **Hospedar em VPS.**
  - **Cargos, permissões e convites.**
  - **Privacidade e segurança**, explicando o modelo de ameaça sem rodeios:
    - o host vê texto, mídia e o IP de todos;
    - hospedar expõe o seu IP a quem tem o convite;
    - a atualização no Windows confia no GitHub, no CI e na chave de release;
    - os IDs de mensagem revelam o volume total.
  - **Verificar downloads.**
  - **Solução de problemas**, incluindo as permissões do Mac.
  - **Arquitetura.**
- **Capturas de tela:** feitas com dados fictícios.
- **Sem trackers.**

## 17. Etapas de implementação

Cada etapa termina funcionando, testada e com commit. Os riscos de empacotamento e de CI entram **cedo**.

1. **Fundação**
   - Workspaces e `shared` (envelope, erros, schemas, auth, convite, versão, `CRYPTO_LABELS`).
   - Servidor com TLS, `/health` e as rotas `/`.
   - CLI mínima (`start` e `invite`).
   - Convites com consumo atômico, handshake completo com os modos de entrada e o setup code.
   - Prazos e rate limits de pré-autenticação e de autenticação.
   - Electron com o protocolo `app://`, identidade via safeStorage (incluindo o caminho de falha ao decifrar), conexão com pin/TOFU/múltiplos endereços e reconexão.
   - i18n pt-BR/en, onboarding e tela de entrar.
   - `ci.yml` em Windows, Linux e macOS.
   - **Esqueleto de empacotamento:** NSIS e DMG ad-hoc com fuses gerados no CI, com o smoke test.
2. **Chat:** canais, mensagens, histórico, presença, membros, digitação, edição, exclusão, respostas, reações, menções e não lidas; markdown seguro; rate limits de chat; normalização de apelido; primeiro e2e (2 instâncias conversando).
3. **Cargos, convites e moderação:** permissões, hierarquia, canais privados com todas as regras de referência cruzada, gestão de convites, expulsão, ban, `server.leave`, transferir e recuperar a posse, e as telas de configuração do servidor.
4. **Arquivos:** upload e download, URLs assinadas, imagens, vídeos, avatares, ícone, limites de dimensão, cotas e limpeza.
5. **Voz:**
   - `fetch-livekit.mjs` e `build-livekit-darwin.sh`, com os testes de integração do LiveKit também no macOS;
   - portas internas dinâmicas, config e supervisão do processo;
   - proxy `/rtc*` autorizado, tokens e `livekitPermission`, webhooks e reconciliação;
   - entrar e sair, mutar e ensurdecer, indicador de quem fala, dispositivos e volume por pessoa;
   - server mute e mover;
   - teste de carga.
6. **Vídeo e tela:** câmera com simulcast, grade, seletor de tela próprio, presets, "Assistir", tela cheia e permissões do macOS.
7. **Hospedagem:** modo Hospedar (utilityProcess), UPnP próprio, `node_ip`/CGNAT/`public_addresses`, portas ocupadas, firewall, bandeja, CLI completa e `install.sh`.
8. **Acabamento do app:** notificações, sons, backup e importação da identidade, push-to-talk global (com Acessibilidade no Mac), deep links, apagar a identidade, aviso de servidor desatualizado, e2e completo e `docs/checklist-teste.md`.
9. **Distribuição:** `electron-updater` com verificação Ed25519, chave de release e environment, `release.yml` com checksums e cosign, site VitePress pt/en (com `/j/`), README, CONTRIBUTING e SECURITY, e publicação no GitHub.

## 18. Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Host atrás de CGNAT (comum em operadoras brasileiras) | Detectar pelo IP WAN do UPnP, avisar e recomendar VPN ou VPS |
| Upload do host insuficiente para calls grandes com vídeo | Aviso na tela de hospedagem, simulcast, adaptive stream e recomendação de VPS |
| SmartScreen, Gatekeeper ou antivírus bloqueando binários não assinados | Instruções no site, checksums com Sigstore, assinatura Ed25519 própria; assinatura paga como próximo passo |
| Sem binário oficial do LiveKit para macOS | Compilar no CI (`macos-latest`, com cgo) a partir da tag, conferindo o commit fixado; dependências conferidas pelo `go.sum` |
| Testes no macOS limitados (o dev usa Windows) | CI com smoke test e integração do LiveKit no `macos-latest`; checklist manual para um testador com Mac |
| Comprometimento da conta do GitHub ou do CI | Environment com revisão manual, tags protegidas, actions fixadas por SHA; o updater exige a assinatura Ed25519 da chave de release |
| Mudanças no LiveKit, que é estrito com o YAML | Versão fixada e testes de integração com o binário real |
| `node:sqlite` ainda não é estável | RC (Stability 1.2) desde o Node 24.15; o wrapper isola a API |
| Pin por hostname no renderer, sem porta | Só o pin do servidor conectado; WSS principal com pin exato no main; cache de verificação desligado |
| Perda da identidade (sem backup, Chaveiro negado, `Local State` apagado) | Falha ao decifrar nunca sobrescreve; avisos de backup; importação de `.ghostkey` |
| Abuso em servidores públicos (identidades são grátis) | Convite como padrão, CREATE_INVITES só para admins, limites de identidades novas por IP, ban por identidade e IP, bloqueio temporário após expulsão |
| Nome "GhostLink" já usado por outros apps, inclusive o "GhostLink Chat" (videoconferência) | O dono aceitou o risco em 2026-09-27. Strings criptográficas congeladas (§3.6); `appId` fixo desde a 0.1.0 |
