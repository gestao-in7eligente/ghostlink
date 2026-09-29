import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net';

/** What went through one forwarded connection. */
export interface ForwardedConnection {
  /** 0x16: TLS; 0x00-0x02: ICE-TCP; null: nothing sent yet. */
  firstByte: number | null;
  /** Bytes from the client to the server, and back. */
  up: number;
  down: number;
}

/**
 * A stand-in for Railway's TCP proxy (spec §8.6): listens on an "external" host:port and
 * forwards every connection, byte for byte, to the server's public port on 127.0.0.1.
 * It records what went through each connection.
 */
export class FakeTcpProxy {
  readonly connections: ForwardedConnection[] = [];
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();

  constructor(readonly target: number) {
    this.#server = createServer((client) => {
      const upstream = connect({ host: '127.0.0.1', port: this.target });
      for (const s of [client, upstream]) {
        this.#sockets.add(s);
        s.setNoDelay(true);
        s.on('error', () => {});
        s.once('close', () => this.#sockets.delete(s));
      }
      const seen: ForwardedConnection = { firstByte: null, up: 0, down: 0 };
      this.connections.push(seen);
      client.on('data', (chunk: Buffer) => {
        seen.firstByte ??= chunk[0]!;
        seen.up += chunk.length;
      });
      upstream.on('data', (chunk: Buffer) => (seen.down += chunk.length));
      client.pipe(upstream);
      upstream.pipe(client);
      client.once('close', () => upstream.destroy());
      upstream.once('close', () => client.destroy());
    });
  }

  /** Connections that started like ICE-TCP (an RFC 4571 length, not a TLS record). */
  get iceConnections(): ForwardedConnection[] {
    return this.connections.filter((c) => c.firstByte !== null && c.firstByte <= 0x02);
  }

  get tlsConnections(): ForwardedConnection[] {
    return this.connections.filter((c) => c.firstByte === 0x16);
  }

  get port(): number {
    return (this.#server.address() as AddressInfo).port;
  }

  listen(port = 0, host = '127.0.0.1'): Promise<this> {
    return new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen({ port, host, exclusive: true }, () => {
        this.#server.off('error', reject);
        resolve(this);
      });
    });
  }

  close(): Promise<void> {
    for (const s of this.#sockets) s.destroy();
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }
}
