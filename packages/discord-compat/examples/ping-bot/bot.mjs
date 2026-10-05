// A discord.js v14 bot, as the discord.js guide writes one. On GhostLink the only change is the
// import: '@ghostlink/discord-compat' instead of 'discord.js'.
import { setTimeout as sleep } from 'node:timers/promises';
import { Client, Events, GatewayIntentBits, MessageFlags, SlashCommandBuilder } from '@ghostlink/discord-compat';

export const commands = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Replies with Pong!')
    .addBooleanOption((option) => option.setName('private').setDescription('Only you see the answer'))
    .addBooleanOption((option) => option.setName('slow').setDescription('Think for a moment first')),
];

export function createPingBot() {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

  // Registers /ping (the same as REST.put(Routes.applicationCommands(...)) in a deploy script).
  client.once(Events.ClientReady, async (readyClient) => {
    await readyClient.application.commands.set(commands);
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
      await sleep(300);
      await interaction.editReply('Pong! (after thinking)');
    } else {
      await interaction.reply({ content: 'Pong!', flags });
    }
  });

  return client;
}
