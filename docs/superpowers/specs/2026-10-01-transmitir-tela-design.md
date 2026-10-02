# GhostLink — Transmitir a tela

Desenho aprovado pelo dono em 2026-10-01. Detalha e muda a seção "Tela" da spec principal ([`2026-09-27-ghostlink-design.md`](2026-09-27-ghostlink-design.md) §8.4). Onde este documento não diz nada, vale a spec principal.

## 1. Decisões

| Tema | Decisão |
|---|---|
| Onde | Nos canais de voz dos servidores. Nas chamadas de DM dos amigos entra quando elas existirem. |
| Quem pode | Quem tem a permissão `VIDEO` no canal. Ela já vem ligada para `@todos`, e o servidor já libera as fontes `SCREEN_SHARE` e `SCREEN_SHARE_AUDIO` no token de quem a tem. Nada muda no servidor. |
| Som | **Imagem e som do PC.** Muda a spec principal, que deixava o áudio do sistema de fora. O som é o do sistema **sem o áudio do próprio GhostLink** (§4), para quem assiste não ouvir a chamada de novo. |
| Quem recebe | **Todos na chamada, sem clicar** (mudança do dono em 2026-10-02, v0.4.6: "ao compartilhar tela deve mostrar no quadrado e não apenas quando clica em assistir"). Quem não quiser clica em **Parar de assistir**. Cada pessoa assistindo é uma cópia a mais saindo do servidor de quem hospeda. |
| Qualidade | 720p30, **1080p30 (padrão)** ou 1080p60, com simulcast de 2 camadas. |
| Lançamento | Desenvolvido na branch `v0.2-screen`, a partir da `main`. Sai numa versão própria (v0.2.1), antes dos amigos, e depois é mesclado na `v0.3-friends`. |

**Fora:** câmera (continua na fase de vídeo da spec principal), som só do programa compartilhado (como o "áudio do app" do Discord), gravação, transmissão em chamadas de DM, macOS (ainda não há build; notas em §7).

## 2. Começar a transmitir

1. No painel de voz (o cartão do usuário enquanto está num canal de voz), o botão **Transmitir tela** abre o seletor. Sem a permissão `VIDEO`, o botão aparece desligado, com a explicação no título.
2. **O seletor** (modal no estilo do Discord):
   - abas **Telas** e **Janelas**, com miniatura (320×180) e nome; se a miniatura vier vazia, mostra o ícone da janela;
   - estado de carregando ao abrir, porque as miniaturas levam até uns 4 s no Windows;
   - **Qualidade:** 720p30, 1080p30, 1080p60;
   - **Conteúdo:** "Texto e apresentações" (`contentHint: 'detail'`) ou "Jogos e vídeo" (`contentHint: 'motion'`, com `degradationPreference: 'maintain-framerate'`);
   - a caixa **Transmitir o som do PC**, marcada por padrão;
   - **Transmitir** e **Cancelar**.
3. Transmitindo, o painel de voz mostra o selo "AO VIVO", uma miniatura do que sai e o botão **Parar transmissão**. Se a captura acabar sozinha (a janela fechou), a transmissão para e o painel volta ao normal.

Uma pessoa transmite uma tela por vez. Várias pessoas podem transmitir no mesmo canal.

## 3. Como a captura funciona

- **Fontes:** o renderer pede `screen.sources()` por IPC. O main chama `desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true })` e devolve `{ id, name, kind, thumbnail, icon }`, com as imagens como data URL PNG.
- **Escolha:** "Transmitir" chama `screen.choose({ sourceId, audio })`. O main guarda a escolha por **10 s**.
- **Captura:** em seguida o renderer pede a captura (`getDisplayMedia`, pelo LiveKit). O main atende em `session.setDisplayMediaRequestHandler`:
  - com uma escolha guardada e ainda válida, responde `{ video: <a fonte escolhida> }` e, se a escolha pediu som e o pedido também, `audio: 'loopback'`; a escolha é consumida;
  - sem escolha válida, ou se a fonte sumiu, recusa. O renderer recebe `AbortError`.
  - O callback é sempre chamado. `useSystemPicker` não é usado.
- O handler só atende o app (`app://ghostlink` ou o servidor de desenvolvimento), como os handlers de permissão que já existem (spec principal §12).

## 4. O som do PC sem eco

Medido em 2026-10-01 neste PC (Electron 44.4.5, Windows 11): com `audio: 'loopback'` puro, a captura inclui o áudio que o próprio GhostLink toca, ou seja, as vozes da chamada. Com a restrição `restrictOwnAudio: true` no pedido de áudio do renderer, o Chromium usa a captura do Windows que **exclui o processo de áudio do app**: o som do GhostLink cai ao nível do silêncio e o resto do PC continua.

- **Pedido de áudio:** `{ restrictOwnAudio: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false }`.
- **Conferência obrigatória:** depois de criada a faixa, `getSettings().deviceId` precisa ser `loopbackWithoutChrome`.
  - Se não for (por exemplo no Windows 10, onde a exclusão não é garantida), o app **descarta a faixa de som**, transmite só a imagem e avisa: "O som do PC precisa do Windows 11. Transmitindo só a imagem."
- **Publicação:** a faixa vai como `ScreenShareAudio`, em estéreo, sem DTX nem RED (é música e jogo, não voz).
- **Limite conhecido:** outro app aberto no mesmo PC (por exemplo uma segunda instância do GhostLink) não é excluído.

