// Text-module server events as the renderer sees them (spec §5.3). Payloads are
// untrusted: lenient client schemas drop unknown keys, and an event that does not
// parse, or whose type is unknown, is ignored (spec §5.1).
import { z } from 'zod';
import {
  botCommandsSchemaClient,
  botUpdatedEventSchemaClient,
  botsWelcomeSchemaClient,
  channelSchemaClient,
  interactionEphemeralEventSchemaClient,
  interactionFailedEventSchemaClient,
  interactionThinkingEventSchemaClient,
  memberSchemaClient,
  messageSchemaClient,
  reactionSchemaClient,
  readStateSchemaClient,
  roleSchemaClient,
  serverInfoSchemaClient,
  textWelcomeSchemaClient,
  type BotCommand,
  type BotCommands,
  type BotProfile,
  type Channel,
  type Envelope,
  type InteractionEphemeralEvent,
  type InteractionFailedEvent,
  type InteractionThinkingEvent,
  type JoinMode,
  type Member,
  type MemberLeftReason,
  type Message,
  type Reaction,
  type ReadState,
  type Role,
  type ServerInfo,
  type TextWelcome,
} from '@ghostlink/shared';
import type { RendererWelcome } from '../../../shared/ipcTypes.js';

export type TextEvent =
  | { t: 'channel.created'; channel: Channel; readState: ReadState | null }
  | { t: 'channel.updated'; channel: Channel }
  | { t: 'channel.deleted'; id: string }
  | { t: 'msg.new'; message: Message }
  | { t: 'msg.updated'; message: Message }
  | { t: 'msg.deleted'; id: number; channelId: string }
  | { t: 'msg.reactions'; id: number; channelId: string; reactions: Reaction[] }
  | { t: 'typing'; channelId: string; userId: string }
  | { t: 'member.joined'; member: Member }
  | { t: 'member.updated'; member: Member }
  | { t: 'member.left'; userId: string; reason: MemberLeftReason }
  | { t: 'presence'; userId: string; online: boolean }
  | { t: 'role.created'; role: Role }
  | { t: 'role.updated'; role: Role }
  | { t: 'role.deleted'; id: string }
  | { t: 'server.updated'; server: ServerInfo }
  // Bots (bots spec §2, §3)
  | { t: 'commands.updated'; botId: string; commands: BotCommand[] }
  | { t: 'bot.updated'; botId: string; description: string }
  | ({ t: 'interaction.thinking' } & InteractionThinkingEvent)
  | ({ t: 'interaction.ephemeral' } & InteractionEphemeralEvent)
  | ({ t: 'interaction.failed' } & InteractionFailedEvent);

export type TextEventType = TextEvent['t'];

const id = z.string().min(1).max(64);
const messageId = z.number().int().positive();

