// Direct messages between friends (v0.3 phase 2, spec 2026-09-30-amigos-dm-p2p-design.md §4):
// conversations made of signed entries that the two computers sync directly. Shared by
// main, preload and renderer; the renderer only ever sees these plain shapes.
// Files (spec 2026-10-01-anexos-design.md §3) travel straight between the two computers too.
import type { AttachmentKind, AttachmentMeta } from '@ghostlink/shared';

/** One conversation in the Home sidebar. Groups (phase 4) add `kind: 'group'`, a name and members. */
export interface DmConversation {
  /** The conversation id (spec §4.1), 32 hex characters. */
  id: string;
  kind: 'dm';
  /** The friend key of the other person (base64url). */
  peer: string;
  /** The newest message, for the sidebar order and preview; null in an empty conversation. */
  lastTs: number | null;
  lastText: string | null;
  /** Messages from the other person after the read mark. */
  unread: number;
  /** Closed in the sidebar ("×"); a new message shows it again. */
  hidden: boolean;
}

export interface DmMessage {
  /** The message id chosen by its author (32 hex characters). */
  id: string;
  conv: string;
  /** The author's friend key (base64url). */
  author: string;
  mine: boolean;
  /** The author's clock (ms since the epoch); the display order. */
  ts: number;
  /** '' once deleted, and possibly '' when files go with it. */
  text: string;
  /** The message this one answers, or null. */
  replyTo: string | null;
  editedAt: number | null;
  deleted: boolean;
  /** Own messages: the other person's computer has it (spec §4.3). Always true for theirs. */
  delivered: boolean;
  /** The files sent with it, in order; [] for none and once deleted. */
  attachments: DmAttachment[];
}

/** What a file is, read from its bytes by whoever sent it. */
export type DmAttachmentKind = AttachmentKind;

/** A file as the signed `msg` entry describes it (attachments spec §3): the channels' shape plus its hash. */
export interface DmFileInfo extends AttachmentMeta {
  /** SHA-256 of the bytes, 64 lowercase hex characters: the file's address. */
  hash: string;
}

/**
 * Where a message's file is on this computer:
 * - ready: here, served at app://ghostlink/_dmfile/<hash>;
 * - absent: not here yet; it comes from the friend while they are online (images up to 5 MB by
 *   themselves, the rest on a click);
 * - loading: on its way from the friend (`received` bytes so far);
 * - failed: what came did not match its hash, or the friend no longer has it ("Tentar de novo").
 */
export type DmFileState = 'ready' | 'absent' | 'loading' | 'failed';

export interface DmAttachment extends DmFileInfo {
  state: DmFileState;
  /** Bytes received so far while loading. */
  received: number;
}

export type DmEvent =
  /** A message arrived or changed (edited, deleted, delivered). */
  | { type: 'message'; message: DmMessage }
  /** A conversation appeared or its summary changed (last message, unread, hidden). */
  | { type: 'conversation'; conversation: DmConversation }
  /** The other person is typing (expires after 5 s without another event). */
  | { type: 'typing'; conv: string; author: string }
  /** A message's file moved: it is coming, it arrived, it failed, or it went away. */
  | { type: 'file'; hash: string; state: DmFileState; received: number };

/** The longest message text, the same as in server channels. */
export const DM_TEXT_MAX = 4000;
/** Messages per history page. */
export const DM_PAGE = 50;
/** attachments spec §3: the largest file, and the most files in one message. */
export const DM_FILE_MAX_BYTES = 25 * 1024 * 1024;
export const DM_ATTACHMENTS_MAX = 10;
/** Images up to this size come by themselves while the friend is online; the rest on a click. */
export const DM_AUTO_FETCH_MAX_BYTES = 5 * 1024 * 1024;

/** A file to send: one that attach() kept, under the name to show. */
export interface DmFileRef {
  hash: string;
  name: string;
}

/** window.ghostlink.dm. Sending works offline: the message waits here until the friend is online. */
export interface DmApi {
  conversations(): Promise<DmConversation[]>;
  /** The 1:1 conversation with that friend, created (or shown again) if needed. */
  open(friendKey: string): Promise<DmConversation>;
  /** Closes the conversation in the sidebar without deleting anything. */
  hide(conv: string): Promise<void>;
  /** Up to `limit` messages older than `before` (null = the newest), oldest first. */
  history(conv: string, before: number | null, limit: number): Promise<DmMessage[]>;
  /** The text may be empty when files go with it; `files` come from attach(), in the order to show. */
  send(conv: string, text: string, replyTo: string | null, files?: DmFileRef[]): Promise<DmMessage>;
  edit(conv: string, id: string, text: string): Promise<DmMessage>;
  remove(conv: string, id: string): Promise<DmMessage>;
  /** Marks everything up to `ts` as read. */
  read(conv: string, ts: number): Promise<void>;
  /** "Digitando…", throttled by main to one signal every 3 s. */
  typing(conv: string): Promise<void>;
  /**
   * Keeps a file on this computer, ready to go with the next message (up to 25 MB, else
   * FILE_TOO_LARGE). Answers what the message will say about it; its type comes from the bytes.
   */
  attach(conv: string, name: string, bytes: Uint8Array): Promise<DmFileInfo>;
  /** Asks the friend for a message's file now ("Baixar" on a file not here yet, "Tentar de novo"). */
  fetchFile(conv: string, hash: string): Promise<void>;
  /** "Baixar" on a file that is here: asks where to save a copy; false when cancelled. Never opens it. */
  saveFile(conv: string, hash: string): Promise<boolean>;
  onEvent(cb: (event: DmEvent) => void): () => void;
}
