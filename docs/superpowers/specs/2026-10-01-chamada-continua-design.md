# GhostLink — A chamada continua ao navegar

Desenho aprovado pelo dono em 2026-10-01 ("Se estiver em uma chamada, e clicar em outro servidor ou na casinha, não deve sair da chamada, apenas quando clica para desligar"). Muda a spec principal §1.3 (um servidor por vez): agora são **até dois** — o da chamada e o que se está vendo.

## 1. Comportamento

- **Casinha durante a chamada:** a conexão com o servidor da chamada continua. A tela mostra a Home (amigos, mensagens diretas); o painel do usuário mostra **"Voz conectada — {canal} / {servidor}"** com microfone, fone e desligar. Clicar no nome do canal (ou no servidor no trilho) volta para ele na hora, sem reconectar.
- **Outro servidor durante a chamada:** a conexão da chamada continua e o app abre uma **segunda conexão** para o servidor que se está vendo. Dá para ler e escrever no outro servidor e continuar falando na chamada.
- **Entrar em outro canal de voz** (no mesmo ou em outro servidor): a chamada anterior termina (uma chamada por vez). Se o servidor dela não for o que se está vendo, a conexão dele fecha.
- **A chamada só termina** com **desligar**, ao entrar em outra chamada, ao ser removido/expulso/movido pelo servidor, ou ao fechar o app.
- **Sem chamada**, tudo continua como hoje: um servidor por vez; ir para a casinha desconecta.
- Os servidores não mudam.

## 2. Como (app)

- **Main (`controller.ts`):** além da conexão vista, uma **conexão de chamada** opcional. Ao trocar de servidor (ou ir para a casinha) com uma chamada ativa, a conexão atual vira a de chamada (não é fechada); a vista passa a ser a nova (ou nenhuma). Ao desligar, se a conexão de chamada não for a vista, fecha. Reconexão de cada uma é independente.
- **Eventos:** os eventos de cada conexão vão para o renderer com o `serverId` de origem; o renderer roteia os da conexão de chamada só para o estado de voz.
- **Pin no renderer:** o LiveKit da chamada precisa do pin do servidor da chamada enquanto ele não é o visto — o `setCertificateVerifyProc` passa a conhecer **os dois** pins (o visto e o da chamada); nunca mais que esses dois; convites e servidores salvos continuam sem acrescentar pins.
- **Renderer:** o runtime de voz (sala do LiveKit, portão, supressão de ruído, câmera, tela, lápis) **não depende** do servidor visto. O estado de voz guarda o `serverId` da chamada e um retrato do diretório dela (nomes, fotos, canal), atualizado pelos eventos da conexão de chamada. Trocar o servidor visto troca as lojas de texto/membros, nunca a de voz.
- **Pedidos de voz** (mute, sair, mover) vão sempre pela conexão da chamada.

## 3. Testes

- **Unitários:** o controller com duas conexões falsas (trocar com e sem chamada, desligar fecha a de fundo, entrar em outra chamada encerra a anterior, reconexão independente); o roteamento de eventos por `serverId`; os dois pins.
- **e2e:** Ana e Bia numa chamada no servidor A. Ana vai para a casinha → Bia continua ouvindo Ana (o nível recebido que o e2e de voz já mede); Ana abre o servidor B → continua; Ana volta ao A → sem reconectar; Ana desliga → a chamada termina e a conexão com A fecha (se ela estiver vendo o B).
