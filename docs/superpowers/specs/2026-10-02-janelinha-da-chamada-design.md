# GhostLink — Janelinha da chamada ao compartilhar a tela

Aprovado pelo dono em 2026-10-02, a partir de um print da janelinha do Google Meet ("quando estiver compartilhando a tela, deve abrir uma janela dessa no canto inferior direito"). Escolhas: **com vídeo**; botões **microfone e câmera, Parar de compartilhar, Lápis, Sair da chamada**; **escondida de quem assiste**. Sai na **v0.4.4**.

## 1. Quando e onde

- Abre sozinha quando eu começo a compartilhar a tela ou uma janela numa chamada, e fecha quando o compartilhamento acaba (por qualquer caminho).
- Canto inferior direito da área de trabalho do monitor principal, a 12 px da borda, cerca de 320×380, sempre no topo, sem moldura, arrastável pela faixa de cima.
- **⤢** volta ao GhostLink (traz a janela principal para a frente). **✕** fecha só a janelinha; o compartilhamento continua, e ela volta no próximo compartilhamento.

## 2. Conteúdo (paleta do GhostLink)

1. **Faixa**: "● Você está apresentando" e o nome do canal de voz.
2. **Vídeo**: a **minha tela compartilhada**, como quem assiste a recebe (a prévia do próprio compartilhamento). Mudança do dono em 2026-10-02 (v0.4.5): "deve mostrar a tela compartilhada e não usuários"; a câmera de quem fala e a fileira de fotos saíram.
3. **Botões**: microfone e câmera (os mesmos da barra da chamada), **Parar de compartilhar** (fecha a janelinha), **lápis** (deixa ou não os outros desenharem na minha tela, o mesmo controle de hoje) e **sair da chamada** (vermelho).

## 3. Como

- A janela principal abre um popup do mesmo processo (`window.open` com um nome fixo) e o React desenha dentro dele (portal, com os estilos copiados). Assim usa os mesmos dados e as mesmas faixas de vídeo que a chamada já recebe: **sem segunda conexão** e sem banda extra.
- O main só permite esse popup (aquele nome, vindo da página do app); qualquer outro `window.open` continua negado. Ele dá as opções da janela (sem moldura, sempre no topo, posição) e a esconde da captura (`setContentProtection`, que no Windows 10 2004+ tira a janela da imagem) e da lista do seletor de compartilhamento.
- Fecha junto com a chamada, com o compartilhamento ou com a janela principal.

## 4. Testes (enxutos)

- Main: só o popup permitido abre, com as opções certas; fica fora do seletor e protegido da captura.
- Renderer: abre e fecha com o compartilhamento; o vídeo é a prévia da minha tela.
