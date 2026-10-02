import {
  ProtocolError,
  cleanMessageContent,
  type BotCommand,
  type InteractionEphemeralEvent,
  type InteractionFailedEvent,
  type InteractionOption,
  type InteractionOptionInput,
  type InteractionThinkingEvent,
  type Message,
} from '@ghostlink/shared';
import type { ModuleContext, ServerEvent } from '../modules.js';
import type { BotTextApi } from '../text/bots.js';
import { newEntityId } from '../text/repo.js';

/** One slash command in flight (bots spec §2). Only in memory: a restart forgets them. */
interface Live {
  readonly id: string;
  readonly botId: string;
  readonly channelId: string;
  /** Who used the command. */
  readonly userId: string;
  readonly command: string;
  phase: 'pending' | 'replied' | 'deferred';
  ephemeral: boolean;
  /** The public answer, once posted. */
  messageId: number | null;
  /** When the ephemeral answer was first shown. */
  shownAt: number | null;
  /** By the server's clock: the first answer's deadline, then the end of the window. */
  deadline: number;
  timer: NodeJS.Timeout;
}

export interface InteractionTiming {
  firstResponseMs: number;
  responseWindowMs: number;
  /** Interactions in flight per bot (answered ones stay for the window, for edits and follow-ups). */
  maxLivePerBot: number;
}

const USER_ID = /^[0-9a-f]{32}$/;
const ENTITY_ID = /^[A-Z2-7]{26}$/;

/**
 * The invoker's options checked against the command (bots spec §2): known names, no
 * duplicates, every required one, the right type, a member for `user`, a channel the invoker
 * can see for `channel`, and one of the choices when there are choices. BAD_REQUEST otherwise.
 */
export function checkOptions(command: BotCommand, input: readonly InteractionOptionInput[], invokerId: string, text: BotTextApi): InteractionOption[] {
  const bad = (why: string) => new ProtocolError('BAD_REQUEST', why);
  const defs = new Map(command.options.map((o) => [o.name, o]));
  const seen = new Set<string>();
  const out: InteractionOption[] = [];
  for (const o of input) {
    const def = defs.get(o.name);
    if (!def) throw bad('unknown option');
    if (seen.has(o.name)) throw bad('duplicate option');
    seen.add(o.name);
    const v = o.value;
    let fits: boolean;
    switch (def.type) {
      case 'string':
        fits = typeof v === 'string' && v.length > 0;
        break;
      case 'integer':
        fits = typeof v === 'number' && Number.isSafeInteger(v);
        break;
      case 'number':
        fits = typeof v === 'number' && Number.isFinite(v);
        break;
      case 'boolean':
        fits = typeof v === 'boolean';
        break;
      case 'user':
        fits = typeof v === 'string' && USER_ID.test(v) && text.isMember(v);
        break;
      case 'channel':
        fits = typeof v === 'string' && ENTITY_ID.test(v) && text.channelBits(invokerId, v) !== 0;
        break;
    }
    if (!fits) throw bad(`option ${o.name} must be a ${def.type}`);
    if (def.choices && !def.choices.some((c) => c.value === v)) throw bad(`option ${o.name} must be one of its choices`);
    out.push({ name: o.name, type: def.type, value: v });
  }
  for (const def of command.options) if (def.required && !seen.has(def.name)) throw bad(`option ${def.name} is required`);
  return out;
}

function cleaned(raw: string): string {
  const text = cleanMessageContent(raw);
  if (text === '') throw new ProtocolError('BAD_REQUEST', 'empty message');
  return text;
}

/**
 * Interactions in flight (bots spec §2): the 3 s first-answer deadline ("the bot did not
 * respond"), then the 15 min window for edits and follow-ups. Public answers are bot messages
 * with `interaction`; ephemeral ones go only to the invoker's sessions and are never stored.
 */
export class Interactions {
  readonly #live = new Map<string, Live>();
  readonly #perBot = new Map<string, number>();

