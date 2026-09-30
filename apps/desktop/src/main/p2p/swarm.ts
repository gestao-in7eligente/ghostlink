// The P2P node of the friends feature (spec 2026-09-30 §3.1, §3.2): one Hyperswarm instance
// whose key is the friend key. It listens on that key, connects to explicit peers and
// refuses every incoming key the caller does not allow, before a connection opens.
import DHT, { type BootstrapNode } from 'hyperdht';
import Hyperswarm, { type SwarmConnection } from 'hyperswarm';

/** An encrypted, authenticated connection to one peer; each send() arrives as one onData(). */
export interface FriendLink {
  readonly remoteKey: Uint8Array;
  send(data: Uint8Array): void;
  onData(listener: (data: Uint8Array) => void): void;
  onClose(listener: () => void): void;
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

export class FriendSwarm {
  readonly #swarm: Hyperswarm;
  readonly #listeners = new Set<(link: FriendLink) => void>();

  private constructor(swarm: Hyperswarm) {
    this.#swarm = swarm;
    swarm.on('connection', (conn: SwarmConnection) => this.#accept(conn));
  }

  /** Creates the node and starts listening on its key. */
  static async start(opts: FriendSwarmOptions): Promise<FriendSwarm> {
    const dht = new DHT({
      ...(opts.bootstrap ? { bootstrap: opts.bootstrap } : {}),
      ...(opts.bindHost ? { host: opts.bindHost } : {}),
    });
    const swarm = new Hyperswarm({ seed: Buffer.from(opts.seed), dht, firewall: (remoteKey) => !opts.allow(remoteKey) });
    const node = new FriendSwarm(swarm);
    await swarm.listen();
    return node;
  }

  get publicKey(): Uint8Array {
    return this.#swarm.keyPair.publicKey;
  }

  /** Keeps trying to reach that peer until stop(); a link shows up in onLink on both sides. */
  connectTo(remoteKey: Uint8Array): void {
    this.#swarm.joinPeer(Buffer.from(remoteKey));
  }

  /** Called for every link, whoever opened it. Returns the unsubscribe function. */
  onLink(listener: (link: FriendLink) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Closes every link and leaves the DHT. */
  async stop(): Promise<void> {
    await this.#swarm.destroy();
  }

  #accept(conn: SwarmConnection): void {
    // A dropped peer is normal (it shows as onClose), never an unhandled 'error'.
    conn.on('error', () => {});
    const link: FriendLink = {
      remoteKey: conn.remotePublicKey,
      send: (data) => void conn.write(data),
      onData: (listener) => void conn.on('data', listener),
      onClose: (listener) => void conn.on('close', listener),
      close: () => conn.destroy(),
    };
    for (const listener of this.#listeners) listener(link);
  }
}
