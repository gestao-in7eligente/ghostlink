// One inbox connection (friends spec §3.2, §5.1). The inbox key can be derived by anyone who
// holds the friend code, so the owner speaks first and proves itself with the friend key
// (inbox.hello); only then does the asker send its single friend.request, with the proof that
// it holds the whole code and not only the inbox key (the DHT sees that key), and the owner
// finishes the connection. A clean finish is the asker's sign that the request arrived.
import { fromBase64Url, toBase64Url } from '@ghostlink/shared';
import { MAX_INBOX_REQUEST_BYTES, decodeMessage, encodeMessage, type P2pMessage } from './frames.js';
import { checkRequestProof, requestProof, signInboxProof, verifyInboxProof, type FriendKey } from './friendKey.js';
import type { FriendLink } from './swarm.js';

/** spec §3.2: connections from unknown keys, at once and per hour. */
export const INBOX_MAX_OPEN = 8;
export const INBOX_MAX_PER_HOUR = 30;
/** An inbox connection lives this long at most, on both sides. */
export const INBOX_TIMEOUT_MS = 10_000;
const HOUR_MS = 60 * 60 * 1000;

/** setTimeout and clearTimeout, injectable so tests own the clock. */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** A message of an inbox connection (at most 1 KiB), or null for anything else. */
function read(data: Uint8Array): P2pMessage | null {
  try {
    return decodeMessage(data, MAX_INBOX_REQUEST_BYTES);
  } catch {
    return null;
  }
}

function signatureBytes(sig: string): Uint8Array {
  try {
    return fromBase64Url(sig);
  } catch {
    return new Uint8Array(0);
  }
}

export interface ServeInboxOptions {
  /** The owner's friend key: it signs the proof. */
  key: FriendKey;
  /** The owner's current invite secret: a request must prove it knows it. */
  inviteSecret: Uint8Array;
  timers: Timers;
  /** `from` is the friend key of whoever knocked, authenticated by the connection itself. */
  onRequest(from: Uint8Array, nickname: string): void;
}

/** The owner's side: proves itself, takes one friend.request, finishes. Anything else drops the connection. */
export function serveInbox(link: FriendLink, opts: ServeInboxOptions): void {
  const deadline = opts.timers.setTimeout(() => link.close(), INBOX_TIMEOUT_MS);
  link.onClose(() => opts.timers.clearTimeout(deadline));
  let taken = false;
  link.onData((data) => {
    const message = taken ? null : read(data);
    if (message?.t !== 'friend.request' || !checkRequestProof(opts.inviteSecret, link.handshakeHash, signatureBytes(message.proof))) return link.close();
    taken = true;
    opts.onRequest(link.remoteKey, message.nickname);
    link.end();
  });
  link.send(encodeMessage({ t: 'inbox.hello', sig: toBase64Url(signInboxProof(opts.key, link.handshakeHash)) }));
}

export interface KnockOptions {
  /** The friend key from the code: the only key whose proof is accepted. */
  friendPub: Uint8Array;
  /** The invite secret from the code: proves the asker holds the whole code. */
  inviteSecret: Uint8Array;
  /** The asker's nickname, sent with the request. */
  nickname: string;
  timers: Timers;
}

/**
 * The asker's side. Resolves true once the owner proved itself, got the request and finished
 * the connection; false for a fake inbox, a dropped connection or silence. Always closes the link.
 */
export function knock(link: FriendLink, opts: KnockOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let proven = false;
    let taken = false;
    const deadline = opts.timers.setTimeout(() => link.close(), INBOX_TIMEOUT_MS);
    link.onClose(() => {
      opts.timers.clearTimeout(deadline);
      resolve(taken);
    });
    link.onEnd(() => {
      taken = proven;
      link.end();
    });
    // Last, so that nothing the owner already said is handled before the listeners above exist.
    link.onData((data) => {
      // The owner says one thing only: its proof. Whoever cannot give it never sees the request.
      const message = proven ? null : read(data);
      if (message?.t !== 'inbox.hello' || !verifyInboxProof(opts.friendPub, link.handshakeHash, signatureBytes(message.sig))) return link.close();
      proven = true;
      link.send(encodeMessage({ t: 'friend.request', nickname: opts.nickname, proof: toBase64Url(requestProof(opts.inviteSecret, link.handshakeHash)) }));
    });
  });
}

/** spec §3.2: at most 8 inbox connections from unknown keys at once and 30 per hour. */
export class InboxLimiter {
  readonly #now: () => number;
  #admitted: number[] = [];
  #open = 0;

  constructor(now: () => number) {
    this.#now = now;
  }

  /** The firewall's question: true lets one more connection start, and counts it for the hour. */
  admit(): boolean {
    const since = this.#now() - HOUR_MS;
    this.#admitted = this.#admitted.filter((at) => at > since);
    if (this.#open >= INBOX_MAX_OPEN || this.#admitted.length >= INBOX_MAX_PER_HOUR) return false;
    this.#admitted.push(this.#now());
    return true;
  }

  /** Counts an open connection until it closes; false when it is one too many (the caller closes it). */
  track(link: FriendLink): boolean {
    if (this.#open >= INBOX_MAX_OPEN) return false;
    this.#open++;
    link.onClose(() => this.#open--);
    return true;
  }
}
