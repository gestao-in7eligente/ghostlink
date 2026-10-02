# GhostLink — Notificações próprias (cartão no canto da tela)

Aprovado pelo dono em 2026-10-02, a partir de um print de notificação do Telegram Desktop ("quando alguém mandar mensagem ou chamar para ligação, ou qualquer tipo de aviso, deve ser essa notificação"). Escolhas: **paleta do GhostLink**; mensagens de servidor: **todas, com opção por servidor** (começa em "Só @menções"); **sem som**. Sai na **v0.4.2**.

## 1. Decisões

| Tema | Decisão |
|---|---|
| Aparência | Cartão de 320×80 (como o print): foto redonda de 56 px à esquerda (ícone do servidor; foto ou iniciais do amigo; o fantasma nos avisos do app); linha 1 em negrito branco: **Servidor ➜ #canal** (DM: o nome do amigo; avisos: "GhostLink"); linhas 2 e 3: **Autor:** texto (nome em `--link`, texto em `--text-muted`), até 2 linhas com reticências; **×** no canto. Fundo `--bg-floating`, cantos de 8 px, sombra. |
| Onde | Canto inferior direito da área de trabalho do monitor principal (acima da barra de tarefas), 12 px da borda. O novo entra embaixo e empurra os outros para cima; no máximo 3 (o mais antigo sai). |
| Tempo | Some em 5 s; com o mouse em cima, nenhum some (voltam a contar ao sair). Clique: abre o GhostLink no canal/conversa e fecha o cartão; ×: fecha. Nunca rouba o foco. |
| Quando | Só com a janela do GhostLink fora de foco (minimizada, na bandeja ou atrás de outra), como hoje. Mensagens de canal conforme o modo do servidor; DM de amigo, sempre; **pedido de amizade recebido** (abre Amigos > Pendentes); o aviso "continua rodando na bandeja" (antes um balão do Windows). |
| Modo por servidor | Clique direito no servidor > **Notificações**: **Todas as mensagens**, **Só @menções** (padrão: menção a você, a um cargo seu, @todos, ou resposta a você), **Nada**. Guardado no PC, por servidor. |
| Som | Nenhum. As notificações nativas do Windows deixam de aparecer; o macOS segue com as nativas (como o Discord). |
| Configurações | Configurações > **Notificações**: "Mostrar notificações na área de trabalho" (ligado). Desligado: nenhum cartão de mensagem, DM ou pedido (o aviso da bandeja continua, é único). |
| Chamadas | O GhostLink ainda não tem chamada que toca (DM). Quando tiver, o aviso usa este cartão com Aceitar/Recusar. |

## 2. Como

- **Main, `toasts.ts`**: uma janela só (BrowserWindow) transparente, sem moldura, `focusable: false`, fora da barra de tarefas, sempre no topo, mostrada sem ativar (`showInactive`), do tamanho da pilha e ancorada no canto da `workArea` do monitor principal. Carrega a página `toast.html` (outra entrada do renderer, com preload próprio que só expõe: receber a lista, clicar, fechar, mouse em cima). Mesmas regras de segurança das outras janelas: sandbox, contextIsolation, sem navegação, sem permissões, CSP; os eventos só valem vindos dessa janela.
- **`ChatNotifier`** manda os avisos para `toasts` no Windows e no Linux; no macOS continua com `Notification`. O texto segue limpo como hoje (`notificationText`: uma linha, sem caracteres de controle, título 64 e corpo 200), e é sempre texto, nunca HTML. Fotos só pelas rotas `app://ghostlink/_avatar/…` que o app já serve.
- **Renderer**: `notificationFor()` recebe o modo do servidor e devolve servidor, canal, autor, texto e foto.
- **Amizade**: o main compara os pedidos recebidos de um snapshot de amigos com o anterior e avisa os novos.
- **Configurações**: `desktopNotifications` (booleano) e `notificationModes` (servidor → modo, só os que não são o padrão) no armazenamento de configurações que já existe.

## 3. Testes (enxutos)

- `toasts`: pilha de no máximo 3, tempo e pausa com o mouse, clique e × chegam a quem pediu, posição no canto da área de trabalho.
- `notificationFor`: os três modos.
- `ChatNotifier`: Windows usa o cartão, macOS a nativa; janela em foco não avisa; configuração desligada não avisa.
