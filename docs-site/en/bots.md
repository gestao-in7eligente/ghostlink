---
title: Bots
description: Run a discord.js bot on GhostLink by changing only the import and the token.
---

# Bots

A GhostLink bot is a server member driven by a program. If you already have a bot built with **discord.js v14**, it runs on GhostLink with the `@ghostlink/discord-compat` package: change the `import` and the token, and the rest of your code stays the same, within what GhostLink has (see [what works](#what-works)).

The server must run version **0.4.0 or newer**. Servers update themselves.

## 1. Create the bot in the app

1. In the server's sidebar, in the **Bots** section (above "Text channels"), click **Add bot**. The section only shows for people who can **manage the server**.
2. Give it a name and, if you like, a photo. Then click **Create bot**.
3. Copy the **connection code**, which looks like this: `ghostlink-bot://<address>:<port>?pin=…&token=…`.

::: warning Save it now
The code is shown only once. The server keeps only a hash of it and cannot show it again.
:::

The bot joins the server with the default role, like any member. It reads and writes in the channels its roles allow, and shows with the **BOT** tag.

In the bot's menu (right click, or **⋮**):

- **Generate new code**: the current code stops working at once and the bot is disconnected. Use it if the code leaked or you lost it.
- **Delete bot**: the bot leaves the server and its code stops working. Its messages stay.

## 2. Install the package

The package comes with every [GitHub release](https://github.com/gestao-in7eligente/ghostlink/releases/latest), signed like the other files (see [Verify downloads](./verify-downloads)). It is not on the npm registry: install it from the release's address.

```bash
VERSION=0.4.0
npm install "https://github.com/gestao-in7eligente/ghostlink/releases/download/v${VERSION}/ghostlink-discord-compat-${VERSION}.tgz"
```

It needs **Node.js 20** or newer. It works with `import` (ESM) and `require` (CommonJS), and ships its TypeScript types. You can remove `discord.js` from your dependencies.

## 3. Put the code in an environment variable

The connection code is the bot's token. Treat it as a password: keep it in an environment variable named `GHOSTLINK_BOT`, never in your code or in git.

```bash
# .env (kept out of git)
GHOSTLINK_BOT=ghostlink-bot://chat.example.com:7700?pin=...&token=...
```

Where the bot runs (Railway, a VPS, your computer), create the `GHOSTLINK_BOT` variable with the code. `client.login()` with no argument reads `GHOSTLINK_BOT` and, when it is not set, `DISCORD_TOKEN`.

## 4. Swap the import

```js
// before
import { Client, Events, GatewayIntentBits } from 'discord.js';
// after
import { Client, Events, GatewayIntentBits } from '@ghostlink/discord-compat';

client.login(process.env.GHOSTLINK_BOT);
```

With CommonJS it is the same: `require('@ghostlink/discord-compat')`.

Slash commands are still registered as in the discord.js guide: with `client.application.commands.set([...])`, or with `REST` and `Routes.applicationCommands(clientId)` in a deploy script. GhostLink has no separate client ID: any value works, and the bot is the one of the connection code.

### Example: the ping bot

This bot answers `!ping` and `/ping` (with the options `private`, for the person who used it only, and `slow`, "thinking…" before answering). It also ships inside the package, in `examples/ping-bot`.

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

## What works

| Part | What the package has, with discord.js v14's names |
|---|---|
| Client | `new Client({ intents })` (intents are accepted and ignored), `client.login(code)`, `client.user`, `client.application` (and `client.application.edit({ description })`, the description shown on the bot's page), `client.channels.cache` and `.fetch(id)`, `client.users.cache` and `.fetch(id)`, `client.guilds.cache` (the server), `client.ws.ping`, `client.isReady()`, `client.destroy()` |
| Events | `Events.ClientReady` (`'ready'` too), `Events.MessageCreate`, `Events.InteractionCreate`, `'error'`, `'warn'`, `'debug'` |
| Messages | `content`, `author` (`id`, `username`, `bot`, `tag`, `displayName`), `channel`, `channelId`, `guild`, `mentions.users`, `mentions.everyone`, `mentions.has(user)`, `createdTimestamp`, `createdAt`, `reply(text \| { content })`, `edit()` and `delete()` |
| Text channels | `id`, `name`, `topic`, `send(text \| { content })`, `sendTyping()`, `messages.fetch({ limit, before })` (up to 100, newest first) and `messages.fetch(id)` |
| Slash commands | `SlashCommandBuilder` with string, integer, number, boolean, user and channel options, `setRequired`, `addChoices`; `client.application.commands.set([...])`; `REST` with `Routes.applicationCommands` (and `applicationGuildCommands`) |
| Interactions | `isChatInputCommand()`, `commandName`, `options.getString`, `getInteger`, `getNumber`, `getBoolean`, `getUser`, `getChannel`, `user`, `channel`, `reply({ content, ephemeral })` or `flags: MessageFlags.Ephemeral`, `deferReply()`, `editReply()`, `followUp()`, `replied`, `deferred` |
| Other | `Collection`, `GatewayIntentBits`, `Partials`, `ChannelType`, `MessageFlags`, `ApplicationCommandOptionType` |

The first answer to a command must go out within **3 seconds**. If the bot needs longer, call `deferReply()`: the app shows "*bot name* is thinking…" and the bot has 15 minutes to `editReply()`.

## What does not work

Embeds, buttons, menus, modals, files, reactions, moderation (kick, ban, roles), command permissions, subcommands, autocomplete, direct messages, the bot's status and activity, and voice.

Using any of them throws `GhostLinkUnsupported`, naming what was used. A bot never fails silently:

```
GhostLinkUnsupported: Message.react is not supported on GhostLink. Supported API: https://gestao-in7eligente.github.io/ghostlink/en/bots
```

Other differences:

- **IDs.** Messages have numeric ids (as strings, as in discord.js); people have 32 hexadecimal characters. Mentions look the same: `<@id>`.
- **Server.** `guild` is the bot's GhostLink server, and `guild.id` is its fingerprint.
- **Names.** `username` is the person's nickname on the server.
- **What the bot sees.** Its roles decide which channels it sees; intents change nothing. Messages sent while the bot was disconnected are not delivered later (use `messages.fetch()` if you need them).
- **Reconnecting.** When the connection drops, the package reconnects by itself. A replaced code, a pin that does not match, or a ban stop the bot with an `'error'` event.

## Security

The connection code carries the server's **pin**, the fingerprint of its TLS key. The package only talks to a server whose key matches the pin; when it does not, the connection is refused before the token is sent. The server keeps only a hash of the token.

## Common problems

| Error | What to do |
|---|---|
| `TokenInvalid` | The value of `GHOSTLINK_BOT` is not a connection code. Check that you copied the whole code, starting with `ghostlink-bot://`. |
| `BAD_BOT_TOKEN` | The code was replaced (**Generate new code**) or the bot was deleted. Generate a new code in the app. |
| `PIN_MISMATCH` | The server's key does not match the code's pin. Copy the code again from the app. |
| `BAD_REQUEST` at login | The server is older than 0.4.0 and has no bots yet. |
| `UNREACHABLE` | The code's address does not answer. Check that the server is up and its port open. |
| `NOT_FOUND` from `reply()` | The answer took longer than 3 seconds. Call `deferReply()` first. |
