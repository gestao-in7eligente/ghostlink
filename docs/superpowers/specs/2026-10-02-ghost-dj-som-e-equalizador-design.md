# GhostLink — Ghost DJ: qualidade do som e equalizador

Dono, 2026-10-02 (v0.5.0 no ar): "a qualidade da música ficou muito baixa, e desejo adicionar o equalizador". Sintomas relatados: **abafada / sem graves**, **picotando / cortando**, **robótica / chiada**. Equalizador escolhido: **painel com controles**. Sai na **v0.5.1**.

## 1. Qualidade (defeito)

Medir antes de mudar: tocar uma faixa conhecida num servidor local, gravar o que um participante recebe e comparar com o PCM de origem (faixa de frequência, canais, falhas e ritmo dos quadros), e ver no Railway (TC Flag) a CPU e os logs durante a reprodução. Corrigir na origem o que a medição mostrar. Os alvos esperados:

- **Música, não voz**: Opus estéreo, banda cheia, 128 a 192 kbps, sem DTX, e o modo de música do codificador se o `@livekit/rtc-node` permitir.
- **Ritmo**: quadros de 20 ms entregues num relógio estável, com folga (buffer) suficiente para a decodificação nunca atrasar; nada de bloquear o laço de eventos.
- **Caminho local**: o DJ fala com o LiveKit do próprio servidor pelo caminho local (UDP no próprio container), nunca dando a volta pelo proxy público/TCP do Railway.

## 2. Equalizador (novo)

- **5 faixas**: 60 Hz, 230 Hz, 910 Hz, 3,6 kHz e 14 kHz, de −12 a +12 dB (passo de 1 dB).
- **Predefinições**: Padrão (tudo 0), Graves+, Pop, Rock, Voz, Eletrônica; mexer numa faixa vira "Personalizado".
- **Aplicado no servidor**, no PCM antes do codificador (filtros biquad, na hora, sem reiniciar a música), igual para todos na chamada. Guardado por servidor: vale para as próximas músicas e sobrevive a reinícios.
- **Painel no app**, na página do Ghost DJ (clique no bot): o que está tocando (título, quem pediu, posição), botões **pausar/continuar, pular, parar**, volume, e o equalizador (5 controles verticais + predefinições). Atualiza ao vivo para quem está com a página aberta.
- **Quem mexe**: quem está no canal de voz com o DJ (as mesmas regras dos comandos); os outros veem o painel só para leitura.
- **Protocolo**: pedidos novos para ler o estado e mudar EQ/volume/controles, e um evento de estado do DJ para os painéis; só em servidores com a função (`ghostDjPanel`).

## 3. Testes (enxutos)

- A medição da qualidade vira teste onde der (ex.: a faixa de frequência e a ausência de falhas num tom de teste pelo LiveKit real).
- Filtros: resposta de cada faixa (um tom na frequência sobe/desce o ganho esperado), troca de predefinição sem estalo.
- Quem pode mexer, o estado salvo, o evento para os painéis.
