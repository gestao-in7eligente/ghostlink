// Keeping two computers' copies of a conversation the same (friends spec §4.3), over one
// friend's link at a time:
//   1. when the link comes up, each side sends sync.have: the conversations it shares with that
//      person and, per author, the highest seq it holds;
//   2. each side asks with sync.want for what it lacks (at most 500 entries per answer, the rest
//      in the next round) and gets the entries back in seq order;
//   3. a new local entry goes out at once to the friend whose link is up.
// After taking entries, a side answers with its sync.have again (a moment later, once for a
// burst): that is how the author learns its messages were delivered.
//
// Pull, not push: an entry that arrives with a gap (the earlier ones are missing) is dropped, but
// it tells this side how far the author's log goes, and the missing range is asked for.
import { fromBase64Url, toBase64Url } from '@ghostlink/shared';
import { dmConversationId, dmMembers, isMember } from './conversations.js';
import { entryAuthor, type Entry, type EntryVerdict } from './entries.js';
import type { ConversationMessage, P2pMessage } from './frames.js';
import { keyToText, sameKey } from './friendKey.js';
import type { PeerLink } from './friends.js';
import type { Timers } from './inbox.js';
import type { DmStore, StoredEntry } from './store.js';

/** spec §3.4: entries in one answer to sync.want. */
export const WANT_MAX = 500;
/** How long after taking entries this side says what it now has. */
export const ACK_DELAY_MS = 100;

const hexOf = (key: Uint8Array) => Buffer.from(key).toString('hex');

/** A stored entry as it travels. */
export function wireEntry(e: StoredEntry): Entry {
  return { conv: e.conv, author: keyToText(e.author), seq: e.seq, ts: e.ts, kind: e.kind, body: e.body, sig: toBase64Url(e.sig) };
}

/** A checked entry as it is stored. */
export function storedEntry(e: Entry, author: Uint8Array): StoredEntry {
  return { conv: e.conv, author, seq: e.seq, ts: e.ts, kind: e.kind, body: e.body, sig: fromBase64Url(e.sig) };
}

export interface SyncDeps {
  /** This person's friend key. */
  me: Uint8Array;
  store: Pick<DmStore, 'conversation' | 'head' | 'heads' | 'entries'>;
  /** Checks and stores an entry that `peer` sent; throws when the link must close (a bad signature). */
  accept(peer: Uint8Array, entry: Entry): EntryVerdict;
  /** The other person holds our own entries of `conv` up to `seq`. */
  delivered(conv: string, seq: number): void;
  timers: Timers;
}

/** One friend whose link is up. */
interface Peer {
  key: Uint8Array;
  link: PeerLink;
  /** conv → author (hex) → the highest seq that friend holds, as far as we know. */
  remote: Map<string, Map<string, number>>;
  /** "conv/author" → the last seq of the sync.want on its way. */
  wanted: Map<string, number>;
  /** The sync.have that answers entries just taken. */
  ack: unknown;
}

export class ConversationSync {
  readonly #d: SyncDeps;
  readonly #peers = new Map<string, Peer>();

  constructor(deps: SyncDeps) {
    this.#d = deps;
  }

  /** A friend's link came up: say what we have. */
  up(key: Uint8Array, link: PeerLink): void {
    const previous = this.#peers.get(hexOf(key));
    if (previous) this.#forget(previous);
    const peer: Peer = { key, link, remote: new Map(), wanted: new Map(), ack: null };
    this.#peers.set(hexOf(key), peer);
    this.#have(peer);
  }

  down(key: Uint8Array, link: PeerLink): void {
    const peer = this.#peers.get(hexOf(key));
    if (peer?.link === link) this.#forget(peer);
  }

  isUp(key: Uint8Array): boolean {
    return this.#peers.has(hexOf(key));
  }

  /** Sends to that friend when their link is up; false when it is not. */
  send(key: Uint8Array, message: P2pMessage): boolean {
    const peer = this.#peers.get(hexOf(key));
    if (!peer) return false;
    peer.link.send(message);
    return true;
  }

  /** A new entry of ours: out at once when the friend's link is up, else their next sync.have asks for it. */
  push(key: Uint8Array, entry: Entry): boolean {
    return this.send(key, { t: 'entry', entry });
  }

  /** sync.have, sync.want or entry from a friend (typing is not ours). */
  receive(key: Uint8Array, message: ConversationMessage, link: PeerLink): void {
    const peer = this.#peers.get(hexOf(key));
    if (peer?.link !== link) return;
    switch (message.t) {
      case 'sync.have':
        return this.#onHave(peer, message.convs);
      case 'sync.want':
        return this.#onWant(peer, message);
      case 'entry':
        return this.#onEntry(peer, message.entry);
      case 'typing':
        return;
    }
  }

