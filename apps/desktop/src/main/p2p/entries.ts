// The signed entry (friends spec §4.2): every person keeps, per conversation, an append-only log
// of their own entries. The signature covers the exact bytes of `body`, so any member can pass
// an entry on without being able to change it.
//
//   sig = Ed25519(author, "ghostlink/entry/v1\n" ‖ conv ‖ "\n" ‖ seq ‖ "\n" ‖ ts ‖ "\n" ‖ kind ‖ "\n" ‖ SHA-256(body))
//
// with seq and ts as decimal text. The author is not in the signed bytes: only the author's key
// verifies the signature, which binds it.
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ATTACHMENT_KINDS, ATTACHMENT_LIMITS, CRYPTO_LABELS, cleanFileName, cleanMessageContent, fromBase64Url, toBase64Url, utf8 } from '@ghostlink/shared';
import { DM_ATTACHMENTS_MAX, DM_FILE_MAX_BYTES, DM_TEXT_MAX, type DmFileInfo } from '../../shared/dmTypes.js';
import { isMember } from './conversations.js';
import { FILE_HASH } from './dmFiles.js';
import { verifyFriendSignature, type FriendKey } from './friendKey.js';

/** spec §3.4: one entry, as JSON, in UTF-8 bytes. */
export const ENTRY_MAX_BYTES = 64 * 1024;
/** spec §4.2: an entry whose ts is further ahead of the local clock is refused. */
export const ENTRY_MAX_FUTURE_MS = 5 * 60_000;
/** The kinds of this phase; groups (phase 4) add theirs. */
export const ENTRY_KINDS = ['msg', 'edit', 'delete'] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

const hexId = z.string().regex(/^[0-9a-f]{32}$/);
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** A lone surrogate has no UTF-8 form: two different bodies would hash the same. */
const wellFormed = (s: string) => !/\p{Cs}/u.test(s);

export const entrySchema = z.strictObject({
  conv: hexId,
  /** The author's friend key, base64url. */
  author: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  seq: counter.min(1),
  /** The author's clock, ms since the epoch. */
  ts: counter,
  kind: z.enum(ENTRY_KINDS),
  /** JSON text; its schema depends on `kind` (parseEntryBody). */
  body: z.string().max(ENTRY_MAX_BYTES).refine(wellFormed),
  /** base64url of the 64-byte Ed25519 signature. */
  sig: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});

export type Entry = z.infer<typeof entrySchema>;
export type EntryFields = Omit<Entry, 'author' | 'sig'>;

/** A message text as it travels: at most 4000 characters, never blank. */
const text = z.string().max(DM_TEXT_MAX).refine((t) => cleanMessageContent(t) !== '');
const side = z.number().int().min(1).max(ATTACHMENT_LIMITS.maxImageSide);

/**
 * A file of a message (attachments spec §3), as its sender read it from the bytes. The receiver
 * trusts none of it to show the file: the bytes must match `hash` before they are kept, and
 * app://ghostlink/_dmfile reads their type from them again. `name` is cleaned on arrival.
 */
const attachmentSchema = z.strictObject({
  hash: z.string().regex(FILE_HASH),
  name: z.string().min(1).max(ATTACHMENT_LIMITS.nameInputMax),
  size: z.number().int().min(1).max(DM_FILE_MAX_BYTES),
  kind: z.enum(ATTACHMENT_KINDS),
  mime: z.string().max(100).regex(/^[a-z]+\/[a-z0-9.+-]+$/),
  width: side.optional(),
  height: side.optional(),
});

const bodySchemas = {
  // The text may be blank only when files go with it; `replyTo` is absent when there is none.
  msg: z
    .strictObject({ id: hexId, text: z.string().max(DM_TEXT_MAX), replyTo: hexId.optional(), attachments: z.array(attachmentSchema).max(DM_ATTACHMENTS_MAX) })
    .refine((b) => cleanMessageContent(b.text) !== '' || b.attachments.length > 0),
  edit: z.strictObject({ id: hexId, text }),
  delete: z.strictObject({ id: hexId }),
} as const;

/** What an entry does to the conversation. */
export type EntryBody =
  | { kind: 'msg'; id: string; text: string; replyTo: string | null; attachments: readonly DmFileInfo[] }
  | { kind: 'edit'; id: string; text: string }
  | { kind: 'delete'; id: string };

/** A file as it goes into an entry: a fixed key order, the sides only when known. */
function wireFile(f: DmFileInfo): DmFileInfo {
  return {
    hash: f.hash,
    name: f.name,
    size: f.size,
    kind: f.kind,
    mime: f.mime,
    ...(f.width === undefined ? {} : { width: f.width }),
    ...(f.height === undefined ? {} : { height: f.height }),
  };
}

