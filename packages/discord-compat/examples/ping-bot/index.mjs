// Runs the ping bot. Create the bot in the GhostLink app (BOTS → Add bot), then:
//
//   npm install https://github.com/gestao-in7eligente/ghostlink/releases/download/v<version>/ghostlink-discord-compat-<version>.tgz
//   GHOSTLINK_BOT='ghostlink-bot://…' node index.mjs
import process from 'node:process';
import { Events } from '@ghostlink/discord-compat';
import { createPingBot } from './bot.mjs';

const client = createPingBot();
client.once(Events.ClientReady, (readyClient) => console.log(`Ready! Logged in as ${readyClient.user.tag}`));
await client.login(process.env.GHOSTLINK_BOT);
