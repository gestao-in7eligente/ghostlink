// The P2P node of the friends feature (spec 2026-09-30 §3.1, §3.2): one Hyperswarm instance
// whose key is the friend key. It listens on that key, connects to explicit peers and
// refuses every incoming key the caller does not allow, before a connection opens.
// The inbox is a second listener, on the key only a holder of the friend code can derive.
import DHT, { type BootstrapNode, type DhtServer, type SecretStream } from 'hyperdht';
import Hyperswarm, { type PeerInfo } from 'hyperswarm';

/** An encrypted, authenticated connection to one peer; each send() arrives as one onData(). */
export interface FriendLink {
  readonly remoteKey: Uint8Array;
  /** The Noise handshake hash: 64 bytes, the same on both ends and different for every connection. */
  readonly handshakeHash: Uint8Array;
  send(data: Uint8Array): void;
  onData(listener: (data: Uint8Array) => void): void;
  /** The other side called end(): it finished on purpose. Never fires when the link just drops. */
  onEnd(listener: () => void): void;
  onClose(listener: () => void): void;
  /** Delivers what was sent, then closes this side. */
  end(): void;
  close(): void;
}

export interface FriendSwarmOptions {
  /** 32 bytes; the node's key pair comes from it (the friend seed, spec §2). */
  seed: Uint8Array;
  /** The firewall: true lets that remote key connect to us. */
  allow(remoteKey: Uint8Array): boolean;
  /** DHT bootstrap nodes; default: Hyperswarm's public ones. */
  bootstrap?: BootstrapNode[];
  /** Bind address of the UDP sockets; tests and the self-test use 127.0.0.1. */
  bindHost?: string;
}

export interface InboxOptions {
  /** 32 bytes; the inbox listens on the Ed25519 key of this seed (friendCode.ts). */
  seed: Uint8Array;
  /** The inbox's own firewall: false refuses that key before a connection opens. */
  allow(remoteKey: Uint8Array): boolean;
  /** Called for every inbox connection; `remoteKey` is the friend key of whoever knocked. */
  onLink(link: FriendLink): void;
}

/** How long requestVia() waits for the inbox to answer. */
export const REQUEST_TIMEOUT_MS = 30_000;

function linkOf(conn: SecretStream, handshakeHash: Uint8Array): FriendLink {
  return {
    remoteKey: conn.remotePublicKey,
    handshakeHash,
    send: (data) => void conn.write(data),
    onData: (listener) => void conn.on('data', listener),
    onEnd: (listener) => void conn.on('end', listener),
    onClose: (listener) => void conn.on('close', listener),
    end: () => conn.end(),
    close: () => conn.destroy(),
  };
}

export class FriendSwarm {
  readonly #swarm: Hyperswarm;
  readonly #listeners = new Set<(link: FriendLink) => void>();
  #inbox: DhtServer | null = null;
  /** Inbox changes run one after the other. */
  #inboxQueue: Promise<void> = Promise.resolve();
  #stopped = false;

