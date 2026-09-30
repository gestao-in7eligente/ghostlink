// Proxy mode (spec §8.5 "Atrás de um proxy TCP"): a platform such as Railway forwards ONE
// TCP port to the server and no UDP at all, so the public port carries both HTTPS/WSS and
// voice (LiveKit's ICE-TCP). The first byte of each connection tells them apart:
// - 0x16 opens a TLS handshake record: the socket goes to the HTTPS server, unread;
// - an ICE-TCP connection (RFC 4571) opens with the 2-byte length of its first frame, a
//   STUN binding request that LiveKit reads into 512 bytes (pion's TCP mux), so its first
//   byte is 0x00-0x02: the socket is piped to LiveKit's ICE-TCP port on 127.0.0.1;
// - anything else (a port scanner, plain HTTP) is closed.
import type { EventEmitter } from 'node:events';
import { connect, createServer, type Server, type Socket } from 'node:net';
import type { ServerLimits } from '../limits.js';

/** First byte of a TLS handshake record (the ClientHello). */
export const TLS_HANDSHAKE = 0x16;
/** The largest first byte of an ICE-TCP connection LiveKit accepts: a first frame of at most 512 bytes. */
export const ICE_MAX_FIRST_BYTE = 0x02;

export type PublicPortLimits = Pick<ServerLimits, 'firstByteTimeoutMs' | 'maxSockets' | 'maxIceTcpConnections'>;

export interface PublicPortDeps {
  /** Receives every TLS connection with its first bytes still unread (the HTTPS server's 'connection'). */
  tls: EventEmitter;
  /** The 127.0.0.1 port ICE-TCP is piped to (LiveKit's rtc.tcp_port), or null while there is none (voice down). */
  iceTarget(): number | null;
  limits: PublicPortLimits;
}

export interface PublicPort {
  /** The listener for the public port; also accepts sockets forwarded with emit('connection'). */
  readonly server: Server;
  /** ICE-TCP connections piped to LiveKit right now. */
  readonly icePipes: number;
  /** Destroys every connection this port accepted, whatever it became (shutdown). */
  destroyAll(): void;
}

/**
 * The public listener of proxy mode. Before a socket is classified it counts toward
 * `maxSockets` and must send a byte within `firstByteTimeoutMs`; after that, a TLS
 * socket has the HTTPS server's own protections (handshake deadline, per-socket caps)
 * and an ICE-TCP one counts toward `maxIceTcpConnections` until either side closes.
 */
export function createPublicPort(deps: PublicPortDeps): PublicPort {
  const open = new Set<Socket>();
  let pipes = 0;

  const pipe = (socket: Socket, port: number): void => {
    pipes++;
    const upstream = connect({ host: '127.0.0.1', port });
    // Media packets are small and a late one is useless: no Nagle on either leg.
    socket.setNoDelay(true);
    upstream.setNoDelay(true);
    let ended = false;
    const end = (): void => {
      if (ended) return;
      ended = true;
      pipes--;
      socket.destroy();
      upstream.destroy();
    };
    socket.on('close', end);
    upstream.on('close', end);
    socket.on('error', end);
    upstream.on('error', end);
    // pipe() pauses the reading side while the other one is full (backpressure); the first
    // chunk, put back with unshift(), goes first.
    socket.pipe(upstream);
    upstream.pipe(socket);
  };

  const accept = (socket: Socket): void => {
    if (socket.destroyed) return;
    if (open.size >= deps.limits.maxSockets) {
      socket.destroy();
      return;
    }
    open.add(socket);
    socket.once('close', () => open.delete(socket));
    socket.on('error', () => socket.destroy());
    const deadline = setTimeout(() => socket.destroy(), deps.limits.firstByteTimeoutMs);
    socket.once('close', () => clearTimeout(deadline));
    socket.once('data', (chunk: Buffer) => {
      clearTimeout(deadline);
      socket.pause();
      socket.unshift(chunk);
      const first = chunk[0]!;
      if (first === TLS_HANDSHAKE) {
        // The TLS socket reads what unshift() put back, then the rest from the handle.
        deps.tls.emit('connection', socket);
        return;
      }
      const port = first <= ICE_MAX_FIRST_BYTE && pipes < deps.limits.maxIceTcpConnections ? deps.iceTarget() : null;
      if (port === null) {
        socket.destroy();
        return;
      }
      pipe(socket, port);
    });
  };

  const server = createServer(accept);
  // The kernel-level cap for direct connections; `open` also covers the forwarded ones.
  server.maxConnections = deps.limits.maxSockets;
  return {
    server,
    get icePipes() {
      return pipes;
    },
    destroyAll() {
      for (const socket of open) socket.destroy();
    },
  };
}
