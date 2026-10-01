// Minimal types for the untyped Holepunch packages: only what the P2P engine calls.
declare module 'hyperdht' {
  import type { EventEmitter } from 'node:events';

  export interface BootstrapNode {
    host: string;
    port: number;
  }
  export interface DhtOptions {
    bootstrap?: BootstrapNode[];
    /** The address the UDP sockets bind to (default: every interface). */
    host?: string;
  }
  export interface KeyPair {
    publicKey: Buffer;
    secretKey: Buffer;
  }
  /**
   * @hyperswarm/secret-stream: the Noise-encrypted stream between two keys (a streamx Duplex;
   * each write arrives as one `data`). Events: open, data, end (the other side called end()),
   * close, error.
   */
  export interface SecretStream extends EventEmitter {
    readonly remotePublicKey: Buffer;
    /** The Noise handshake hash (64 bytes), equal on both ends; null until the stream opened. */
    readonly handshakeHash: Buffer | null;
    write(data: Uint8Array): boolean;
    /** Flushes what was written, then closes the writing side. */
    end(): void;
    destroy(error?: Error): void;
  }
  export interface DhtServerOptions {
    /** Return true to REJECT that key; the handshake is then never answered. */
    firewall?: (remotePublicKey: Buffer) => boolean;
  }
  export interface DhtServer extends EventEmitter {
    /** Announces the key pair on the DHT and accepts connections to it. */
    listen(keyPair: KeyPair): Promise<DhtServer>;
    close(): Promise<void>;
  }
  export default class DHT {
    constructor(opts?: DhtOptions);
    /** The Ed25519 key pair of a 32-byte seed (libsodium crypto_sign_seed_keypair). */
    static keyPair(seed?: Buffer): KeyPair;
    createServer(opts: DhtServerOptions, onconnection: (conn: SecretStream) => void): DhtServer;
    /** Connects to whoever listens on that key, as `keyPair` (the node's default one otherwise). */
    connect(remotePublicKey: Buffer, opts?: { keyPair?: KeyPair }): SecretStream;
    destroy(): Promise<void>;
  }
}

declare module 'hyperdht/testnet.js' {
  import type { BootstrapNode } from 'hyperdht';
  export interface Testnet {
    bootstrap: BootstrapNode[];
    destroy(): Promise<void>;
  }
  /** A private DHT on 127.0.0.1 with `size` nodes, for tests and the self-test. */
  export default function createTestnet(size?: number): Promise<Testnet>;
}

declare module 'hyperswarm' {
  import type { EventEmitter } from 'node:events';
  import type DHT from 'hyperdht';
  import type { BootstrapNode, KeyPair, SecretStream } from 'hyperdht';

  export type SwarmConnection = SecretStream;
  /** What the swarm remembers about a key. */
  export interface PeerInfo {
    readonly publicKey: Buffer;
    /** A banned peer is refused and never dialled again, until ban(false). */
    ban(banned: boolean): void;
    /** True when nothing (a ban, joinPeer, a pending retry) needs the record any more. */
    shouldGC(): boolean;
  }
  export interface HyperswarmOptions {
    /** 32 bytes; the node's Ed25519 key pair is derived from it. */
    seed?: Buffer;
    bootstrap?: BootstrapNode[];
    dht?: DHT;
    /** Return true to REJECT that key: incoming connections and outgoing attempts alike. */
    firewall?: (remotePublicKey: Buffer) => boolean;
  }
  /** Events: connection (conn), ban (peerInfo, error): the firewall refused that key. */
  export default class Hyperswarm extends EventEmitter {
    constructor(opts?: HyperswarmOptions);
    readonly keyPair: KeyPair;
    readonly dht: DHT;
    /** Known peers by the hex of their key. */
    readonly peers: Map<string, PeerInfo>;
    listen(): Promise<void>;
    joinPeer(publicKey: Buffer): void;
    leavePeer(publicKey: Buffer): void;
    destroy(): Promise<void>;
  }
}
