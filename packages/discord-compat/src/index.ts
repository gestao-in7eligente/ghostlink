/**
 * @ghostlink/discord-compat — the part of discord.js v14 a bot needs, on a GhostLink server
 * (bots spec 2026-10-02 §4). Swap `from 'discord.js'` for `from '@ghostlink/discord-compat'` and
 * log in with the bot's connection code. Anything outside the subset throws GhostLinkUnsupported.
 */
import { unsupportedClass, unsupportedTable } from './errors.js';

export { Client, ChannelManager, GuildManager, UserManager, WebSocketManager } from './client.js';
export type { ClientEvents, ClientOptions, Interaction } from './client.js';
export { User, ClientUser, Guild, TextChannel, MessageManager, Message, MessageMentions } from './structures.js';
export type { FetchMessageOptions, FetchMessagesOptions } from './structures.js';
export { ChatInputCommandInteraction, CommandInteractionOptionResolver, InteractionResponse } from './interactions.js';
export type { CommandInteractionOption } from './interactions.js';
export { ApplicationCommand, ApplicationCommandManager, ClientApplication } from './application.js';
export type { ApplicationCommandOption } from './application.js';
export {
  SlashCommandBuilder,
  SlashCommandBooleanOption,
  SlashCommandChannelOption,
  SlashCommandIntegerOption,
  SlashCommandNumberOption,
  SlashCommandStringOption,
  SlashCommandUserOption,
} from './builders.js';
export type {
  APIApplicationCommand,
  APIApplicationCommandOption,
  APIApplicationCommandOptionChoice,
  ApplicationCommandDataResolvable,
  ChatInputApplicationCommandData,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from './commands.js';
export { REST, Routes } from './rest.js';
export type { RequestData } from './rest.js';
export { Collection } from './collection.js';
export {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ChannelType,
  Events,
  GatewayIntentBits,
  IntentsBitField,
  InteractionType,
  MessageFlags,
  MessageType,
  Partials,
} from './enums.js';
export type {
  BaseMessageOptions,
  InteractionDeferReplyOptions,
  InteractionEditReplyOptions,
  InteractionReplyOptions,
  MessageCreateOptions,
  MessageEditOptions,
  MessageFlagsResolvable,
  MessageMentionOptions,
  MessageReplyOptions,
  ReplyOptions,
} from './content.js';
export { DiscordjsError, DiscordjsTypeError, GhostLinkError, GhostLinkUnsupported } from './errors.js';
export type { DiscordjsErrorCode } from './errors.js';
export { parseConnectionCode } from './connectionCode.js';
export type { ConnectionCode } from './connectionCode.js';
export { version } from './version.js';

// discord.js exports a bot may import that GhostLink does not have (bots spec §1: no embeds,
// buttons, menus, modals, files, webhooks, permissions): using them throws GhostLinkUnsupported.
export const EmbedBuilder = unsupportedClass('EmbedBuilder');
export const ActionRowBuilder = unsupportedClass('ActionRowBuilder');
export const ButtonBuilder = unsupportedClass('ButtonBuilder');
export const StringSelectMenuBuilder = unsupportedClass('StringSelectMenuBuilder');
export const ModalBuilder = unsupportedClass('ModalBuilder');
export const TextInputBuilder = unsupportedClass('TextInputBuilder');
export const AttachmentBuilder = unsupportedClass('AttachmentBuilder');
export const ContextMenuCommandBuilder = unsupportedClass('ContextMenuCommandBuilder');
export const SlashCommandSubcommandBuilder = unsupportedClass('SlashCommandSubcommandBuilder');
export const WebhookClient = unsupportedClass('WebhookClient');
export const PermissionsBitField = unsupportedClass('PermissionsBitField');
export const PermissionFlagsBits = unsupportedTable('PermissionFlagsBits');
export const ButtonStyle = unsupportedTable('ButtonStyle');
export const ActivityType = unsupportedTable('ActivityType');
