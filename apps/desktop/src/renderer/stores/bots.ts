// The `bots` store (bots spec §3): every bot's slash commands (the welcome's `botCommands`, then
// `commands.updated`), and the lines about interactions that only this app shows: "{bot} está
// pensando…", an ephemeral answer ("Só você pode ver isto") and "O bot não respondeu". The
// server keeps none of these, so a new welcome drops them.
import type { BotCommand, Message } from '@ghostlink/shared';
import type { BotLocal, BotsState, TextAction, TextState } from './textState.js';

export const initialBots: BotsState = { commands: {}, locals: {} };

const EMPTY: readonly BotLocal[] = [];

function localsOf(s: BotsState, channelId: string): readonly BotLocal[] {
  return Object.hasOwn(s.locals, channelId) ? s.locals[channelId]! : EMPTY;
}

function withLocals(s: BotsState, channelId: string, list: readonly BotLocal[]): BotsState {
  const locals = { ...s.locals };
  if (list.length === 0) delete locals[channelId];
  else locals[channelId] = list;
  return { ...s, locals };
}

/** The newest message id the channel had when a line appeared: it stays right after that message. */
function anchorOf(root: TextState, channelId: string): number {
  const channel = Object.hasOwn(root.channels.byId, channelId) ? root.channels.byId[channelId]! : undefined;
  const logs = root.messages.logs;
  const loaded = Object.hasOwn(logs, channelId) ? (logs[channelId]!.items.at(-1)?.id ?? 0) : 0;
  return Math.max(channel?.lastMessageId ?? 0, loaded);
}

/** Drops the "pensando…" of an interaction that got its answer (or failed). */
function withoutThinking(list: readonly BotLocal[], interactionId: string): readonly BotLocal[] {
  return list.some((l) => l.kind === 'thinking' && l.id === interactionId) ? list.filter((l) => !(l.kind === 'thinking' && l.id === interactionId)) : list;
}

/** Inserts or replaces (same kind and id: an edit keeps its place). */
function upsertLocal(list: readonly BotLocal[], local: BotLocal): readonly BotLocal[] {
  const index = list.findIndex((l) => l.kind === local.kind && l.id === local.id);
  if (index < 0) return [...list, local];
  return list.map((l, i) => (i === index ? { ...local, afterId: l.afterId } : l));
}

function onPublicAnswer(s: BotsState, m: Message): BotsState {
  if (!m.interaction) return s;
  const list = localsOf(s, m.channelId);
  const next = withoutThinking(list, m.interaction.id);
  return next === list ? s : withLocals(s, m.channelId, next);
}

/** Pure reducer of the bots slice. `root` is the whole state before this action. */
export function botsSlice(s: BotsState, a: TextAction, root: TextState): BotsState {
  switch (a.type) {
    case 'reset': {
      const commands: Record<string, readonly BotCommand[]> = {};
      for (const entry of a.snapshot.botCommands ?? []) commands[entry.botId] = entry.commands;
      return { commands, locals: {} };
    }
    case 'bots.dismiss': {
      const list = localsOf(s, a.channelId);
      const next = list.filter((l) => !(l.kind === a.kind && l.id === a.id));
      return next.length === list.length ? s : withLocals(s, a.channelId, next);
    }
    case 'message.upsert':
      return onPublicAnswer(s, a.message);
    case 'event':
      break;
    default:
      return s;
  }

  const e = a.event;
  switch (e.t) {
    case 'commands.updated':
      return { ...s, commands: { ...s.commands, [e.botId]: e.commands } };
    case 'member.left': {
      if (!Object.hasOwn(s.commands, e.userId)) return s;
      const commands = { ...s.commands };
      delete commands[e.userId];
      return { ...s, commands };
    }
    case 'channel.deleted':
      return Object.hasOwn(s.locals, e.id) ? withLocals(s, e.id, []) : s;
    case 'msg.new':
      return onPublicAnswer(s, e.message);
    case 'interaction.thinking': {
      const local: BotLocal = {
        kind: 'thinking',
        id: e.id,
        channelId: e.channelId,
        botId: e.botId,
        userId: e.userId,
        command: e.command,
        ephemeral: e.ephemeral,
        afterId: anchorOf(root, e.channelId),
      };
      return withLocals(s, e.channelId, upsertLocal(localsOf(s, e.channelId), local));
    }
    case 'interaction.ephemeral': {
      const local: BotLocal = {
        kind: 'ephemeral',
        id: e.id,
        interactionId: e.interactionId,
        channelId: e.channelId,
        botId: e.botId,
        // Only the person who used the command gets it.
        userId: root.server.selfId,
        command: e.command,
        content: e.content,
        createdAt: e.createdAt,
        editedAt: e.editedAt,
        afterId: anchorOf(root, e.channelId),
      };
      return withLocals(s, e.channelId, upsertLocal(withoutThinking(localsOf(s, e.channelId), e.interactionId), local));
    }
    case 'interaction.failed': {
      const local: BotLocal = { kind: 'failed', id: e.id, channelId: e.channelId, botId: e.botId, userId: e.userId, command: e.command, afterId: anchorOf(root, e.channelId) };
      return withLocals(s, e.channelId, upsertLocal(withoutThinking(localsOf(s, e.channelId), e.id), local));
    }
    default:
      return s;
  }
}

// ---- selectors ----

const NONE: readonly BotLocal[] = [];

/** The interaction lines of a channel, in the order they appeared. */
export function channelLocals(s: BotsState, channelId: string): readonly BotLocal[] {
  return Object.hasOwn(s.locals, channelId) ? s.locals[channelId]! : NONE;
}
