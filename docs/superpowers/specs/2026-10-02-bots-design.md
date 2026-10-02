# GhostLink — Bots (compatíveis com discord.js)

Desenho aprovado pelo dono em 2026-10-02 ("acima de Canais de Texto, quero Adicionar Bots. Vai funcionar como o Discord; eu já tenho um bot, quero migrar"). O bot do dono (Hermes Trismegisto) é feito com **discord.js** e usa **mensagens/comandos com prefixo** e **slash commands**. Caminho escolhido: um **pacote compatível com a parte do discord.js que o Hermes usa**, para a migração ser trocar o `import` e o token.

## 1. Decisões

| Tema | Decisão |
|---|---|
| Onde | Seção **BOTS** na barra lateral do servidor, **acima de "CANAIS DE TEXTO"**: os bots do servidor (foto, nome, ponto de online). Quem tem `MANAGE_SERVER` vê **+ Adicionar bot**. |
| Conta do bot | Um **membro** com `bot: true`, criado pelo servidor, sem identidade Ed25519; aparece com a etiqueta **BOT**; permissões pelos cargos, como qualquer membro (entra com o cargo padrão). |
| Conexão | Um **código de conexão** mostrado uma única vez: `ghostlink-bot://<host:porta>?pin=<serverKeyId>&token=<segredo>`. O servidor guarda só o SHA-256 do segredo. **Gerar novo código** invalida o anterior e derruba a sessão do bot. **Excluir bot** remove o membro (mensagens ficam como "bot excluído"). |
| Recursos | Mensagens (ler os canais que o bot vê, enviar, responder, editar e apagar as próprias, menções) e **slash commands** (opções, resposta normal ou só para quem usou, "pensando…"). |
| Fora | Embeds, botões, menus, moderação, reações por API, voz. |
| Pacote | `packages/discord-compat` → `@ghostlink/discord-compat`, publicado como `.tgz` em cada release do GitHub. |
| Lançamento | **v0.4.0**. Servidores precisam da 0.4.0 (`features` com `bots`); eles se atualizam sozinhos. |

## 2. Servidor

- **Tabela `bots`:** `user_id` (o membro), `name`, `token_hash`, `created_by`, `created_at`. O membro tem `is_bot = 1`.
- **Pedidos (MANAGE_SERVER):** `bot.create { name }` → `{ bot, connectionToken }` (o código só aqui); `bot.regenerate { botId }` → `{ connectionToken }` (fecha a sessão do bot); `bot.delete { botId }`; `bot.list {}`. A foto do bot usa o caminho de avatar existente (o bot envia a própria, ou o dono pela tela de criar).
- **Handshake de bot:** no `hello`, `bot: <segredo>` no lugar da identidade; o servidor confere o hash (`timingSafeEqual`), limita tentativas por IP como a autenticação normal, e entra direto no `welcome` com o `self` do bot. Sem convite, sem setup code. Ninguém além do servidor fala com o bot em nome de alguém.
- **Membro:** `Member.bot: boolean` (lenient no cliente).
- **Slash commands:**
  - `commands.set { commands: [{ name, description, options: [{ name, description, type: 'string'|'integer'|'number'|'boolean'|'user'|'channel', required, choices? }] }] }` (só bots; até 100 comandos; nomes `^[a-z0-9_-]{1,32}$`); evento `commands.updated` para quem está conectado; o welcome traz os comandos dos bots;
  - `interaction.invoke { channelId, botId, command, options }` (quem pode `SEND_MESSAGES` no canal e o bot pode ver o canal) → o servidor cria a interação e manda `interaction.create { id, channelId, user, command, options }` **só ao bot**; prazo de 3 s para a primeira resposta;
  - o bot responde com `interaction.respond { id, type: 'reply'|'defer', content?, ephemeral? }`, depois `interaction.edit { id, content }` e `interaction.followup { id, content, ephemeral? }` (até 15 min);
  - a resposta pública vira uma **mensagem do bot** com `interaction: { userId, command }` ("Fulano usou /comando"); a efêmera vai **só para quem usou** (`interaction.ephemeral` evento, não guardado); `defer` mostra "{bot} está pensando…" até o `edit`; sem resposta em 3 s: "O bot não respondeu".