/** The body text of an entry this side writes. */
export function entryBodyJson(body: EntryBody): string {
  switch (body.kind) {
    case 'msg':
      return JSON.stringify({ id: body.id, text: body.text, ...(body.replyTo === null ? {} : { replyTo: body.replyTo }), attachments: body.attachments.map(wireFile) });
    case 'edit':
      return JSON.stringify({ id: body.id, text: body.text });
    case 'delete':
      return JSON.stringify({ id: body.id });
  }
}

/**
 * What a received body says, or null when it does not follow its kind's schema. Such an entry
 * still counts in its author's log (the seq goes on); it just changes nothing on screen.
 * Text comes back cleaned like a channel message's (no control characters, trimmed), and file
 * names cleaned like the ones this side picks (dmFiles.ts).
 */
export function parseEntryBody(kind: EntryKind, body: string): EntryBody | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  switch (kind) {
    case 'msg': {
      const parsed = bodySchemas.msg.safeParse(value);
      if (!parsed.success) return null;
      const { id, replyTo, attachments } = parsed.data;
      const files = attachments.map((f) => ({ ...wireFile(f), name: cleanFileName(f.name) }));
      return { kind, id, text: cleanMessageContent(parsed.data.text), replyTo: replyTo ?? null, attachments: files };
    }
    case 'edit': {
      const parsed = bodySchemas.edit.safeParse(value);
      return parsed.success ? { kind, id: parsed.data.id, text: cleanMessageContent(parsed.data.text) } : null;
    }
    case 'delete': {
      const parsed = bodySchemas.delete.safeParse(value);
      return parsed.success ? { kind, id: parsed.data.id } : null;
    }
  }
}

/** A new message id: 16 random bytes in hex. */
export function newMessageId(): string {
  return randomBytes(16).toString('hex');
}

/** The exact bytes the author signs. */
export function entrySignedBytes(e: Pick<Entry, 'conv' | 'seq' | 'ts' | 'kind' | 'body'>): Uint8Array {
  const head = utf8(`${CRYPTO_LABELS.entry}\n${e.conv}\n${e.seq}\n${e.ts}\n${e.kind}\n`);
  return Buffer.concat([head, createHash('sha256').update(utf8(e.body)).digest()]);
}

export function signEntry(author: FriendKey, fields: EntryFields): Entry {
  return { ...fields, author: toBase64Url(author.publicKey), sig: toBase64Url(author.sign(entrySignedBytes(fields))) };
}

function bytesOf(text: string): Uint8Array | null {
  try {
    return fromBase64Url(text);
  } catch {
    return null;
  }
}

/** The author's key, or null when `author` is not one. */
export function entryAuthor(entry: Pick<Entry, 'author'>): Uint8Array | null {
  const key = bytesOf(entry.author);
  return key?.length === 32 ? key : null;
}

/** True only when the author's key signed exactly these fields. */
export function verifyEntry(entry: Entry): boolean {
  const author = entryAuthor(entry);
  const sig = bytesOf(entry.sig);
  return author !== null && sig !== null && verifyFriendSignature(author, entrySignedBytes(entry), sig);
}

/** The entry as JSON, in UTF-8 bytes (what the 64 KiB cap counts). */
export function entrySize(entry: Entry): number {
  return Buffer.byteLength(JSON.stringify(entry), 'utf8');
}

/** What the receiving side knows when an entry arrives. */
export interface EntryContext {
  /** The conversation this entry must belong to (the one shared with whoever sent it). */
  conv: string;
  /** Who may write in it. */
  members: readonly Uint8Array[];
  /** The highest seq stored for that author in that conversation (0 for none). */
  head(author: Uint8Array): number;
  /** The local clock. */
  now: number;
}

/**
 * ok: store it. bad-signature: whoever sent it closes the link. Anything else is dropped
 * without a word: duplicate (already here), gap (an earlier seq is missing), future (ts more
 * than 5 minutes ahead), too-large, not-member, other-conv.
 */
export type EntryVerdict = 'ok' | 'bad-signature' | 'not-member' | 'other-conv' | 'too-large' | 'future' | 'duplicate' | 'gap';

/** spec §4.2: the signature checks, the author is a member, seq is the author's next, ts is not far ahead. */
export function checkEntry(entry: Entry, ctx: EntryContext): EntryVerdict {
  if (entrySize(entry) > ENTRY_MAX_BYTES) return 'too-large';
  if (entry.conv !== ctx.conv) return 'other-conv';
  const author = entryAuthor(entry);
  if (!author) return 'bad-signature';
  if (!isMember(ctx.members, author)) return 'not-member';
  if (!verifyEntry(entry)) return 'bad-signature';
  if (entry.ts > ctx.now + ENTRY_MAX_FUTURE_MS) return 'future';
  const head = ctx.head(author);
  if (entry.seq <= head) return 'duplicate';
  if (entry.seq > head + 1) return 'gap';
  return 'ok';
}