  constructor(
    private readonly ctx: ModuleContext,
    private readonly text: BotTextApi,
    private readonly timing: InteractionTiming,
  ) {}

  /** Starts one: the bot gets `interaction.create`. The caller checked everything else. */
  start(p: { botId: string; channelId: string; userId: string; command: string; options: InteractionOption[] }): string {
    if ((this.#perBot.get(p.botId) ?? 0) >= this.timing.maxLivePerBot) throw new ProtocolError('RATE_LIMITED');
    const user = this.text.member(p.userId);
    if (!user) throw new ProtocolError('FORBIDDEN');
    const id = newEntityId();
    const now = this.ctx.now();
    const live: Live = {
      id,
      botId: p.botId,
      channelId: p.channelId,
      userId: p.userId,
      command: p.command,
      phase: 'pending',
      ephemeral: false,
      messageId: null,
      shownAt: null,
      deadline: now + this.timing.firstResponseMs,
      timer: this.#timer(id, this.timing.firstResponseMs),
    };
    this.#live.set(id, live);
    this.#perBot.set(p.botId, (this.#perBot.get(p.botId) ?? 0) + 1);
    const event = { t: 'interaction.create', d: { id, channelId: p.channelId, user, command: p.command, options: p.options, createdAt: now } };
    if (this.ctx.sessions.broadcast(event, (s) => s.userId === p.botId) === 0) {
      this.#drop(live);
      throw new ProtocolError('BOT_OFFLINE');
    }
    return id;
  }

  respond(botId: string, p: { id: string; type: 'reply' | 'defer'; content?: string; ephemeral?: boolean }): Message | null {
    const live = this.#get(botId, p.id);
    if (live.phase !== 'pending') throw new ProtocolError('BAD_REQUEST', 'the interaction was already answered');
    const ephemeral = p.ephemeral ?? false;
    let message: Message | null = null;
    if (p.type === 'reply') {
      const content = cleaned(p.content ?? '');
      if (ephemeral) {
        if (!this.text.takeMessage(botId)) throw new ProtocolError('RATE_LIMITED');
        live.shownAt = this.ctx.now();
        this.#sendEphemeral(live, live.id, content, live.shownAt, null);
      } else {
        message = this.text.post({ channelId: live.channelId, authorId: botId, content, interaction: this.#tag(live) });
        live.messageId = message.id;
      }
      live.phase = 'replied';
    } else {
      live.phase = 'deferred';
      const thinking: InteractionThinkingEvent = {
        id: live.id, channelId: live.channelId, botId, userId: live.userId, command: live.command, ephemeral,
      };
      this.#toAudience(live, ephemeral, { t: 'interaction.thinking', d: thinking });
    }
    live.ephemeral = ephemeral;
    this.#openWindow(live);
    return message;
  }

  edit(botId: string, p: { id: string; content: string }): Message | null {
    const live = this.#get(botId, p.id);
    if (live.phase === 'pending') throw new ProtocolError('BAD_REQUEST', 'the interaction was not answered yet');
    return this.#writeAnswer(live, p.content);
  }

  followup(botId: string, p: { id: string; content: string; ephemeral?: boolean }): Message | null {
    const live = this.#get(botId, p.id);
    if (live.phase === 'pending') throw new ProtocolError('BAD_REQUEST', 'the interaction was not answered yet');
    // After a defer, the first follow-up is the answer itself (as in Discord), with the defer's visibility.
    if (live.phase === 'deferred' && live.messageId === null && live.shownAt === null) return this.#writeAnswer(live, p.content);
    const content = cleaned(p.content);
    if (p.ephemeral ?? false) {
      if (!this.text.takeMessage(botId)) throw new ProtocolError('RATE_LIMITED');
      this.#sendEphemeral(live, newEntityId(), content, this.ctx.now(), null);
      return null;
    }
    return this.text.post({ channelId: live.channelId, authorId: botId, content, replyTo: live.messageId });
  }

  /** A deleted bot: its interactions end; anyone still waiting learns it did not respond. */
  dropBot(botId: string): void {
    for (const live of [...this.#live.values()]) {
      if (live.botId !== botId) continue;
      this.#failIfWaiting(live);
      this.#drop(live);
    }
  }

  stop(): void {
    for (const live of this.#live.values()) clearTimeout(live.timer);
    this.#live.clear();
    this.#perBot.clear();
  }

  get size(): number {
    return this.#live.size;
  }

  /** The original answer: posted (public), shown (ephemeral), or replaced by this text. */
  #writeAnswer(live: Live, raw: string): Message | null {
    const content = cleaned(raw);
    if (live.ephemeral) {
      if (!this.text.takeMessage(live.botId)) throw new ProtocolError('RATE_LIMITED');
      const now = this.ctx.now();
      const first = live.shownAt === null;
      live.shownAt ??= now;
      this.#sendEphemeral(live, live.id, content, live.shownAt, first ? null : now);
      return null;
    }
    if (live.messageId === null) {
      const message = this.text.post({ channelId: live.channelId, authorId: live.botId, content, interaction: this.#tag(live) });
      live.messageId = message.id;
      return message;
    }
    return this.text.edit(live.messageId, live.botId, content);
  }

  #tag(live: Live) {
    return { id: live.id, userId: live.userId, command: live.command };
  }

  /** NOT_FOUND unless it is this bot's and still open (judged by the server's clock too). */
  #get(botId: string, id: string): Live {
    const live = this.#live.get(id);
    if (!live || live.botId !== botId) throw new ProtocolError('NOT_FOUND');
    if (this.ctx.now() > live.deadline) {
      this.#expire(live);
      throw new ProtocolError('NOT_FOUND');
    }
    return live;
  }

  #timer(id: string, ms: number): NodeJS.Timeout {
    const timer = setTimeout(() => {
      const live = this.#live.get(id);
      if (live) this.#expire(live);
    }, ms);
    timer.unref();
    return timer;
  }

  #openWindow(live: Live): void {
    clearTimeout(live.timer);
    live.deadline = this.ctx.now() + this.timing.responseWindowMs;
    live.timer = this.#timer(live.id, this.timing.responseWindowMs);
  }

  #expire(live: Live): void {
    this.#failIfWaiting(live);
    this.#drop(live);
  }

  /** "The bot did not respond": to the invoker when nothing came, to whoever saw it thinking after a defer never answered. */
  #failIfWaiting(live: Live): void {
    const failed: InteractionFailedEvent = { id: live.id, channelId: live.channelId, botId: live.botId, userId: live.userId, command: live.command };
    const event = { t: 'interaction.failed', d: failed };
    if (live.phase === 'pending') this.#toAudience(live, true, event);
    else if (live.phase === 'deferred' && live.messageId === null && live.shownAt === null) this.#toAudience(live, live.ephemeral, event);
  }

  #drop(live: Live): void {
    clearTimeout(live.timer);
    if (!this.#live.delete(live.id)) return;
    const left = (this.#perBot.get(live.botId) ?? 1) - 1;
    if (left > 0) this.#perBot.set(live.botId, left);
    else this.#perBot.delete(live.botId);
  }

  /** The invoker's sessions only (while they still see the channel), or the channel's audience. */
  #toAudience(live: Live, invokerOnly: boolean, event: ServerEvent): void {
    if (!invokerOnly) {
      this.text.broadcastChannel(live.channelId, event);
      return;
    }
    if (this.text.channelBits(live.userId, live.channelId) === 0) return;
    this.ctx.sessions.broadcast(event, (s) => s.userId === live.userId);
  }

  #sendEphemeral(live: Live, id: string, content: string, createdAt: number, editedAt: number | null): void {
    const d: InteractionEphemeralEvent = {
      id, interactionId: live.id, channelId: live.channelId, botId: live.botId, command: live.command, content, createdAt, editedAt,
    };
    this.#toAudience(live, true, { t: 'interaction.ephemeral', d });
  }
}
