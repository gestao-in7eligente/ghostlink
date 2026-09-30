// The rules of friendship (friends spec §5.1, §5.3, with the limits of §3.2 and §3.4): who is
// asked, who asked, who is a friend, who is blocked, and what travels on a friend link. It works
// on the database alone; attach() gives it a network, detach() takes it away.
//
// One idea keeps it small: the firewall lets in exactly the people we reach for, those in state
// `friend` or `pending_out`. A link therefore only opens when both sides want the other.
import { randomBytes } from 'node:crypto';
import { LIMITS, sanitizeLabel } from '@ghostlink/shared';
import { AppError } from '../../shared/appErrors.js';
import type { Friend } from '../../shared/friendsTypes.js';
import type { Log } from '../log.js';
import { P2P_VERSION, decodeMessage, encodeMessage, wireNickname, type P2pMessage } from './frames.js';
import { INVITE_SECRET_BYTES, decodeFriendCode, encodeFriendCode, inboxPublicKey, inboxSeed, shortCode } from './friendCode.js';
import { keyToText, sameKey, type FriendKey } from './friendKey.js';
import { InboxLimiter, knock, serveInbox, type Timers } from './inbox.js';
import type { FriendRow, FriendsStore } from './store.js';
import type { FriendLink, FriendSwarm } from './swarm.js';

/** spec §3.4. Friends and requests sent share one limit: both are keys we reach for. */
export const FRIENDS_MAX = 500;
export const PENDING_IN_MAX = 100;
/** spec §3.3: presence and drop detection. */
export const PING_INTERVAL_MS = 20_000;
/** A link that stayed silent this long is gone (two pings went unanswered). */
export const LINK_TIMEOUT_MS = 50_000;
/** How long a link we said goodbye on may take to close by itself. */
export const HANG_UP_MS = 5_000;

/** spec §5.1: the pause before the n-th retry of a request: 5 s, doubling, 10 min at most. */
export function retryDelayMs(attempt: number): number {
  return Math.min(5_000 * 2 ** (attempt - 1), 600_000);
}

/** The part of FriendSwarm the rules use (tests give an in-memory one). */
export type FriendsNetwork = Pick<FriendSwarm, 'connectTo' | 'disconnectFrom' | 'onLink' | 'setInbox' | 'requestVia'>;

export interface FriendsDeps {
  store: Pick<FriendsStore, 'me' | 'setInviteSecret' | 'setInboxEnabled' | 'get' | 'list' | 'put' | 'remove' | 'count' | 'oldest'>;
  /** This person's friend key. */
  key: FriendKey;
  /** The global nickname (settings), announced in hello and in requests. */
  nickname(): string;
  /** Something the renderer shows has changed. */
  onChange(): void;
  log?: Pick<Log, 'info' | 'warn'>;
  now?: () => number;
  timers?: Timers;
  retryDelayMs?: (attempt: number) => number;
}

/** An open friend link. */
interface Session {
  link: FriendLink;
  /** The other side's hello arrived. */
  greeted: boolean;
  lastSeen: number;
  closed: boolean;
}

/** A request on its way to someone's inbox. */
interface Delivery {
  attempt: number;
  timer: unknown;
  link: FriendLink | null;
}

const hexOf = (key: Uint8Array) => Buffer.from(key).toString('hex');
const reaches = (row: FriendRow | undefined): row is FriendRow => row?.state === 'friend' || row?.state === 'pending_out';
const cleanNickname = (raw: string) => sanitizeLabel(raw, LIMITS.nicknameMaxVisible);

export class Friends {
  readonly #d: FriendsDeps;
  readonly #store: FriendsDeps['store'];
  readonly #key: FriendKey;
  readonly #now: () => number;
  readonly #timers: Timers;
  readonly #retryDelayMs: (attempt: number) => number;
  readonly #limiter: InboxLimiter;
  readonly #sessions = new Map<string, Session>();
  readonly #deliveries = new Map<string, Delivery>();
  readonly #inboxLinks = new Set<FriendLink>();
  #network: FriendsNetwork | null = null;
  #unsubscribe: (() => void) | null = null;
  #heartbeat: unknown = null;

  constructor(deps: FriendsDeps) {
    this.#d = deps;
    this.#store = deps.store;
    this.#key = deps.key;
    this.#now = deps.now ?? Date.now;
    this.#timers = deps.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout) };
    this.#retryDelayMs = deps.retryDelayMs ?? retryDelayMs;
    this.#limiter = new InboxLimiter(this.#now);
  }

  // What the renderer sees.

