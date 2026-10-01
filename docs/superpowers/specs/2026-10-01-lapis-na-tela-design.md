# GhostLink — Lápis na tela compartilhada

Desenho aprovado pelo dono em 2026-10-01 ("O usuário compartilha a tela. Aí vai ter a ferramenta de lápis, para as pessoas poderem marcar lugares na tela, ou até a própria pessoa. Estilo Slack"). Complementa a spec de transmitir a tela ([`2026-10-01-transmitir-tela-design.md`](2026-10-01-transmitir-tela-design.md)).

## 1. Decisões

| Tema | Decisão |
|---|---|
| Quem desenha | Quem está **assistindo** aquela transmissão e **quem transmite**. |
| Controle | Quem transmite liga e desliga **"Permitir desenhos"** (ligado por padrão). Desligado, ninguém desenha naquela transmissão. |
| Duração | Cada traço **some em ~3 s** depois de terminado (desvanece no último meio segundo), como no Slack. Não há "Limpar" nem traço fixo. |
| Identidade | Cada pessoa desenha numa cor da sua paleta (definida pelo `userId`), com o nome dela numa etiqueta pequena na ponta do traço. |
| Caminho | Pelo **servidor do GhostLink** (WSS), não pelos dados do LiveKit: os tokens do LiveKit continuam com `canPublishData: false`. |
| Servidor | Precisa da versão nova (`features` com `screenDraw`). Em servidor antigo o lápis não aparece. |
| Lançamento | **v0.2.3**, junto com a câmera. |

## 2. Interface

- **Quem assiste:** no quadro da transmissão assistida, um botão de **lápis** (barra do quadro, ao lado de tela cheia). Ligado, o cursor vira lápis sobre o vídeo e arrastar desenha. Esc ou o botão de novo desligam. Também funciona em tela cheia.
- **Quem transmite:**
  - no painel "AO VIVO" e no próprio quadro da sua transmissão: o mesmo lápis (desenha sobre a prévia) e a chave **"Permitir desenhos"**;
  - os traços de todos aparecem **por cima da tela real** (§4), além da prévia.
- Desenhar não faz nada com o mouse do computador de quem transmite.

## 3. Os traços

- **Coordenadas normalizadas** de 0 a 1 em relação ao quadro do **vídeo** (não do elemento: o `object-fit: contain` deixa faixas pretas, que ficam de fora).
- O app junta os pontos e manda **em lotes a cada ~50 ms**, com no máximo 64 pontos por lote, simplificados (pontos a menos de ~0,002 do anterior são descartados).
- Mensagens:
  - pedido `screen.draw { channelId, sharerId, strokeId, points: [x, y][], end: boolean }` (`strokeId` gerado pelo app; `end` marca o último lote do traço);
  - pedido `screen.drawAllow { channelId, allow: boolean }` (só quem transmite);
  - evento `screen.draw { channelId, sharerId, userId, strokeId, points, end }` para quem está no canal;
  - evento `screen.drawAllow { channelId, sharerId, allow }`.
- **Servidor** (módulo novo, sem guardar nada):
  - confere com `z.strictObject`: `x` e `y` entre 0 e 1, 1 a 64 pontos, `strokeId` curto;
  - quem pede está **naquele canal de voz** agora, `sharerId` está transmitindo nele (o estado de voz já sabe) e os desenhos estão permitidos;
  - limite: 30 lotes por segundo por pessoa (`SlidingWindowLimiter`); acima disso, os lotes são descartados sem erro;
  - repassa para as sessões que estão naquele canal de voz (regra de audiência da spec principal §5.3), menos a de quem desenhou;
  - o "Permitir desenhos" volta a ligado a cada nova transmissão.
- **Cliente:** desenha num `<canvas>` sobre o vídeo, com linha arredondada de ~4 px (proporcional ao tamanho do quadro), a cor da pessoa e o desvanecimento. Os próprios traços aparecem na hora, sem esperar o servidor.

## 4. Por cima da tela real (quem transmite)

