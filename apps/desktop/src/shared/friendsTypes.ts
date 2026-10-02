// Friends (v0.3, spec 2026-09-30-amigos-dm-p2p-design.md): people added by friend code, reached
// directly over P2P. Shared by main, preload and renderer. The renderer never sees a key's
// private half nor talks to the P2P network: it asks main and gets snapshots back.

/**
 * pending_out: you asked, waiting for the other side. pending_in: they asked, waiting for you.
 * friend: both agreed. blocked: their requests are dropped silently.
 */
export type FriendState = 'pending_out' | 'pending_in' | 'friend' | 'blocked';

export interface Friend {
  /** The friend key: base64url of the 32-byte Ed25519 public key. The row's id. */
  key: string;
  /**
   * hex(SHA-256(friend key))[0:32]: a server's member id computed over this key (the server's
   * userIdFromPublicKey). The profile card looks a member up by it (spec 2026-10-02-cartao-de-perfil §3).
   */
  userId: string;
  /** The first 8 characters of the person's code after "GLF1-" (dashes removed), to compare out of band. */
  shortCode: string;
  /** The nickname the person announced, as last seen; '' before the first contact. */
  nickname: string;
  /** A nickname chosen here for that person; null shows `nickname`. */
  localName: string | null;
  state: FriendState;
  /** A direct link is open right now (only ever true for state 'friend'). */
  online: boolean;
  /** When the row reached its current state (ms since the epoch). */
  since: number;
}

export interface FriendsSnapshot {
  /** Increases with every change; the renderer drops older snapshots. */
  revision: number;
  /** The P2P engine is up (identity ready, `available` on, native modules loaded). */
  running: boolean;
  /** "Ficar disponível para amigos" (spec §3.1); off = the engine neither announces nor connects. */
  available: boolean;
  /** This person's friend code ("GLF1-XXXX-…"); null without a usable identity. */
  code: string | null;
  /** Requests by code are accepted (the inbox listens, spec §3.2). */
  inboxEnabled: boolean;
  friends: Friend[];
}

/** What a friend code looks like, without checking its checksum (main does that). */
export const FRIEND_CODE_SHAPE = /^GLF1(-?[A-Z2-7]{4}){21}$/;

/** A pasted code as main expects it: trimmed, upper case, no spaces; null when it cannot be a code. */
export function normalizeFriendCode(input: string): string | null {
  const code = input.trim().toUpperCase().replace(/\s+/g, '');
  return FRIEND_CODE_SHAPE.test(code) ? code : null;
}

/** The longest local nickname (the same cap as server nicknames). */
export const FRIEND_LOCAL_NAME_MAX = 32;

/**
 * window.ghostlink.friends. Every call returns the snapshot after the change; onChange also
 * fires for changes that come from the network (a request arrived, a friend went online).
 */
export interface FriendsApi {
  state(): Promise<FriendsSnapshot>;
  /** Sends a request to that code's owner (spec §5.1). FRIEND_CODE_INVALID, FRIEND_SELF, FRIEND_LIMIT. */
  add(code: string): Promise<FriendsSnapshot>;
  /** Accepts a pending_in request. */
  accept(key: string): Promise<FriendsSnapshot>;
  /** Forgets a row that is not a friendship: declines pending_in, cancels pending_out, unblocks. */
  dismiss(key: string): Promise<FriendsSnapshot>;
  /** Ends a friendship (tells the other side when a link is open). */
  remove(key: string): Promise<FriendsSnapshot>;
  /** Blocks that key, whatever its state. */
  block(key: string): Promise<FriendsSnapshot>;
  /** Sets or clears (null) the local nickname. */
  rename(key: string, localName: string | null): Promise<FriendsSnapshot>;
  /** A new invite secret: the old code stops working, current friends stay (spec §1.4). */
  newCode(): Promise<FriendsSnapshot>;
  setInbox(enabled: boolean): Promise<FriendsSnapshot>;
  setAvailable(enabled: boolean): Promise<FriendsSnapshot>;
  onChange(cb: (snapshot: FriendsSnapshot) => void): () => void;
}