  /** This person's friend code (spec §2). */
  code(): string {
    return encodeFriendCode(this.#key.publicKey, this.#store.me.inviteSecret);
  }

  list(): Friend[] {
    return this.#store.list().map((row) => ({
      key: keyToText(row.key),
      shortCode: shortCode(row.key),
      nickname: row.nickname,
      localName: row.localName,
      state: row.state,
      online: row.state === 'friend' && this.#sessions.get(hexOf(row.key))?.greeted === true,
      since: row.since,
    }));
  }

  /** The firewall of the friend key (spec §3.2): friends and people we asked, nobody else. */
  allows(remoteKey: Uint8Array): boolean {
    return reaches(this.#store.get(remoteKey));
  }

  // What the person does.

  /** spec §5.1: the row exists when this returns; the request travels in the background. */
  add(code: string): void {
    const { friendPub, inviteSecret } = decodeFriendCode(code);
    if (sameKey(friendPub, this.#key.publicKey)) throw new AppError('FRIEND_SELF');
    const row = this.#store.get(friendPub);
    if (row?.state === 'friend') return;
    // Crossed requests: they asked, we ask, nobody has to accept.
    if (row?.state === 'pending_in') return this.accept(friendPub);
    if (row?.state !== 'pending_out') this.#checkLimit();
    this.#store.put({
      key: friendPub,
      nickname: row?.nickname ?? '',
      localName: row?.localName ?? null,
      state: 'pending_out',
      since: row?.state === 'pending_out' ? row.since : this.#now(),
      inviteSecret,
    });
    this.#network?.connectTo(friendPub);
    this.#deliver(friendPub);
    this.#d.onChange();
  }

  accept(key: Uint8Array): void {
    const row = this.#store.get(key);
    if (row?.state !== 'pending_in') return;
    this.#checkLimit();
    this.#befriend(row);
  }

  /** Declines a request received, cancels one sent, or unblocks. Never ends a friendship. */
  dismiss(key: Uint8Array): void {
    const row = this.#store.get(key);
    if (!row || row.state === 'friend') return;
    this.#part(key, false);
    this.#store.remove(key);
    this.#d.onChange();
  }

  /** spec §5.3: tells the friend when a link is open, stops reaching for them, closes the firewall to them. */
  remove(key: Uint8Array): void {
    if (this.#store.get(key)?.state !== 'friend') return;
    this.#part(key, true);
    this.#store.remove(key);
    this.#d.onChange();
  }

  /** spec §5.3: like remove, and the key stays as blocked: its requests are dropped without a sign. */
  block(key: Uint8Array): void {
    const row = this.#store.get(key);
    if (!row || row.state === 'blocked') return;
    this.#part(key, row.state === 'friend');
    this.#store.put({ ...row, state: 'blocked', since: this.#now(), inviteSecret: null });
    this.#d.onChange();
  }

  rename(key: Uint8Array, localName: string | null): void {
    const row = this.#store.get(key);
    if (!row) return;
    this.#store.put({ ...row, localName });
    this.#d.onChange();
  }

  /** spec §1.4: a new invite secret. The old code reaches nobody; friends stay. */
  newCode(): void {
    this.#store.setInviteSecret(randomBytes(INVITE_SECRET_BYTES));
    this.#applyInbox();
    this.#d.onChange();
  }

  /** spec §3.2: "Desligar pedidos por código" stops listening on the inbox. */
  setInbox(enabled: boolean): void {
    this.#store.setInboxEnabled(enabled);
    this.#applyInbox();
    this.#d.onChange();
  }

  /** The global nickname changed: open links hear the new one. */
  announceNickname(): void {
    for (const session of this.#sessions.values()) this.#hello(session.link);
  }

  // The network.

  /** The node is up: reach for friends and for the people we asked, open the inbox, resume requests. */
  attach(network: FriendsNetwork): void {
    this.detach();
    this.#network = network;
    this.#unsubscribe = network.onLink((link) => this.#safely(link, () => this.#onLink(link)));
    this.#applyInbox();
    for (const row of this.#store.list()) {
      if (!reaches(row)) continue;
      network.connectTo(row.key);
      if (row.state === 'pending_out' && row.inviteSecret) this.#deliver(row.key);
    }
    this.#heartbeat = this.#timers.setTimeout(() => this.#beat(), PING_INTERVAL_MS);
  }

  /** The node is going away: drop every link and timer. Everyone shows offline. */
  detach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#network = null;
    this.#timers.clearTimeout(this.#heartbeat);
    this.#heartbeat = null;
    for (const id of [...this.#deliveries.keys()]) this.#cancelDelivery(id);
    for (const link of [...this.#inboxLinks]) link.close();
    for (const [id, session] of [...this.#sessions]) {
      this.#sessions.delete(id);
      session.link.close();
    }
  }

  // Friend links (spec §3.3).

  #onLink(link: FriendLink): void {
    // The firewall let this key in a moment ago; a removal may have come in between.
    const row = this.#store.get(link.remoteKey);
    if (!reaches(row)) return link.close();
    const id = hexOf(link.remoteKey);
    const session: Session = { link, greeted: false, lastSeen: this.#now(), closed: false };
    const previous = this.#sessions.get(id);
    this.#sessions.set(id, session);
    previous?.link.close();
    // Greet before listening: whatever a message makes us say comes after our hello.
    this.#hello(link);
    if (row.state === 'friend') this.#send(link, { t: 'friend.accept' });
    link.onClose(() => {
      session.closed = true;
      if (this.#sessions.get(id) !== session) return;
      this.#sessions.delete(id);
      if (session.greeted) this.#d.onChange();
    });
    link.onData((data) => this.#safely(link, () => this.#onMessage(session, data)));
  }

  #onMessage(session: Session, data: Uint8Array): void {
    const { link } = session;
    const id = hexOf(link.remoteKey);
    if (this.#sessions.get(id) !== session) return;
    const message = decodeMessage(data); // a frame we refuse drops the link (#safely)
    session.lastSeen = this.#now();
    const row = this.#store.get(link.remoteKey);
    if (!row || (message.t !== 'hello' && !session.greeted)) return link.close();
    switch (message.t) {
      case 'hello': {
        const first = !session.greeted;
        session.greeted = true;
        // A hello without a nickname keeps the last one seen.
        const nickname = cleanNickname(message.nickname) || row.nickname;
        if (nickname !== row.nickname) this.#store.put({ ...row, nickname });
        if (first || nickname !== row.nickname) this.#d.onChange();
        return;
      }
      case 'friend.accept':
        if (row.state === 'pending_out') this.#befriend(row);
        return;
      case 'friend.remove':
        if (row.state !== 'friend') return;
        this.#part(link.remoteKey, false);
        this.#store.remove(link.remoteKey);
        this.#d.onChange();
        return;
      case 'ping':
        return this.#send(link, { t: 'pong' });
      case 'pong':
        return;
      default:
        // inbox.hello and friend.request belong to an inbox connection.
        return link.close();
    }
  }

  #beat(): void {
    const now = this.#now();
    for (const session of [...this.#sessions.values()]) {
      if (now - session.lastSeen >= LINK_TIMEOUT_MS) session.link.close();
      else this.#send(session.link, { t: 'ping' });
    }
    this.#heartbeat = this.#timers.setTimeout(() => this.#beat(), PING_INTERVAL_MS);
  }

  #hello(link: FriendLink): void {
    this.#send(link, { t: 'hello', v: P2P_VERSION, nickname: wireNickname(this.#d.nickname()) });
  }

  #send(link: FriendLink, message: P2pMessage): void {
    link.send(encodeMessage(message));
  }

  /** A failure while handling one link (a bad frame, a database error) costs that link, never the app. */
  #safely(link: FriendLink, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.#d.log?.warn(`[friends] dropping the link with ${shortCode(link.remoteKey)}: ${e instanceof Error ? e.message : String(e)}`);
      link.close();
    }
  }

  // Becoming friends, and parting.

  #checkLimit(): void {
    if (this.#store.count('friend', 'pending_out') >= FRIENDS_MAX) throw new AppError('FRIEND_LIMIT');
  }

  #befriend(row: FriendRow): void {
    this.#cancelDelivery(hexOf(row.key));
    this.#store.put({ ...row, state: 'friend', since: this.#now(), inviteSecret: null });
    this.#network?.connectTo(row.key);
    // On a link that is already open the other side may still be waiting for the answer.
    const session = this.#sessions.get(hexOf(row.key));
    if (session) this.#send(session.link, { t: 'friend.accept' });
    this.#d.log?.info(`[friends] ${shortCode(row.key)} is a friend now`);
    this.#d.onChange();
  }

  /** Lets go of a key: no request on its way, no reaching for it, no link (with a goodbye when asked). */
  #part(key: Uint8Array, farewell: boolean): void {
    const id = hexOf(key);
    this.#cancelDelivery(id);
    this.#network?.disconnectFrom(key);
    const session = this.#sessions.get(id);
    if (!session) return;
    this.#sessions.delete(id);
    if (!farewell) return session.link.close();
    this.#send(session.link, { t: 'friend.remove' });
    if (session.closed) return;
    // end() delivers the goodbye before closing; the other side hangs up when it reads it.
    session.link.end();
    const timer = this.#timers.setTimeout(() => session.link.close(), HANG_UP_MS);
    session.link.onClose(() => this.#timers.clearTimeout(timer));
  }

  // Requests we send (spec §5.1).

  #deliver(key: Uint8Array): void {
    const id = hexOf(key);
    this.#cancelDelivery(id);
    if (!this.#network) return;
    const delivery: Delivery = { attempt: 0, timer: null, link: null };
    this.#deliveries.set(id, delivery);
    this.#knock(key, delivery);
  }

  #knock(key: Uint8Array, delivery: Delivery): void {
    const id = hexOf(key);
    const current = () => this.#deliveries.get(id) === delivery;
    const row = this.#store.get(key);
    if (!this.#network || row?.state !== 'pending_out' || !row.inviteSecret) {
      if (current()) this.#deliveries.delete(id);
      return;
    }
    const retry = () => {
      if (!current()) return;
      delivery.attempt++;
      delivery.timer = this.#timers.setTimeout(() => this.#knock(key, delivery), this.#retryDelayMs(delivery.attempt));
    };
    this.#network
      .requestVia(inboxPublicKey(row.key, row.inviteSecret))
      .then(async (link) => {
        if (!current()) return link.close();
        delivery.link = link;
        const taken = await knock(link, { friendPub: row.key, nickname: wireNickname(this.#d.nickname()), timers: this.#timers });
        delivery.link = null;
        if (!current()) return;
        if (!taken) return retry();
        this.#deliveries.delete(id);
        // It arrived: the person's invite secret is not needed any more.
        const now = this.#store.get(key);
        if (now?.state === 'pending_out') this.#store.put({ ...now, inviteSecret: null });
        this.#d.log?.info(`[friends] the request reached ${shortCode(key)}`);
      }, retry)
      .catch((e: unknown) => this.#d.log?.warn(`[friends] request to ${shortCode(key)} failed: ${e instanceof Error ? e.message : String(e)}`));
  }

  #cancelDelivery(id: string): void {
    const delivery = this.#deliveries.get(id);
    if (!delivery) return;
    this.#deliveries.delete(id);
    this.#timers.clearTimeout(delivery.timer);
    delivery.link?.close();
  }

  // Requests we receive (spec §3.2).

  #applyInbox(): void {
    if (!this.#network) return;
    const me = this.#store.me;
    const opts = me.inboxEnabled
      ? {
          seed: inboxSeed(this.#key.publicKey, me.inviteSecret),
          allow: (remoteKey: Uint8Array) => this.#inboxAllows(remoteKey),
          onLink: (link: FriendLink) => this.#safely(link, () => this.#onInboxLink(link)),
        }
      : null;
    const network = this.#network;
    network.setInbox(opts).catch((e: unknown) => {
      // A node that was stopped meanwhile refuses the change; that is no news.
      if (this.#network === network) this.#d.log?.warn(`[friends] the inbox did not change: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  /** The inbox's firewall: never a blocked key; people we already reach for do not count against the limits. */
  #inboxAllows(remoteKey: Uint8Array): boolean {
    if (sameKey(remoteKey, this.#key.publicKey)) return false;
    const row = this.#store.get(remoteKey);
    if (row?.state === 'blocked') return false;
    return reaches(row) || this.#limiter.admit();
  }

  #onInboxLink(link: FriendLink): void {
    const row = this.#store.get(link.remoteKey);
    if (row?.state === 'blocked' || (!reaches(row) && !this.#limiter.track(link))) return link.close();
    this.#inboxLinks.add(link);
    link.onClose(() => this.#inboxLinks.delete(link));
    // A request that cannot be stored drops the connection unfinished, so the asker tries again later.
    serveInbox(link, { key: this.#key, timers: this.#timers, onRequest: (from, nickname) => this.#safely(link, () => this.#onRequest(from, nickname)) });
  }

  #onRequest(from: Uint8Array, rawNickname: string): void {
    const row = this.#store.get(from);
    const nickname = cleanNickname(rawNickname) || row?.nickname || '';
    switch (row?.state) {
      case 'blocked':
        return;
      case 'pending_out':
        // Crossed requests become a friendship without anyone accepting (spec §5.1).
        return this.#befriend({ ...row, nickname });
      case 'friend':
        // They lost us and ask again: reach for them now, the link's hello answers.
        this.#network?.connectTo(from);
        if (nickname === row.nickname) return;
        this.#store.put({ ...row, nickname });
        break;
      case 'pending_in':
        if (nickname === row.nickname) return;
        this.#store.put({ ...row, nickname });
        break;
      default: {
        if (this.#store.count('pending_in') >= PENDING_IN_MAX) {
          const oldest = this.#store.oldest('pending_in');
          if (oldest) this.#store.remove(oldest.key);
        }
        this.#store.put({ key: from, nickname, localName: null, state: 'pending_in', since: this.#now(), inviteSecret: null });
        this.#d.log?.info(`[friends] request from ${shortCode(from)}`);
      }
    }
    this.#d.onChange();
  }
}