  private constructor(swarm: Hyperswarm) {
    this.#swarm = swarm;
    swarm.on('connection', (conn: SecretStream) => this.#accept(conn));
    // Hyperswarm bans for good every key its firewall refused, going out as well as coming in.
    // Our allow-list changes while the app runs (a request is accepted, a block is lifted), so a
    // refusal must not outlive the moment it was made; forgetting it also keeps strangers who
    // knock from piling up in memory.
    swarm.on('ban', (peer: PeerInfo) => {
      peer.ban(false);
      if (peer.shouldGC()) swarm.peers.delete(peer.publicKey.toString('hex'));
    });
  }

  /** Creates the node: the native modules load and the sockets are made, nothing is announced yet. */
  static create(opts: FriendSwarmOptions): FriendSwarm {
    const dht = new DHT({
      ...(opts.bootstrap ? { bootstrap: opts.bootstrap } : {}),
      ...(opts.bindHost ? { host: opts.bindHost } : {}),
    });
    return new FriendSwarm(new Hyperswarm({ seed: Buffer.from(opts.seed), dht, firewall: (remoteKey) => !opts.allow(remoteKey) }));
  }

  /** Creates the node and starts listening on its key. */
  static async start(opts: FriendSwarmOptions): Promise<FriendSwarm> {
    const node = FriendSwarm.create(opts);
    await node.listen();
    return node;
  }

  /** Announces the friend key on the DHT; resolves once others can find it. */
  async listen(): Promise<void> {
    await this.#swarm.listen();
  }

  get publicKey(): Uint8Array {
    return this.#swarm.keyPair.publicKey;
  }

  /**
   * Keeps trying to reach that peer until disconnectFrom() or stop(); a link shows up in onLink
   * on both sides. The key must already pass allow(): the firewall also drops outgoing attempts.
   */
  connectTo(remoteKey: Uint8Array): void {
    this.#swarm.joinPeer(Buffer.from(remoteKey));
  }

  /** Stops reaching for that peer. An open link stays until someone closes it. */
  disconnectFrom(remoteKey: Uint8Array): void {
    this.#swarm.leavePeer(Buffer.from(remoteKey));
  }

  /** Called for every link, whoever opened it. Returns the unsubscribe function. */
  onLink(listener: (link: FriendLink) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * spec §3.2: opens the inbox on that seed's key (closing the one open before), or closes it
   * with null. Resolves once the change is on the DHT.
   */
  setInbox(opts: InboxOptions | null): Promise<void> {
    const change = this.#inboxQueue.then(async () => {
      if (this.#stopped) throw new Error('the P2P node has stopped');
      const previous = this.#inbox;
      this.#inbox = null;
      if (previous) await previous.close();
      if (!opts) return;
      const server = this.#swarm.dht.createServer({ firewall: (remoteKey) => !opts.allow(remoteKey) }, (conn) => {
        conn.on('error', () => {});
        if (conn.handshakeHash) opts.onLink(linkOf(conn, conn.handshakeHash));
        else conn.destroy();
      });
      this.#inbox = server;
      await server.listen(DHT.keyPair(Buffer.from(opts.seed)));
    });
    this.#inboxQueue = change.catch(() => {});
    return change;
  }

  /**
   * Knocks on someone's inbox as the friend key. Resolves with the link once it opened;
   * rejects when nobody listens there, the inbox refuses this key, or it takes too long.
   */
  requestVia(inboxKey: Uint8Array, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<FriendLink> {
    return new Promise((resolve, reject) => {
      if (this.#stopped) return reject(new Error('the P2P node has stopped'));
      const conn = this.#swarm.dht.connect(Buffer.from(inboxKey), { keyPair: this.#swarm.keyPair });
      let failure: Error | null = null;
      const timer = setTimeout(() => conn.destroy(new Error('the inbox did not answer in time')), timeoutMs);
      conn.on('error', (e: Error) => {
        failure = e;
      });
      conn.once('open', () => {
        clearTimeout(timer);
        if (conn.handshakeHash) resolve(linkOf(conn, conn.handshakeHash));
        else conn.destroy();
      });
      // After resolve() this is a no-op.
      conn.once('close', () => {
        clearTimeout(timer);
        reject(failure ?? new Error('the inbox closed the connection'));
      });
    });
  }

  /** Closes every link and the inbox, and leaves the DHT. */
  async stop(): Promise<void> {
    this.#stopped = true;
    // Destroying the DHT closes every server that listens on it, the inbox included.
    await this.#swarm.destroy();
  }

  #accept(conn: SecretStream): void {
    // A dropped peer is normal (it shows as onClose), never an unhandled 'error'.
    conn.on('error', () => {});
    if (!conn.handshakeHash) return conn.destroy();
    const link = linkOf(conn, conn.handshakeHash);
    for (const listener of this.#listeners) listener(link);
  }
}