// One schema per event type; each maps the payload to the TextEvent shape.
const EVENT_PARSERS: { readonly [T in TextEventType]: (d: unknown) => Extract<TextEvent, { t: T }> | null } = {
  'channel.created': (d) => {
    const p = z.object({ channel: channelSchemaClient, readState: readStateSchemaClient.optional().catch(undefined) }).safeParse(d);
    return p.success ? { t: 'channel.created', channel: p.data.channel, readState: p.data.readState ?? null } : null;
  },
  'channel.updated': (d) => {
    const p = z.object({ channel: channelSchemaClient }).safeParse(d);
    return p.success ? { t: 'channel.updated', channel: p.data.channel } : null;
  },
  'channel.deleted': (d) => {
    const p = z.object({ id }).safeParse(d);
    return p.success ? { t: 'channel.deleted', id: p.data.id } : null;
  },
  'msg.new': (d) => {
    const p = z.object({ message: messageSchemaClient }).safeParse(d);
    return p.success ? { t: 'msg.new', message: p.data.message } : null;
  },
  'msg.updated': (d) => {
    const p = z.object({ message: messageSchemaClient }).safeParse(d);
    return p.success ? { t: 'msg.updated', message: p.data.message } : null;
  },
  'msg.deleted': (d) => {
    const p = z.object({ id: messageId, channelId: id }).safeParse(d);
    return p.success ? { t: 'msg.deleted', ...p.data } : null;
  },
  'msg.reactions': (d) => {
    const p = z.object({ id: messageId, channelId: id, reactions: z.array(reactionSchemaClient).max(100) }).safeParse(d);
    return p.success ? { t: 'msg.reactions', ...p.data } : null;
  },
  typing: (d) => {
    const p = z.object({ channelId: id, userId: id }).safeParse(d);
    return p.success ? { t: 'typing', ...p.data } : null;
  },
  'member.joined': (d) => {
    const p = z.object({ member: memberSchemaClient }).safeParse(d);
    return p.success ? { t: 'member.joined', member: p.data.member } : null;
  },
  'member.updated': (d) => {
    const p = z.object({ member: memberSchemaClient }).safeParse(d);
    return p.success ? { t: 'member.updated', member: p.data.member } : null;
  },
  'member.left': (d) => {
    const p = z.object({ userId: id, reason: z.enum(['left', 'kicked', 'banned']).catch('left') }).safeParse(d);
    return p.success ? { t: 'member.left', ...p.data } : null;
  },
  presence: (d) => {
    const p = z.object({ userId: id, online: z.boolean() }).safeParse(d);
    return p.success ? { t: 'presence', ...p.data } : null;
  },
  'role.created': (d) => {
    const p = z.object({ role: roleSchemaClient }).safeParse(d);
    return p.success ? { t: 'role.created', role: p.data.role } : null;
  },
  'role.updated': (d) => {
    const p = z.object({ role: roleSchemaClient }).safeParse(d);
    return p.success ? { t: 'role.updated', role: p.data.role } : null;
  },
  'role.deleted': (d) => {
    const p = z.object({ id }).safeParse(d);
    return p.success ? { t: 'role.deleted', id: p.data.id } : null;
  },
  'server.updated': (d) => {
    const p = serverInfoSchemaClient.safeParse(d);
    return p.success ? { t: 'server.updated', server: p.data } : null;
  },
  'commands.updated': (d) => {
    const p = botCommandsSchemaClient.safeParse(d);
    return p.success ? { t: 'commands.updated', botId: p.data.botId, commands: p.data.commands } : null;
  },
  'bot.updated': (d) => {
    const p = botUpdatedEventSchemaClient.safeParse(d);
    return p.success ? { t: 'bot.updated', botId: p.data.botId, description: p.data.description } : null;
  },
  'interaction.thinking': (d) => {
    const p = interactionThinkingEventSchemaClient.safeParse(d);
    return p.success ? { t: 'interaction.thinking', ...p.data } : null;
  },
  'interaction.ephemeral': (d) => {
    const p = interactionEphemeralEventSchemaClient.safeParse(d);
    return p.success ? { t: 'interaction.ephemeral', ...p.data } : null;
  },
  'interaction.failed': (d) => {
    const p = interactionFailedEventSchemaClient.safeParse(d);
    return p.success ? { t: 'interaction.failed', ...p.data } : null;
  },
};

/** The text event carried by an envelope, or null for anything else (unknown, malformed, or another module's). */
export function parseTextEvent(envelope: Envelope): TextEvent | null {
  if (!Object.hasOwn(EVENT_PARSERS, envelope.t)) return null;
  return EVENT_PARSERS[envelope.t as TextEventType](envelope.d);
}

/** Everything the text stores need from a welcome: the base snapshot plus the text module's keys. */
export interface TextSnapshot {
  serverId: string;
  self: { userId: string; nickname: string; isOwner: boolean };
  server: { name: string; joinMode: JoinMode; version: string };
  text: TextWelcome;
  /** Every bot's slash commands (servers before 0.4.0: none). */
  botCommands?: readonly BotCommands[];
  /** Every bot's description, creator and last connection (servers before 0.4.2: absent). */
  botProfiles?: readonly BotProfile[];
}

/** Builds the snapshot; module keys ride along on the welcome object (main/connection.ts keeps them). */
export function snapshotFromWelcome(welcome: RendererWelcome): TextSnapshot {
  const bots = botsWelcomeSchemaClient.parse(welcome);
  return {
    serverId: welcome.serverId,
    self: { ...welcome.self },
    server: { name: welcome.server.name, joinMode: welcome.server.joinMode, version: welcome.server.version },
    text: textWelcomeSchemaClient.parse(welcome),
    botCommands: bots.botCommands,
    ...(bots.botProfiles ? { botProfiles: bots.botProfiles } : {}),
  };
}