- **Limites:** mensagens do bot com o mesmo rate limit de membros, x2; interações 5/s por canal.

## 3. App

- **Seção BOTS** (barra lateral, acima de "CANAIS DE TEXTO"), escondida quando o servidor não tem bots e a pessoa não pode criar.
- **Adicionar bot:** modal com nome e foto (o mesmo recorte da foto de perfil) → tela com o **código de conexão**, botão **Copiar**, aviso "Guarde agora: ele não aparece de novo" e um link para o guia.
- **Menu do bot** (clique direito / ⋮): **Gerar novo código** (com confirmação), **Excluir bot** (com confirmação).
- **Etiqueta BOT** na lista de membros, nas mensagens e nas menções.
- **Slash no compositor:** digitar `/` no começo abre a lista de comandos dos bots que veem o canal (nome, descrição, foto do bot); escolher monta as opções como "chips" editáveis (texto, número, sim/não, pessoa, canal com o seletor de menções); Enter envia `interaction.invoke`. Mensagem do bot com `interaction` mostra a linha "Fulano usou /comando" acima; efêmera aparece com "Só você pode ver isto · Dispensar".

## 4. Pacote `@ghostlink/discord-compat`

- Node 20+, ESM e CJS, sem dependências nativas. Conecta com `ws` sobre TLS **com o pin** do código (recusa certificado diferente), reconecta sozinho.
- API (subconjunto do discord.js v14):
  - `new Client({ intents })` (intents aceitos e ignorados), `client.login(codigoDeConexao)`, `client.user`, `client.on('ready' | Events.ClientReady)`, `Events.MessageCreate`, `Events.InteractionCreate`;
  - `Message`: `content`, `author` (`id`, `username`, `bot`), `channel`, `channelId`, `mentions.users` / `mentions.has(user)`, `reply(conteúdo | { content })`, `edit`, `delete`, `createdTimestamp`;
  - `TextChannel`: `send(conteúdo | { content })`, `sendTyping()`, `messages.fetch({ limit })`;
  - `client.channels.fetch(id)`, `client.channels.cache`, `client.users.cache`;
  - `SlashCommandBuilder` (nome, descrição, opções de string/inteiro/número/boolean/usuário/canal, required, choices) e `client.application.commands.set([...])` (e `REST`/`Routes.applicationCommands` como no guia do discord.js, mapeados para `commands.set`);
  - `ChatInputCommandInteraction`: `isChatInputCommand()`, `commandName`, `options.getString/getInteger/getNumber/getBoolean/getUser/getChannel`, `user`, `channel`, `reply({ content, ephemeral })`, `deferReply({ ephemeral })`, `editReply`, `followUp`, `replied`, `deferred`.
- Chamadas fora do subconjunto lançam `GhostLinkUnsupported("<método>")` com uma mensagem clara (nunca falham em silêncio).
- **Distribuição:** o `release.yml` empacota `ghostlink-discord-compat-<versão>.tgz` e anexa à release (assinado como os outros arquivos); a documentação mostra `npm install https://github.com/gestao-in7eligente/ghostlink/releases/download/v<versão>/ghostlink-discord-compat-<versão>.tgz`.
- **Guia** no site (pt/en): criar o bot, colar o código numa variável de ambiente (`GHOSTLINK_BOT`), trocar `from 'discord.js'` por `from '@ghostlink/discord-compat'`, o que é suportado.

## 5. Testes (enxutos)

- Servidor: criar, handshake com código válido/errado/regenerado, `commands.set`, interação ida e volta (reply, defer+edit, efêmera, timeout), permissões.
- Pacote: um bot de exemplo contra o servidor de teste: responde `!ping` e `/ping`, com o pin errado recusado.
- App: um e2e: Ana cria um bot, roda o bot de exemplo com o código, digita `/ping` e vê a resposta "Fulano usou /ping".

## 6. Migração do Hermes

Com o caminho do código do Hermes, troco o `import`, o login e o registro de comandos, testo contra um servidor de teste e entrego as mudanças; o deploy no Railway é do dono (nenhum serviço do Railway do dono é tocado).
