---
title: Bots
description: Rode no GhostLink um bot feito com discord.js, trocando só o import e o token.
---

# Bots

Um bot do GhostLink é um membro do servidor controlado por um programa. Se você já tem um bot feito com **discord.js v14**, ele roda no GhostLink com o pacote `@ghostlink/discord-compat`: você troca o `import` e o token, e o resto do código continua igual, dentro do que o GhostLink tem (veja [o que funciona](#o-que-funciona)).

O servidor precisa estar na versão **0.4.0 ou mais nova**. Os servidores se atualizam sozinhos.

## 1. Criar o bot no app

1. Na barra lateral do servidor, na seção **Bots** (acima de "Canais de texto"), clique em **Adicionar bot**. A seção só aparece para quem pode **gerenciar o servidor**.
2. Dê um nome e, se quiser, uma foto. Depois, clique em **Criar bot**.
3. Copie o **código de conexão**, que tem esta forma: `ghostlink-bot://<endereço>:<porta>?pin=…&token=…`.

::: warning Guarde agora
O código aparece uma vez só. O servidor guarda apenas um resumo (hash) dele e não consegue mostrá-lo de novo.
:::

O bot entra no servidor com o cargo padrão, como qualquer membro. Ele lê e escreve nos canais que os cargos dele permitem, e aparece com a etiqueta **BOT**.

No menu do bot (clique com o botão direito ou em **⋮**):

- **Gerar novo código**: o código atual para de funcionar na hora e o bot é desconectado. Use se o código vazou ou se você o perdeu.
- **Excluir bot**: o bot sai do servidor e o código para de funcionar. As mensagens dele continuam lá.

## 2. Instalar o pacote

O pacote vem em cada [release do GitHub](https://github.com/gestao-in7eligente/ghostlink/releases/latest), assinado como os outros arquivos (veja [Verificar downloads](./verificar-downloads)). Ele não está no registro do npm: instale pelo endereço da release.

```bash
VERSION=0.4.0
npm install "https://github.com/gestao-in7eligente/ghostlink/releases/download/v${VERSION}/ghostlink-discord-compat-${VERSION}.tgz"
```

Precisa do **Node.js 20** ou mais novo. Funciona com `import` (ESM) e com `require` (CommonJS), e já traz os tipos do TypeScript. Pode tirar o `discord.js` das dependências.

## 3. Colocar o código numa variável de ambiente

O código de conexão faz o papel do token do bot. Trate-o como uma senha: deixe-o numa variável de ambiente chamada `GHOSTLINK_BOT`, nunca no código nem no git.

```bash
# .env (fora do git)
GHOSTLINK_BOT=ghostlink-bot://chat.exemplo.com:7700?pin=...&token=...
```

Na hospedagem do bot (Railway, uma VPS, o seu computador), crie a variável `GHOSTLINK_BOT` com o código. O `client.login()` sem argumento lê `GHOSTLINK_BOT` e, se ela não existir, `DISCORD_TOKEN`.

## 4. Trocar o import

```js
// antes
import { Client, Events, GatewayIntentBits } from 'discord.js';
// depois
import { Client, Events, GatewayIntentBits } from '@ghostlink/discord-compat';

client.login(process.env.GHOSTLINK_BOT);
```

Com CommonJS, é o mesmo: `require('@ghostlink/discord-compat')`.

Os comandos de barra continuam sendo registrados como no guia do discord.js: com `client.application.commands.set([...])` ou com `REST` e `Routes.applicationCommands(clientId)` num script de deploy. O GhostLink não tem um "client ID" separado: qualquer valor serve, e o bot fica sendo o do código de conexão.

### Exemplo: o bot do ping

Este bot responde `!ping` e `/ping` (com as opções `private`, só para quem usou, e `slow`, "pensando…" antes de responder). Ele também vem dentro do pacote, em `examples/ping-bot`.

```js
import { Client, Events, GatewayIntentBits, MessageFlags, SlashCommandBuilder } from '@ghostlink/discord-compat';

const ping = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Replies with Pong!')
  .addBooleanOption((option) => option.setName('private').setDescription('Only you see the answer'))
  .addBooleanOption((option) => option.setName('slow').setDescription('Think for a moment first'));

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.once(Events.ClientReady, async (readyClient) => {
  await readyClient.application.commands.set([ping]);
  console.log(`Ready! Logged in as ${readyClient.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.content === '!ping') await message.reply(`Pong! ${client.ws.ping} ms`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'ping') return;
  const flags = interaction.options.getBoolean('private') ? MessageFlags.Ephemeral : undefined;
  if (interaction.options.getBoolean('slow')) {
    await interaction.deferReply({ flags });
    await interaction.editReply('Pong! (after thinking)');
  } else {
    await interaction.reply({ content: 'Pong!', flags });
  }
});

client.login(process.env.GHOSTLINK_BOT);
```

## O que funciona

| Parte | O que o pacote tem, com os mesmos nomes do discord.js v14 |
|---|---|
| Cliente | `new Client({ intents })` (os intents são aceitos e ignorados), `client.login(código)`, `client.user`, `client.application`, `client.channels.cache` e `.fetch(id)`, `client.users.cache` e `.fetch(id)`, `client.guilds.cache` (o servidor), `client.ws.ping`, `client.isReady()`, `client.destroy()` |
| Eventos | `Events.ClientReady` (`'ready'` também), `Events.MessageCreate`, `Events.InteractionCreate`, `'error'`, `'warn'`, `'debug'` |
| Mensagens | `content`, `author` (`id`, `username`, `bot`, `tag`, `displayName`), `channel`, `channelId`, `guild`, `mentions.users`, `mentions.everyone`, `mentions.has(usuário)`, `createdTimestamp`, `createdAt`, `reply(texto \| { content })`, `edit()` e `delete()` |
| Canais de texto | `id`, `name`, `topic`, `send(texto \| { content })`, `sendTyping()`, `messages.fetch({ limit, before })` (até 100, as mais novas primeiro) e `messages.fetch(id)` |
| Comandos de barra | `SlashCommandBuilder` com opções de texto, inteiro, número, sim/não, usuário e canal, `setRequired`, `addChoices`; `client.application.commands.set([...])`; `REST` com `Routes.applicationCommands` (e `applicationGuildCommands`) |
| Interações | `isChatInputCommand()`, `commandName`, `options.getString`, `getInteger`, `getNumber`, `getBoolean`, `getUser`, `getChannel`, `user`, `channel`, `reply({ content, ephemeral })` ou `flags: MessageFlags.Ephemeral`, `deferReply()`, `editReply()`, `followUp()`, `replied`, `deferred` |
| Outros | `Collection`, `GatewayIntentBits`, `Partials`, `ChannelType`, `MessageFlags`, `ApplicationCommandOptionType` |

A primeira resposta a um comando precisa sair em **3 segundos**. Se o bot precisa de mais tempo, chame `deferReply()`: o app mostra "*nome do bot* está pensando…" e o bot tem 15 minutos para o `editReply()`.

## O que não funciona

Embeds, botões, menus, modais, arquivos, reações, moderação (expulsar, banir, cargos), permissões de comandos, subcomandos, autocomplete, mensagens diretas, status e atividade do bot, e voz.

Usar qualquer um deles lança o erro `GhostLinkUnsupported` com o nome do que foi usado. O bot nunca falha calado:

```
GhostLinkUnsupported: Message.react is not supported on GhostLink. Supported API: https://gestao-in7eligente.github.io/ghostlink/en/bots
```

Outras diferenças:

- **IDs.** As mensagens têm ids numéricos (como texto, igual ao discord.js); as pessoas, 32 caracteres hexadecimais. As menções têm a mesma forma: `<@id>`.
- **Servidor.** `guild` é o servidor GhostLink do bot, e `guild.id` é a impressão digital dele.
- **Nomes.** `username` é o apelido da pessoa no servidor.
- **O que o bot vê.** Os cargos decidem os canais que ele vê; os intents não mudam nada. Mensagens enviadas enquanto o bot estava desconectado não chegam depois (use `messages.fetch()` se precisar).
- **Reconexão.** Se a conexão cai, o pacote reconecta sozinho. Um código trocado, um pin que não confere ou um banimento param o bot com um evento `'error'`.

## Segurança

O código de conexão traz o **pin** do servidor, a impressão digital da chave TLS dele. O pacote só conversa com um servidor cuja chave confere com o pin e, se não conferir, recusa a conexão antes de enviar o token. O servidor guarda só o hash do token.

## Problemas comuns

| Erro | O que fazer |
|---|---|
| `TokenInvalid` | O valor de `GHOSTLINK_BOT` não é um código de conexão. Confira se copiou o código inteiro, começando com `ghostlink-bot://`. |
| `BAD_BOT_TOKEN` | O código foi trocado (**Gerar novo código**) ou o bot foi excluído. Gere um código novo no app. |
| `PIN_MISMATCH` | A chave do servidor não confere com o pin do código. Copie o código de novo do app. |
| `BAD_REQUEST` no login | O servidor é anterior à 0.4.0 e ainda não tem bots. |
| `UNREACHABLE` | O endereço do código não responde. Veja se o servidor está no ar e se a porta está aberta. |
| `NOT_FOUND` em `reply()` | A resposta passou dos 3 segundos. Use `deferReply()` primeiro. |