- **Tela inteira** (`screen:…`): o main abre uma janela **transparente, sem moldura, sempre no topo, que ignora o mouse** (`setIgnoreMouseEvents(true)`), sem foco nem entrada na barra de tarefas, do tamanho daquele monitor (o `display_id` da fonte do `desktopCapturer` → `screen.getAllDisplays()`).
- A janela é **excluída da captura** (`setContentProtection(true)`), para os traços não voltarem no vídeo duplicados e atrasados. Quem assiste desenha a partir das mensagens, com atraso menor que o do vídeo.
- Página própria, estática, sem Node, servida por `app://ghostlink` (como a janela de atualização); recebe os traços por um preload mínimo.
- Fecha quando a transmissão acaba.
- **Janela compartilhada** (`window:<HWND>:…`), **no Windows**: a mesma janela de sobreposição **segue a janela compartilhada**.
  - O main lê o lugar dela pela API do Win32, com o **koffi** (MIT, binários N-API prontos, nada é compilado; carregado só no primeiro compartilhamento de janela): `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)`, que é o que a captura mostra, sem as bordas invisíveis de redimensionar; `GetWindowRect` se falhar.
  - O retângulo vem em pixels físicos e vira DIP com `screen.screenToDipRect(null, rect)` (o fator do monitor onde a janela está, também com monitores de escalas diferentes) antes do `setBounds`; se a troca de monitor redimensionar a sobreposição no caminho, ela é posicionada de novo.
  - Lê ~30 vezes por segundo enquanto há traços na tela e ~2 vezes por segundo no resto do tempo, para já estar no lugar quando um traço chegar; o primeiro traço lê na hora.
  - Minimizada (`IsIconic`), escondida (`IsWindowVisible`) ou em outra área de trabalho virtual (`DWMWA_CLOAKED`): a sobreposição se esconde e volta quando a janela volta. Fechada (`IsWindow` falso) ou fim da transmissão: para de ler.
  - Como fica sempre no topo, a sobreposição também desenha por cima das janelas que estiverem na frente da janela compartilhada (o Slack faz o mesmo).
  - **macOS e Linux**, ou se o koffi não carregar: como antes, os traços de uma janela compartilhada aparecem só para quem assiste e na prévia de quem transmite (o main registra isso uma vez no log, sem detalhes). O app nunca cai por causa do koffi.

## 5. Testes

- **Servidor:** schema (fora de 0–1, pontos demais, chaves extras); quem não está no canal, transmissão inexistente, desenhos desligados, limite por segundo; o repasse só para o canal e não para quem desenhou; "Permitir desenhos" só de quem transmite e reiniciado na próxima transmissão.
- **Cliente:** coordenadas com faixas pretas (`contain`) em proporções diferentes; lotes e simplificação; desvanecimento (relógio injetado); a cor por pessoa.
- **e2e** (sobre o `screen.e2e.ts`): Ana transmite, Bia assiste, liga o lápis e arrasta; Ana recebe o traço (a sobreposição da tela real recebeu pontos, ou o canvas da prévia tem pixels pintados); Ana desliga "Permitir desenhos" e o lápis da Bia some. No Windows, Ana transmite a **janela da Bia**: a sobreposição fica sobre ela, recebe os pontos e acompanha um `setBounds` da janela.
- **Janela compartilhada (main):** o HWND tirado do id da fonte; físico → DIP com monitores de escalas diferentes; quando esconder e mostrar; o ritmo da leitura (relógio falso); o rastreador e a sobreposição sobre uma imitação das chamadas do Win32; sem koffi, nenhuma sobreposição e um aviso só.
- **Manual:** os traços sobre a tela real no monitor certo com dois monitores; nada aparece no vídeo de quem assiste além dos traços desenhados localmente. Janela compartilhada (uma janela do navegador): os traços caem no mesmo ponto da página que quem assiste marcou; arrastar, redimensionar, maximizar a janela e levá-la a um monitor de outra escala, e a sobreposição acompanha; minimizar e trocar de área de trabalho virtual escondem os traços; nada disso aparece no vídeo.
