// Minimal types for the untyped Holepunch packages: only what the P2P engine calls.
declare module 'hyperdht' {
  export interface BootstrapNode {
    host: string;
    port: number;
  }
  export interface DhtOptions {
    bootstrap?: BootstrapNode[];
    /** The address the UDP sockets bind to (default: every interface). */
    host?: string;
  }
  export default class DHT {
    constructor(opts?: DhtOptions);
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
  import type { BootstrapNode } from 'hyperdht';

  /** The encrypted stream between two peers (a streamx Duplex; each write arrives as one `data`). */
  export interface SwarmConnection extends EventEmitter {
    readonly remotePublicKey: Buffer;
    write(data: Uint8Array): boolean;
    destroy(error?: Error): void;
  }
  export interface HyperswarmOptions {
    /** 32 bytes; the node's Ed25519 key pair is derived from it. */
    seed?: Buffer;
    bootstrap?: BootstrapNode[];
    dht?: DHT;
    /** Return true to REJECT an incoming connection from that key. */
    firewall?: (remotePublicKey: Buffer) => boolean;
  }
  export default class Hyperswarm extends EventEmitter {
    constructor(opts?: HyperswarmOptions);
    readonly keyPair: { publicKey: Buffer; secretKey: Buffer };
    listen(): Promise<void>;
    joinPeer(publicKey: Buffer): void;
    leavePeer(publicKey: Buffer): void;
    destroy(): Promise<void>;
  }
}