  dispose(): void {
    for (const peer of [...this.#peers.values()]) this.#forget(peer);
  }

  #forget(peer: Peer): void {
    this.#peers.delete(hexOf(peer.key));
    this.#d.timers.clearTimeout(peer.ack);
    peer.ack = null;
  }

  /** The conversations shared with that friend: in this phase, the 1:1 one. */
  #shared(peer: Peer): string[] {
    return [dmConversationId(this.#d.me, peer.key)];
  }

  #members(peer: Peer): Uint8Array[] {
    return dmMembers(this.#d.me, peer.key);
  }

  /** Our sync.have: the shared conversations this computer has, with every author's head. */
  #have(peer: Peer): void {
    const { store } = this.#d;
    const convs = this.#shared(peer)
      .filter((id) => store.conversation(id) !== undefined)
      .map((id) => ({ id, heads: Object.fromEntries(store.heads(id).map((h) => [keyToText(h.author), h.seq])) }));
    peer.link.send({ t: 'sync.have', convs });
  }

  #onHave(peer: Peer, convs: { id: string; heads: Record<string, number> }[]): void {
    const shared = this.#shared(peer);
    const members = this.#members(peer);
    for (const { id, heads } of convs) {
      // Only what we share with that person; anything else is none of their business.
      if (!shared.includes(id)) continue;
      const remote = this.#remote(peer, id);
      for (const [text, seq] of Object.entries(heads)) {
        const author = entryAuthor({ author: text });
        if (!author || !isMember(members, author)) continue;
        remote.set(hexOf(author), seq);
        if (sameKey(author, this.#d.me)) this.#d.delivered(id, seq);
      }
      this.#want(peer, id);
    }
  }

  #onWant(peer: Peer, want: { conv: string; author: string; from: number; to: number }): void {
    const { store } = this.#d;
    if (!this.#shared(peer).includes(want.conv) || store.conversation(want.conv) === undefined) return;
    const author = entryAuthor(want);
    if (!author || !isMember(this.#members(peer), author)) return;
    const to = Math.min(want.to, want.from + WANT_MAX - 1);
    for (const entry of store.entries(want.conv, author, want.from, to)) peer.link.send({ t: 'entry', entry: wireEntry(entry) });
  }

  #onEntry(peer: Peer, entry: Entry): void {
    const verdict = this.#d.accept(peer.key, entry); // a bad signature throws: the link drops
    if (verdict !== 'ok' && verdict !== 'gap' && verdict !== 'duplicate') return;
    // Past checkEntry's membership test, so the author is a member of a shared conversation.
    const author = entryAuthor(entry)!;
    const remote = this.#remote(peer, entry.conv);
    // An entry, even one that came too early, shows how far that author's log goes.
    remote.set(hexOf(author), Math.max(remote.get(hexOf(author)) ?? 0, entry.seq));
    const slot = `${entry.conv}/${hexOf(author)}`;
    const until = peer.wanted.get(slot);
    if (until !== undefined && this.#d.store.head(entry.conv, author) >= until) peer.wanted.delete(slot);
    if (verdict === 'ok') this.#ack(peer);
    this.#want(peer, entry.conv);
  }

  /** Asks for what that friend holds and we lack, one range per author at a time. */
  #want(peer: Peer, conv: string): void {
    for (const [authorHex, seq] of this.#remote(peer, conv)) {
      const slot = `${conv}/${authorHex}`;
      const author = Buffer.from(authorHex, 'hex');
      const local = this.#d.store.head(conv, author);
      if (seq <= local || peer.wanted.has(slot)) continue;
      const to = Math.min(seq, local + WANT_MAX);
      peer.wanted.set(slot, to);
      peer.link.send({ t: 'sync.want', conv, author: keyToText(author), from: local + 1, to });
    }
  }

  #remote(peer: Peer, conv: string): Map<string, number> {
    let remote = peer.remote.get(conv);
    if (!remote) {
      remote = new Map();
      peer.remote.set(conv, remote);
    }
    return remote;
  }

  /** Our sync.have, a moment after taking entries: one answer for a whole burst. */
  #ack(peer: Peer): void {
    if (peer.ack !== null) return;
    peer.ack = this.#d.timers.setTimeout(() => {
      peer.ack = null;
      if (this.#peers.get(hexOf(peer.key)) === peer) this.#have(peer);
    }, ACK_DELAY_MS);
  }
}
