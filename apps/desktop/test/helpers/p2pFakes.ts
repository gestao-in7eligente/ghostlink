// In-memory stand-ins for the P2P network, so the friends rules run without a DHT:
// links that deliver at once, a clock that only moves when told to, and a world in which
// nodes reach each other the way FriendSwarm lets them (both firewalls must agree).
import { randomBytes } from 'node:crypto';
import { decodeMessage, type P2pMessage } from '../../src/main/p2p/frames.js';
import { friendKeyFromSeed } from '../../src/main/p2p/friendKey.js';
import type { FriendLink, InboxOptions } from '../../src/main/p2p/swarm.js';

export const hexOf = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/** Lets every pending promise callback run. */
export const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** One end of an in-memory link. What it sends reaches the other end at once. */
export class FakeLink implements FriendLink {
  peer!: FakeLink;
  /** Every frame this end sent, in order. */
  readonly sent: Uint8Array[] = [];
  closed = false;
  ended = false;
  readonly #data = new Set<(data: Uint8Array) => void>();
  readonly #end = new Set<() => void>();
  readonly #close = new Set<() => void>();
  /** Like a stream: what arrives before anyone listens waits for the first listener. */
  #waiting: Uint8Array[] = [];

  constructor(
    readonly remoteKey: Uint8Array,
    readonly handshakeHash: Uint8Array,
  ) {}

  /** The messages this end sent (frames that do not decode throw). */
  get messages(): P2pMessage[] {
    return this.sent.map((frame) => decodeMessage(frame));
  }

  send(data: Uint8Array): void {
    if (this.closed || this.ended) return;
    this.sent.push(data);
    this.peer.#receive(data);
  }

  onData(listener: (data: Uint8Array) => void): void {
    this.#data.add(listener);
    for (const data of this.#waiting.splice(0)) listener(data);
  }

  onEnd(listener: () => void): void {
    this.#end.add(listener);
  }

  onClose(listener: () => void): void {
    this.#close.add(listener);
  }

  end(): void {
    if (this.closed || this.ended) return;
    this.ended = true;
    for (const listener of this.peer.#end) listener();
    // Both sides finished: the stream closes by itself.
    if (this.peer.ended) this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.#close) listener();
    this.peer.close();
  }

  #receive(data: Uint8Array): void {
    if (this.closed) return;
    if (this.#data.size === 0) this.#waiting.push(data);
    else for (const listener of this.#data) listener(data);
  }
}

/** Two connected ends: `a` is what the node with key `aKey` holds (its remoteKey is bKey). */
export function linkPair(aKey: Uint8Array, bKey: Uint8Array): [a: FakeLink, b: FakeLink] {
  const hash = randomBytes(64);
  const a = new FakeLink(bKey, hash);
  const b = new FakeLink(aKey, hash);
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/** setTimeout/clearTimeout and a clock that move only with advance(). */
export class ManualTimers {
  now = 1_700_000_000_000;
  #next = 1;
  readonly #pending = new Map<number, { at: number; fn: () => void }>();

  readonly setTimeout = (fn: () => void, ms: number): number => {
    const id = this.#next++;
    this.#pending.set(id, { at: this.now + ms, fn });
    return id;
  };

  readonly clearTimeout = (id: unknown): void => {
    this.#pending.delete(id as number);
  };

  get pending(): number {
    return this.#pending.size;
  }

  /** Moves the clock, running every timer that comes due (in order), then lets promises settle. */
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.#pending.entries()].filter(([, t]) => t.at <= end).sort((x, y) => x[1].at - y[1].at || x[0] - y[0])[0];
      if (!due) break;
      this.#pending.delete(due[0]);
      this.now = Math.max(this.now, due[1].at);
      due[1].fn();
      await flush();
    }
    this.now = end;
    await flush();
  }
}

/** A node of the fake world: the part of FriendSwarm the friends rules use. */
export class FakeNode {
  /** Keys this node keeps reaching for (connectTo without a later disconnectFrom). */
  readonly wanted = new Set<string>();
  readonly links = new Map<string, FakeLink>();
  readonly listeners = new Set<(link: FriendLink) => void>();
  inbox: InboxOptions | null = null;
  online = true;
  /** Every inbox key this node knocked on. */
  readonly knocked: string[] = [];

  constructor(
    readonly world: FakeWorld,
    readonly key: Uint8Array,
    readonly allows: (remoteKey: Uint8Array) => boolean,
  ) {}

  connectTo(remoteKey: Uint8Array): void {
    this.wanted.add(hexOf(remoteKey));
    this.world.tryLink(this, remoteKey);
  }

  disconnectFrom(remoteKey: Uint8Array): void {
    this.wanted.delete(hexOf(remoteKey));
  }

  onLink(listener: (link: FriendLink) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setInbox(opts: InboxOptions | null): Promise<void> {
    this.inbox = opts;
    return Promise.resolve();
  }

  get inboxKey(): string | null {
    return this.inbox && hexOf(friendKeyFromSeed(this.inbox.seed).publicKey);
  }

  requestVia(inboxKey: Uint8Array): Promise<FriendLink> {
    this.knocked.push(hexOf(inboxKey));
    const owner = [...this.world.nodes.values()].find((n) => n.online && n.inboxKey === hexOf(inboxKey));
    if (!this.online || !owner?.inbox || !owner.inbox.allow(this.key)) return Promise.reject(new Error('unreachable'));
    // The asker's remote is the inbox key; the owner sees who knocked (the friend key).
    const hash = randomBytes(64);
    const mine = new FakeLink(inboxKey, hash);
    const theirs = new FakeLink(this.key, hash);
    mine.peer = theirs;
    theirs.peer = mine;
    this.world.inboxLinks.push({ asker: mine, owner: theirs });
    owner.inbox.onLink(theirs);
    return Promise.resolve(mine);
  }

  /** The machine goes away: every link drops, nothing new opens. */
  goOffline(): void {
    this.online = false;
    for (const link of [...this.links.values()]) link.close();
  }
}

/** Nodes that can reach each other; a friend link opens only when both firewalls allow it. */
export class FakeWorld {
  readonly nodes = new Map<string, FakeNode>();
  readonly inboxLinks: { asker: FakeLink; owner: FakeLink }[] = [];

  node(key: Uint8Array, allows: (remoteKey: Uint8Array) => boolean): FakeNode {
    const node = new FakeNode(this, key, allows);
    this.nodes.set(hexOf(key), node);
    return node;
  }

  tryLink(from: FakeNode, toKey: Uint8Array): void {
    const to = this.nodes.get(hexOf(toKey));
    if (!to || !from.online || !to.online || from.links.has(hexOf(toKey))) return;
    if (!from.allows(toKey) || !to.allows(from.key)) return;
    const [a, b] = linkPair(from.key, to.key);
    from.links.set(hexOf(to.key), a);
    to.links.set(hexOf(from.key), b);
    a.onClose(() => from.links.get(hexOf(to.key)) === a && from.links.delete(hexOf(to.key)));
    b.onClose(() => to.links.get(hexOf(from.key)) === b && to.links.delete(hexOf(from.key)));
    for (const listener of from.listeners) listener(a);
    for (const listener of to.listeners) listener(b);
  }

  /** What Hyperswarm's retries do over time: every node reaches again for the keys it wants. */
  async settle(): Promise<void> {
    await flush();
    for (const node of this.nodes.values()) {
      for (const wanted of node.wanted) this.tryLink(node, Buffer.from(wanted, 'hex'));
    }
    await flush();
  }
}
