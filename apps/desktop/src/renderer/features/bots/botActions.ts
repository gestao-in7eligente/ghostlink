// Requests about bots (bots spec §2, §3) through the generic server.request IPC, with the lenient
// client schemas: creating, a new connection code, deleting, the bot's settings (MANAGE_SERVER),
// the bot's photo, and using a slash command.
import { z } from 'zod';
import {
  botCreateResultSchemaClient,
  botGetResultSchemaClient,
  botRegenerateResultSchemaClient,
  botUpdateResultSchemaClient,
  interactionInvokeResultSchemaClient,
  type BotCreateResult,
  type BotDetails,
  type BotGetResult,
  type InteractionOptionInput,
} from '@ghostlink/shared';
import type { GhostlinkApi } from '../../../shared/ipcTypes.js';
import { textState } from '../../stores/text.js';
import { request } from '../chat/actions.js';

function ghostlink(): GhostlinkApi {
  return (globalThis as unknown as { window: { ghostlink: GhostlinkApi } }).window.ghostlink;
}

/** A new bot: its member appears with member.joined; the connection code comes only here. */
export function createBot(name: string): Promise<BotCreateResult> {
  return request('bot.create', { name: name.trim() }, botCreateResultSchemaClient);
}

/** A new connection code: the old one stops working and the bot is disconnected. */
export async function regenerateBotCode(botId: string): Promise<string> {
  return (await request('bot.regenerate', { botId }, botRegenerateResultSchemaClient)).connectionToken;
}

/** The bot leaves (member.left); its messages stay. */
export async function deleteBot(botId: string): Promise<void> {
  await request('bot.delete', { botId }, z.object({}));
}

/** Everything the bot's settings show: its state, activity and channel access (servers with `botSettings`). */
export function getBot(botId: string): Promise<BotGetResult> {
  return request('bot.get', { botId }, botGetResultSchemaClient);
}

/** A new name and/or description; a rename comes back as member.updated, any change as bot.updated. */
export async function updateBot(botId: string, patch: { name?: string; description?: string }): Promise<BotDetails> {
  return (await request('bot.update', { botId, ...patch }, botUpdateResultSchemaClient)).bot;
}

/** The bot's photo, already cropped and encoded like a profile photo; resolves once the server holds it. */
export async function setBotPhoto(botId: string, bytes: Uint8Array): Promise<void> {
  const serverId = textState().server.serverId;
  if (serverId === null) throw new Error('CONNECTION_LOST');
  await ghostlink().profile.setBotAvatar(serverId, botId, bytes);
}

/** Uses a slash command: the bot gets it and answers in the channel (or only to me). Resolves with the interaction's id. */
export async function invokeCommand(channelId: string, botId: string, command: string, options: InteractionOptionInput[]): Promise<string> {
  return (await request('interaction.invoke', { channelId, botId, command, options }, interactionInvokeResultSchemaClient)).id;
}
