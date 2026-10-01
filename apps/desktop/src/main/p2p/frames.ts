// The wire codec between friends (friends spec §3.3), on top of Hyperswarm's encrypted link:
//   1 type byte ‖ body length (uint32 BE) ‖ body
// Type 1 is JSON (up to 256 KiB); type 2, a file chunk, arrives with files (phase 3). The link
// keeps message boundaries, so one message is exactly one frame. Every JSON body goes through a
// strict zod schema before anything uses it; whoever receives a FrameError drops the connection.
import { z } from 'zod';
import { LIMITS, fromUtf8, utf8 } from '@ghostlink/shared';
import { CONVERSATION_ID } from './conversations.js';
import { entrySchema } from './entries.js';

/** The P2P protocol version announced in `hello`. */
export const P2P_VERSION = 1;
export const FRAME_JSON = 1;
export const FRAME_HEADER_BYTES = 5;
export const MAX_JSON_BYTES = LIMITS.maxPayloadBytes;
/** spec §3.2: an inbox connection carries one friend.request of at most 1 KiB. */
export const MAX_INBOX_REQUEST_BYTES = 1024;

/** The longest nickname on the wire. Even at 3 UTF-8 bytes per character a request stays under 1 KiB. */
export const NICKNAME_WIRE_MAX = 256;

/** A nickname as announced: the receiver cleans it again before showing it; '' means none was set. */
const nickname = z.string().max(NICKNAME_WIRE_MAX);

/** sync.have: conversations shared with one person, and authors per conversation (a group has 10 members). */
export const HAVE_CONVS_MAX = 1000;
export const HAVE_HEADS_MAX = 10;

const convId = z.string().regex(CONVERSATION_ID);
/** A friend key as it travels: base64url of 32 bytes. */
const friendKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const seq = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/** A nickname cut to what the wire takes, never in the middle of a character. */
export function wireNickname(name: string): string {
  let out = '';
  for (const char of name) {
    if (out.length + char.length > NICKNAME_WIRE_MAX) break;
    out += char;
  }
  return out;
}

const messageSchema = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('hello'), v: z.literal(P2P_VERSION), nickname }),
  /** `sig`: base64url of the 64-byte inbox proof (friendKey.ts). */
  z.strictObject({ t: z.literal('inbox.hello'), sig: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }),
  /** `proof`: base64url of the 32-byte HMAC showing the asker holds the whole code (friendKey.ts). */
  z.strictObject({ t: z.literal('friend.request'), nickname, proof: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
  z.strictObject({ t: z.literal('friend.accept') }),
  z.strictObject({ t: z.literal('friend.remove') }),
  z.strictObject({ t: z.literal('ping') }),
  z.strictObject({ t: z.literal('pong') }),
  // Direct messages (spec §4.3). `heads`: per author, the highest seq this side holds.
  z.strictObject({
    t: z.literal('sync.have'),
    convs: z
      .array(z.strictObject({ id: convId, heads: z.record(friendKey, seq).refine((heads) => Object.keys(heads).length <= HAVE_HEADS_MAX) }))
      .max(HAVE_CONVS_MAX),
  }),
  /** The entries of `author` from `from` to `to` (both included); the answer holds 500 at most. */
  z.strictObject({ t: z.literal('sync.want'), conv: convId, author: friendKey, from: seq, to: seq }).refine((want) => want.to >= want.from),
  z.strictObject({ t: z.literal('entry'), entry: entrySchema }),
  z.strictObject({ t: z.literal('typing'), conv: convId }),
]);

export type P2pMessage = z.infer<typeof messageSchema>;

/** The messages that belong to conversations (dm.ts), not to the friendship. */
export type ConversationMessage = Extract<P2pMessage, { t: 'sync.have' | 'sync.want' | 'entry' | 'typing' }>;

/** A frame this side refuses to read or to send. */
export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameError';
  }
}

export function encodeMessage(message: P2pMessage): Uint8Array {
  const parsed = messageSchema.safeParse(message);
  if (!parsed.success) throw new FrameError('message does not match the schema');
  const body = utf8(JSON.stringify(parsed.data));
  if (body.length > MAX_JSON_BYTES) throw new FrameError('message too large');
  const frame = Buffer.alloc(FRAME_HEADER_BYTES + body.length);
  frame[0] = FRAME_JSON;
  frame.writeUInt32BE(body.length, 1);
  frame.set(body, FRAME_HEADER_BYTES);
  return frame;
}

/** zod drops a `__proto__` key of a record without a word; a frame that carries one is refused instead. */
function refuseProto(key: string, value: unknown): unknown {
  if (key === '__proto__') throw new FrameError('frame carries a __proto__ key');
  return value;
}

/** The message of one received frame; `maxBytes` bounds the body (checked before it is parsed). */
export function decodeMessage(frame: Uint8Array, maxBytes: number = MAX_JSON_BYTES): P2pMessage {
  if (frame.length < FRAME_HEADER_BYTES) throw new FrameError('frame shorter than its header');
  if (frame[0] !== FRAME_JSON) throw new FrameError('unknown frame type');
  const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1);
  if (length > maxBytes) throw new FrameError('frame too large');
  if (length !== frame.length - FRAME_HEADER_BYTES) throw new FrameError('frame length does not match its header');
  let value: unknown;
  try {
    value = JSON.parse(fromUtf8(frame.subarray(FRAME_HEADER_BYTES)), refuseProto);
  } catch (e) {
    throw e instanceof FrameError ? e : new FrameError('frame body is not JSON');
  }
  const parsed = messageSchema.safeParse(value);
  if (!parsed.success) throw new FrameError('message does not match the schema');
  return parsed.data;
}
