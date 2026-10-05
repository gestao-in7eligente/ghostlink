/**
 * The options a discord.js send/reply/edit takes, reduced to what GhostLink carries: text, a
 * reply target, and (for interactions) "only you can see this". Everything else that would change
 * the result (embeds, files, components, mention filters…) throws GhostLinkUnsupported instead of
 * being dropped.
 */
import { GhostLinkError, GhostLinkUnsupported } from './errors.js';
import { MessageFlags } from './enums.js';

/** A number, its name, or a list of them, like discord.js's MessageFlagsResolvable. */
export type MessageFlagsResolvable =
  | number
  | bigint
  | keyof typeof MessageFlags
  | readonly (number | bigint | keyof typeof MessageFlags)[]
  | { bitfield: number | bigint };

/**
 * GhostLink applies every mention in the text; only `repliedUser` (which GhostLink never pings
 * for a reply) can be given.
 */
export interface MessageMentionOptions {
  repliedUser?: boolean;
}

export interface BaseMessageOptions {
  content?: string | null;
  allowedMentions?: MessageMentionOptions;
  /** Only an empty list: GhostLink bots send text. */
  embeds?: readonly never[];
  components?: readonly never[];
  files?: readonly never[];
  attachments?: readonly never[];
  tts?: false;
  /** SuppressEmbeds (no effect: there are no embeds) and, for interactions, Ephemeral. */
  flags?: MessageFlagsResolvable;
}

/** A message to reply to, by id or object (`channel.send({ reply: { messageReference } })`). */
export interface ReplyOptions {
  messageReference: string | { id: string };
  failIfNotExists?: boolean;
}

export interface MessageCreateOptions extends BaseMessageOptions {
  reply?: ReplyOptions;
  nonce?: string | number;
  enforceNonce?: boolean;
}

export interface MessageReplyOptions extends BaseMessageOptions {
  failIfNotExists?: boolean;
  nonce?: string | number;
  enforceNonce?: boolean;
}

export type MessageEditOptions = BaseMessageOptions;

export interface InteractionReplyOptions extends BaseMessageOptions {
  /** Only the person who used the command sees the answer (also `flags: MessageFlags.Ephemeral`). */
  ephemeral?: boolean;
  /** Resolve with the answer's Message instead of an InteractionResponse. */
  fetchReply?: boolean;
}

export interface InteractionDeferReplyOptions {
  ephemeral?: boolean;
  flags?: MessageFlagsResolvable;
  fetchReply?: boolean;
}

export interface InteractionEditReplyOptions extends BaseMessageOptions {
  /** Only the original answer ('@original', the default) can be edited. */
  message?: '@original';
}

/** @internal */
export interface ResolvedContent {
  content: string;
  ephemeral: boolean;
  fetchReply: boolean;
  /** The message id to reply to (`reply.messageReference`). */
  replyTo: string | null;
}

interface Allow {
  ephemeral?: boolean;
  fetchReply?: boolean;
  reply?: boolean;
  editTarget?: boolean;
  /** deferReply has no content. */
  noContent?: boolean;
}

const EMPTY_LIST_KEYS = new Set(['embeds', 'components', 'files', 'attachments', 'stickers']);
const IGNORED_KEYS = new Set(['nonce', 'enforceNonce', 'failIfNotExists']);

function flagBits(method: string, value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const bit = (MessageFlags as unknown as Record<string, number | undefined>)[value];
    if (typeof bit !== 'number') throw new TypeError(`${method}: unknown message flag ${JSON.stringify(value)}`);
    return bit;
  }
  if (Array.isArray(value)) return value.reduce<number>((acc, v) => acc | flagBits(method, v), 0);
  if (typeof value === 'object' && value !== null && 'bitfield' in value) return flagBits(method, (value as { bitfield: unknown }).bitfield);
  throw new TypeError(`${method}: invalid flags`);
}

/** Ephemeral from `flags`; any flag GhostLink would not honour throws. */
function resolveFlags(method: string, value: unknown, allowEphemeral: boolean): boolean {
  const bits = flagBits(method, value);
  const allowed = MessageFlags.SuppressEmbeds | (allowEphemeral ? MessageFlags.Ephemeral : 0);
  const extra = bits & ~allowed;
  if (extra !== 0) {
    const names = Object.entries(MessageFlags).filter(([, v]) => typeof v === 'number' && (extra & v) !== 0).map(([k]) => k);
    throw new GhostLinkUnsupported(`${method}({ flags: MessageFlags.${names[0] ?? extra} })`);
  }
  return (bits & MessageFlags.Ephemeral) !== 0;
}

function messageReference(method: string, value: unknown): string {
  const ref = typeof value === 'object' && value !== null ? (value as { messageReference?: unknown }).messageReference : undefined;
  const id = typeof ref === 'object' && ref !== null ? (ref as { id?: unknown }).id : ref;
  if (typeof id !== 'string' && typeof id !== 'number') throw new TypeError(`${method}: reply.messageReference must be a message or its id`);
  return String(id);
}

/** @internal */
export function resolveContent(method: string, input: unknown, allow: Allow = {}): ResolvedContent {
  const out: ResolvedContent = { content: '', ephemeral: false, fetchReply: false, replyTo: null };
  if (typeof input === 'string') {
    if (allow.noContent) throw new TypeError(`${method}: expected an options object`);
    out.content = input;
  } else if (input === undefined && allow.noContent) {
    return out;
  } else if (typeof input !== 'object' || input === null) {
    throw new TypeError(`${method}: expected a string or an options object`);
  } else {
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (value === undefined || value === null) continue;
      if (key === 'content' && !allow.noContent) {
        if (typeof value !== 'string') throw new TypeError(`${method}: content must be a string`);
        out.content = value;
      } else if (EMPTY_LIST_KEYS.has(key) && Array.isArray(value) && value.length === 0) {
        // nothing to send
      } else if (key === 'tts' && value === false) {
        // the default
      } else if (key === 'allowedMentions' && typeof value === 'object' && Object.keys(value).every((k) => k === 'repliedUser')) {
        // GhostLink never pings the author of the message replied to
      } else if (key === 'flags') {
        if (resolveFlags(method, value, allow.ephemeral === true)) out.ephemeral = true;
      } else if (key === 'ephemeral' && allow.ephemeral && typeof value === 'boolean') {
        if (value) out.ephemeral = true;
      } else if (key === 'fetchReply' && allow.fetchReply && typeof value === 'boolean') {
        out.fetchReply = value;
      } else if (key === 'reply' && allow.reply) {
        out.replyTo = messageReference(method, value);
      } else if (key === 'message' && allow.editTarget && value === '@original') {
        // the only one GhostLink can edit
      } else if (IGNORED_KEYS.has(key)) {
        // GhostLink de-duplicates sends with its own id
      } else {
        throw new GhostLinkUnsupported(`${method}({ ${key} })`, EMPTY_LIST_KEYS.has(key) ? 'GhostLink bots send text only' : undefined);
      }
    }
  }
  if (!allow.noContent && out.content.trim() === '') throw new GhostLinkError('BAD_REQUEST', 'Cannot send an empty message', method);
  return out;
}