## 5. Assistir

- **Selo:** quem transmite aparece com "AO VIVO" na lista do canal de voz (o `voice.state` já traz `screen` por pessoa).
- **No palco de voz,** cada transmissão vira um quadro na grade, ao lado dos quadros das pessoas, **já com a imagem** (v0.4.6). O app assina as publicações `ScreenShare` e `ScreenShareAudio` de todo mundo na chamada (`setSubscribed(true)`) assim que aparecem, e também as que já existiam quando eu entrei.
- **Clicar no quadro** mostra a transmissão grande, com as outras pessoas numa fileira embaixo; **Voltar para a grade** desfaz.
- **No quadro e na transmissão grande:**
  - **tela cheia**;
  - o **volume da transmissão** (0–200%), separado do volume da voz daquela pessoa e salvo do mesmo jeito;
  - **Parar de assistir**: desassina as duas publicações e o quadro volta a mostrar o nome e o botão **Assistir**, que assina de novo.
- **Parar de assistir vale só para aquela transmissão.** O conjunto de quem eu parei de assistir fica no estado local e é respeitado em `TrackPublished`, inclusive depois de uma reconexão. Quando a pessoa para de transmitir (ou sai da chamada, segundo o `voice.state`), ela sai do conjunto, e a próxima transmissão dela aparece sozinha de novo.
- **Várias transmissões ao mesmo tempo:** cada uma no seu quadro da grade, e clicar numa mostra ela grande.
- A qualidade recebida se adapta ao tamanho do quadro e à conexão (`adaptiveStream` e simulcast, que o app já usa).

## 6. Presets

| Qualidade | Vídeo | Simulcast |
|---|---|---|
| 720p30 | `ScreenSharePresets.h720fps30` | uma camada menor, 360p |
| **1080p30** | `ScreenSharePresets.h1080fps30` | uma camada menor, 720p |
| 1080p60 | `new VideoPreset(1920, 1080, 8_000_000, 60)` | uma camada menor, 720p30 |

Sem preset explícito o LiveKit limita a tela a 15 fps.

## 7. macOS (sem build ainda; para quando houver)

- A captura de som existe (Core Audio taps no macOS 14.2+, ScreenCaptureKit no 13–14.1), e a mesma restrição exclui o próprio app.
- O `Info.plist` precisa de `NSAudioCaptureUsageDescription`, e a permissão de Gravação de Tela segue a spec principal.
- Há um problema aberto no Electron (#52738) com seletor próprio no macOS 26. A conferência de §4 cobre o caso: sem a faixa certa, transmite só a imagem.

## 8. Erros e avisos

| Caso | O que acontece |
|---|---|
| Cancelar o seletor | Nada; nenhum aviso. |
| A fonte sumiu entre a escolha e a captura | "Não foi possível capturar essa tela ou janela. Tente de novo." |
| Exclusão do som indisponível | Transmite só a imagem, com o aviso de §4. |
| Sem permissão `VIDEO` | Botão desligado. O servidor também recusaria a publicação. |
| Proxy TCP (Railway) | Funciona; em conexões ruins a imagem pode travar mais. Sem aviso específico nesta versão. |

## 9. Arquitetura no código

| Parte | Onde | Responsabilidade |
|---|---|---|
| Fontes e escolha | `apps/desktop/src/main/screenPicker.ts` | `listSources()`, a escolha com validade de 10 s, o handler de `setDisplayMediaRequestHandler`. Testável sem Electron (dependências injetadas). |
| IPC | `screen.sources`, `screen.choose` em `shared/ipcTypes.ts`, preload e `main/ipc.ts` | Esquemas zod estritos (`sourceId` no formato do `desktopCapturer`, `audio` booleano). |
| Publicar | `renderer/features/voice/screenShare.ts` | Criar as faixas com os presets e a restrição de som, conferir `deviceId`, publicar, parar, reagir ao fim da captura. |
| Assistir | `renderer/features/voice/` (sessão e estado) | Assinar sem clique, Parar de assistir e Assistir, respeitar depois de reconexões, volume da transmissão. |
| Interface | `renderer/features/voice/` | Seletor, botão e selo no painel, quadros no palco, tela cheia. |
| Textos | `renderer/i18n/voice.*.ts` | pt-BR e en. |

## 10. Testes

- **Unidade:**
  - a escolha com validade, consumida uma vez;
  - o handler que recusa sem escolha ou com origem errada;
  - a montagem das opções de captura e publicação por preset;
  - a decisão de descartar o som quando o `deviceId` não é `loopbackWithoutChrome`;
  - a assinatura sem clique (também das transmissões que já existiam ao entrar), e o "parei de assistir" respeitado depois de reconexão e esquecido quando a transmissão termina.
- **e2e** (Playwright `_electron`, dispositivos falsos): Ana hospeda, Bia entra, as duas entram na voz. Ana abre o seletor e escolhe a primeira tela. Bia vê o selo e, sem clicar, recebe vídeo com quadros decodificados no quadro da Ana; um clique mostra grande; ela para de assistir, a assinatura sai e o botão Assistir volta; Assistir traz a imagem de novo. O seletor próprio dispensa o `GHOSTLINK_E2E_PICK` da spec principal.
- **Manual** (`docs/checklist-teste.md`): um jogo com som durante uma chamada, e quem assiste ouve o jogo e não ouve a própria chamada de volta; 1080p60; Windows 10 transmitindo só a imagem com o aviso.
