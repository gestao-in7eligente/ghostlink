# GhostLink — sons da chamada, cookies do DJ e o som do DJ sem cópia dupla (v0.5.2)

Pedidos do dono em 2026-10-02:

- "Ao entrar uma pessoa na sala de voz, deve emitir o mesmo som que o Discord." Escolheu os sons de entrar e sair, mutar e ensurdecer, transmissão de tela e desconectado.
- Ao bloqueio do YouTube no Ghost DJ, escolheu "subir agora + botão depois".
- Aprovou desligar a cópia dupla dos pacotes do DJ.

## 1. Sons da chamada

- **Sons próprios, no estilo do Discord:**
  - O arquivo de som do Discord é deles e não pode ser copiado. O app gera notas curtas (Web Audio, osciladores com envelope) parecidas no estilo.
  - Cada evento tem o seu desenho:
    - **entrar:** duas notas subindo;
    - **sair:** duas notas descendo;
    - **mutar e desmutar:** um toque curto, descendo e subindo;
    - **ensurdecer e desensurdecer:** o mesmo, um tom abaixo;
    - **transmissão começou:** três notas subindo;
    - **transmissão parou:** três notas descendo;
    - **desconectado:** uma descida mais longa.
  - Cada som dura até 400 ms, num volume confortável.
- **Saída:** a mesma saída de som escolhida em Configurações → Voz, pelo `AudioContext.setSinkId`.
- **Quando toca:**
  - **Entrar e sair:**
    - Toca quando alguém (bots inclusive) entra ou sai da sala de voz **em que eu estou**, e quando eu entro ou saio.
    - Ao entrar numa sala com gente, toca só o meu som de entrar, nunca um por pessoa que já estava lá.
    - Trocar de sala toca o som de entrar.
  - **Mutar e ensurdecer:**
    - Toca quando o meu microfone ou o meu áudio liga ou desliga, por mim (botão, menu ou atalho) ou por um moderador.
    - Ensurdecer, que também muta, toca só o som de ensurdecer.
  - **Transmissão:** toca quando alguém da minha sala começa ou para de compartilhar a tela, eu inclusive.
  - **Desconectado:** toca quando a conexão da chamada cai. Sair por vontade própria toca o som de sair.
- **Sem enxurrada:**
  - Sons iguais com menos de 150 ms entre eles tocam uma vez só.
  - Uma reconexão não toca o som de entrar de cada pessoa.
- **Configuração:** em Configurações → Voz, uma chave "Sons da chamada", ligada por padrão e guardada nas configurações do app.

## 2. Cookies do YouTube no painel do Ghost DJ

- **Na página do Ghost DJ**, só o dono do servidor vê a linha **Cookies do YouTube**:
  - "não configurados" ou "configurados em 02/10";
  - os botões **Enviar arquivo** (`.txt`) e **Remover**.
- **No servidor:**
  - Aceita até 100 KB, no formato Netscape: linhas de 7 campos separados por tab, ou comentários.
  - Precisa ter ao menos um cookie de `youtube.com`.
  - Grava em `<data>/ghost-dj/cookies.txt` (modo 600), trocando o arquivo de uma vez.
  - O conteúdo **nunca** volta ao app nem aparece nos logs.
  - Vale no próximo `/play`, sem reiniciar (o yt-dlp já confere o arquivo a cada execução).
- **Protocolo:**
  - Os pedidos `dj.cookies.set` (conteúdo em texto) e `dj.cookies.clear` são só do dono.
  - O estado do DJ ganha `cookies: { setAt } | null`, enviado só ao dono.
  - Fica na função `ghostDjPanel`.
- **Mensagem de bloqueio:** passa a dizer "o dono do servidor pode enviar os cookies do YouTube pela página do Ghost DJ".

## 3. O som do DJ sem cópia dupla

- **Motivo:** o DJ publica a faixa com RED, que manda uma cópia de cada pacote no pacote seguinte. Medido no CI (2026-10-02): 310 a 336 kbps no fio para 160 kbps de música.
- **Por que desligar:** por TCP, como no Railway, a cópia não protege nada e só dobra o tráfego para cada ouvinte. O cliente web do LiveKit também desliga o RED para estéreo.
- **Mudança:** publicar a faixa do DJ sem RED. O teste com LiveKit real passa a conferir a taxa no fio, por volta de 160 kbps.

## 4. Testes (enxutos)

- **Sons:**
  - quais eventos tocam qual som;
  - entrar numa sala cheia toca um som só;
  - a reconexão não dispara enxurrada;
  - com a chave desligada, nada toca.
- **Cookies:**
  - só o dono envia e remove;
  - arquivo inválido, grande demais ou sem YouTube é recusado;
  - o conteúdo nunca volta no estado;
  - a exclusão do servidor apaga o arquivo (já existente).
- **RED desligado:** a taxa no fio fica por volta de 160 kbps.
