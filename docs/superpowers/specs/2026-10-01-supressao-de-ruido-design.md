# GhostLink — Supressão de ruído

Desenho aprovado pelo dono em 2026-10-01 (referência: o seletor do Monky). Muda a spec principal §8.4 (áudio no cliente), que usava só a supressão nativa do WebRTC. Onde este documento não diz nada, ela continua valendo.

## 1. Decisões

| Tema | Decisão |
|---|---|
| Onde | Configurações do usuário → Voz: o seletor **"SUPRESSÃO DE RUÍDO"**. Não há atalho na chamada. |
| Opções | **RNNoise — neural**, **Speex — clássico**, **GTCRN — neural alternativo**, **WebRTC (nativo)**, **Desativada**. |
| Padrão | **RNNoise**, também para quem já usa o app (a configuração salva sem esse campo vira RNNoise). |
| Biblioteca | `@sapphi-red/web-noise-suppressor` 0.4.x (MIT): RNNoise (xiph/rnnoise, BSD-3), Speex (speexdsp, BSD-3) e GTCRN como AudioWorklets em WebAssembly. Os arquivos vão dentro do app; nada é baixado. |
| Lançamento | Na **v0.2.2**, branch `v0.2-screen`. |

## 2. Como funciona

- **Captura:** o pedido do microfone continua com `echoCancellation: true` e `autoGainControl: true`. O `noiseSuppression` nativo fica ligado **só** no modo WebRTC; com RNNoise, Speex, GTCRN ou Desativada fica desligado, para não processar duas vezes.
- **Ordem no grafo de áudio** (`GateProcessor`): `microfone → supressor → (analisador e ganho do portão) → saída publicada`. O portão de voz decide com o som já limpo, então o barulho de fundo não abre o microfone no modo detecção de voz.
- **Carregamento:** o WebAssembly e o módulo do worklet de cada supressor carregam na primeira vez que são usados e ficam guardados (o binário por app, o módulo por `AudioContext`). O RNNoise usa a versão SIMD quando o processador aceita.
- **Taxa de amostragem:** o RNNoise trabalha em quadros de 48 kHz. O `AudioContext` de voz é criado em 48 kHz (o Chromium converte o microfone) ou a implementação mostra por medição que a biblioteca cuida disso.
- **Troca na hora:** mudar a opção durante a chamada troca o nó do supressor no grafo e, quando entra ou sai do WebRTC, aplica `applyConstraints({ noiseSuppression })` na faixa do microfone. A chamada não cai e nada é publicado sem passar pelo portão.
- **Medidor das configurações:** o teste de microfone passa pelo mesmo supressor, para a pessoa ver o efeito.
- **Falha:** se um supressor não carrega (sem AudioWorklet, WebAssembly com erro), o app usa o WebRTC nativo naquela sessão e mostra, embaixo do seletor: "Não foi possível ativar {modo}. Usando WebRTC (nativo)." A escolha salva não muda.

## 3. Segurança

- A CSP do app ganha `'wasm-unsafe-eval'` em `script-src`. Isso permite compilar WebAssembly e continua proibindo `eval` e `new Function` de JavaScript.
- Os worklets e os `.wasm` são servidos pelo próprio `app://ghostlink`, como o resto do app.

## 4. Testes

- **Unitários:** o padrão e a migração da configuração; o mapa modo → restrições de captura; a escolha do nó; o caminho de falha (com o carregador falso).
- **e2e (voz):** com o RNNoise padrão, a voz de teste chega do outro lado (o `receivedLevelDb` que o teste de voz já mede); trocar para Speex e depois GTCRN no meio da chamada mantém a voz chegando; "Desativada" também.
- **Manual (checklist):** com um ventilador ou teclado, comparar os cinco modos; o modo detecção de voz não abre com o barulho de fundo usando RNNoise.
