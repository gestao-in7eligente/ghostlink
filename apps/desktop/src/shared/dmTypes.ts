// Direct messages between friends (v0.3 phase 2, spec 2026-09-30-amigos-dm-p2p-design.md §4):
// conversations made of signed entries that the two computers sync directly. Shared by
// main, preload and renderer; the renderer only ever sees these plain shapes.

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
  /** '' once deleted. */
  text: string;
  /** The message this one answers, or null. */
  replyTo: string | null;
  editedAt: number | null;
  deleted: boolean;
  /** Own messages: the other person's computer has it (spec §4.3). Always true for theirs. */
  delivered: boolean;
}

export type DmEvent =
  /** A message arrived or changed (edited, deleted, delivered). */
  | { type: 'message'; message: DmMessage }
  /** A conversation appeared or its summary changed (last message, unread, hidden). */
  | { type: 'conversation'; conversation: DmConversation }
  /** The other person is typing (expires after 5 s without another event). */
  | { type: 'typing'; conv: string; author: string };

/** The longest message text, the same as in server channels. */
export const DM_TEXT_MAX = 4000;
/** Messages per history page. */
export const DM_PAGE = 50;

/** window.ghostlink.dm. Sending works offline: the message waits here until the friend is online. */
export interface DmApi {
  conversations(): Promise<DmConversation[]>;
  /** The 1:1 conversation with that friend, created (or shown again) if needed. */
  open(friendKey: string): Promise<DmConversation>;
  /** Closes the conversation in the sidebar without deleting anything. */
  hide(conv: string): Promise<void>;
  /** Up to `limit` messages older than `before` (null = the newest), oldest first. */
  history(conv: string, before: number | null, limit: number): Promise<DmMessage[]>;
  send(conv: string, text: string, replyTo: string | null): Promise<DmMessage>;
  edit(conv: string, id: string, text: string): Promise<DmMessage>;
  remove(conv: string, id: string): Promise<DmMessage>;
  /** Marks everything up to `ts` as read. */
  read(conv: string, ts: number): Promise<void>;
  /** "Digitando…", throttled by main to one signal every 3 s. */
  typing(conv: string): Promise<void>;
  onEvent(cb: (event: DmEvent) => void): () => void;
}
