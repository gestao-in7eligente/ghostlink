# GhostLink — Câmera nas chamadas

Desenho aprovado pelo dono em 2026-10-01. Detalha a parte "Câmera" da spec principal ([`2026-09-27-ghostlink-design.md`](2026-09-27-ghostlink-design.md) §8.4). Onde este documento não diz nada, ela vale.

## 1. Decisões

| Tema | Decisão |
|---|---|
| Onde | Canais de voz dos servidores. Chamadas de DM entram quando existirem (v0.3). |
| Quem pode | Quem tem `VIDEO` no canal. O servidor já libera a fonte `camera` no token de quem tem (`permissions.ts`), então **nada muda no servidor**. |
| Quem vê | **Todos, automaticamente**, como no Discord (spec principal §8.4: `Camera` é assinada como o microfone). A tela continua com "Assistir" (desde a v0.4.6 ela também chega sem clicar; ver a spec de transmitir a tela §5). |
| Qualidade de envio | **720p30 (padrão)**, 1080p30 ou 480p30, nas configurações. Simulcast de 3 camadas (180p, 360p e a escolhida). |
| Recepção | `adaptiveStream` do LiveKit: cada pessoa recebe a camada que cabe no tamanho do quadro e cai de camada sozinha quando a internet piora. |
| Lançamento | **v0.2.3**, branch `v0.2.3` (a partir da `v0.2.2`), junto com o lápis na tela. |

## 2. Interface

- **Barra da chamada:** botão de câmera no grupo 1, ao lado do microfone (como no Discord), com ⌄ para escolher o dispositivo. Ligada, o ícone fica em destaque; sem `VIDEO`, desligado com a explicação no título.
- **"Voz conectada":** o mesmo botão na fileira de botões quadrados (antes de "Transmitir tela").
- **Configurações → Voz:** a seção vira **Voz e vídeo**, com:
  - **Câmera:** o dispositivo (o `Select` do app), uma **prévia ao vivo** enquanto a seção está aberta (desligada ao sair) e o botão "Testar câmera";
  - **Qualidade da câmera:** 480p30, 720p30 (padrão), 1080p30.
- **Palco:**
  - com a câmera ligada, o vídeo ocupa o quadro no lugar da foto (`object-fit: cover`), com o mesmo rótulo de nome e o anel verde de quem fala;
  - a minha própria câmera aparece **espelhada** para mim (só na minha tela);
  - quem está com a câmera e transmitindo a tela tem dois quadros (a câmera e a tela);
  - se o vídeo trava ou some, o quadro volta para a foto.
- **Lista do canal na barra lateral:** um ícone de câmera ao lado de quem está com ela ligada.

## 3. Como funciona

- Publicação: `localParticipant.setCameraEnabled(true, { resolution, deviceId }, { videoSimulcastLayers, videoEncoding })` com os presets do LiveKit; 1080p usa `VideoPresets.h1080`.
- Desligar: `setCameraEnabled(false)` (despublica e para a câmera; a luz da câmera apaga).
- Assinatura: `Camera` entra junto com `Microphone` no que o cliente assina sozinho, também depois de uma reconexão.
- Mídia remota sempre com `track.attach(el)` / `detach()`, nunca `srcObject`.
- Trocar de dispositivo durante a chamada: `switchActiveDevice('videoinput', id)`.
- Entrar numa chamada não liga a câmera; sair da chamada desliga.
- Estado: `voice.state` já traz o que cada pessoa publica? Se não trouxer `camera`, o cliente deriva das publicações do LiveKit (não muda o protocolo).

## 4. Testes

- **Unitários:** presets e camadas por qualidade; a regra de assinatura (câmera sim, tela só ao assistir); o estado de quem está com câmera.
- **e2e** (câmera falsa do Chromium, `--use-fake-device-for-media-stream`): Ana liga a câmera; Bia vê um `<video>` com `readyState >= 2` e `videoWidth > 0` no quadro da Ana; Ana desliga e o quadro da Bia volta à foto ou às iniciais.
- **Manual:** câmera de verdade, troca de dispositivo no meio da chamada, 1080p, internet ruim (a camada cai).
