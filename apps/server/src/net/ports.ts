// Busy-port detection (spec §8.5) and protection against port shadowing on Windows.
//
// Windows lets two processes listen on the same TCP port when one binds a specific
// address (127.0.0.1) and the other the wildcard (0.0.0.0): connections then go to
// the more specific binding. SO_EXCLUSIVEADDRUSE would prevent it, but Node/libuv
// offer no way to set it on a TCP listener (`exclusive` only concerns cluster
// workers). Hence: (1) before listening, a port counts as taken when ANY relevant
// address cannot be bound or 127.0.0.1 already answers; (2) after listening on the
// wildcard, the server also holds 127.0.0.1 and each local IPv4 (guardAddresses),
// so no other program can bind them later.
import { createSocket } from 'node:dgram';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { networkInterfaces } from 'node:os';

export interface PortProbe {
  free: boolean;
  /** The addresses where the port is taken ("tcp" bind failures and answering listeners). */
  busyOn: string[];
}

const WILDCARD = new Set(['0.0.0.0', '::', '']);

export function isWildcardHost(host: string): boolean {
  return WILDCARD.has(host);
}

/** Every IPv4 address of this machine (virtual and pseudo interfaces included: all can be bound). */
export function allLocalIPv4(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const e of entries ?? []) {
      const family: unknown = e.family;
      if ((family === 'IPv4' || family === 4) && !out.includes(e.address)) out.push(e.address);
    }
  }
  return out;
}

export function tryBindTcp(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen({ port, host, exclusive: true }, () => s.close(() => resolve(true)));
  });
}

export function tryBindUdp(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createSocket({ type: 'udp4', reuseAddr: false });
    s.once('error', () => {
      s.close();
      resolve(false);
    });
    s.bind({ port, address: host, exclusive: true }, () => s.close(() => resolve(true)));
  });
}

/** True when something accepts a TCP connection on host:port. */
export function tcpAnswers(port: number, host = '127.0.0.1', timeoutMs = 750): Promise<boolean> {
  return new Promise((resolve) => {
    const socket: Socket = connect({ port, host });
    const done = (answered: boolean) => {
      socket.destroy();
      resolve(answered);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Whether TCP `port` is really free for a server that will bind `bindHost`.
 * Bind tests run one after the other (a test socket is closed before the next).
 */
export async function probeTcpPort(port: number, opts: { bindHost?: string; localIps?: string[] } = {}): Promise<PortProbe> {
  const bindHost = opts.bindHost ?? '0.0.0.0';
  const wildcard = isWildcardHost(bindHost);
  const hosts = wildcard ? ['0.0.0.0', '127.0.0.1', ...(opts.localIps ?? allLocalIPv4())] : [bindHost];
  const busyOn: string[] = [];
  for (const host of [...new Set(hosts)]) {
    if (!(await tryBindTcp(port, host))) busyOn.push(host);
  }
  const connectHost = wildcard ? '127.0.0.1' : bindHost;
  if (!busyOn.includes(connectHost) && (await tcpAnswers(port, connectHost))) busyOn.push(connectHost);
  return { free: busyOn.length === 0, busyOn };
}

/** UDP (LiveKit's 7882): taken when 0.0.0.0 or 127.0.0.1 cannot be bound. */
export async function probeUdpPort(port: number): Promise<PortProbe> {
  const busyOn: string[] = [];
  for (const host of ['0.0.0.0', '127.0.0.1']) {
    if (!(await tryBindUdp(port, host))) busyOn.push(host);
  }
  return { free: busyOn.length === 0, busyOn };
}

/** spec §8.5: the next free port after `start`, in steps of 10 (7710, 7720, …); null when none within `tries`. */
export async function findFreeTcpPort(
  start: number,
  opts: { bindHost?: string; step?: number; tries?: number; probe?: (port: number) => Promise<PortProbe> } = {},
): Promise<number | null> {
  const step = opts.step ?? 10;
  const probe = opts.probe ?? ((p: number) => probeTcpPort(p, { bindHost: opts.bindHost }));
  for (let i = 1; i <= (opts.tries ?? 20); i++) {
    const port = start + i * step;
    if (port > 65_535) return null;
    if ((await probe(port)).free) return port;
  }
  return null;
}

/** The same shape as Node's listen error, so callers handle one code (the CLI exits 2). */
export function portInUseError(port: number, host: string, busyOn: string[]): Error & { code: 'EADDRINUSE'; port: number; busyOn: string[] } {
  return Object.assign(new Error(`listen EADDRINUSE: address already in use ${host}:${port} (taken on ${busyOn.join(', ')})`), {
    code: 'EADDRINUSE' as const,
    port,
    busyOn,
  });
}

/**
 * Windows only: after `server` listens on the wildcard, also hold `port` on each
 * specific address and hand those connections to `server`. Another program can then
 * no longer bind 127.0.0.1:port (or a LAN IP) and steal the local connections.
 * Best effort: an address that cannot be bound is skipped.
 */
export async function guardAddresses(server: Server, port: number, addresses: readonly string[]): Promise<Server[]> {
  const guards: Server[] = [];
  for (const address of [...new Set(addresses)]) {
    const guard = createServer((socket) => server.emit('connection', socket));
    const ok = await new Promise<boolean>((resolve) => {
      guard.once('error', () => resolve(false));
      guard.listen({ port, host: address, exclusive: true }, () => resolve(true));
    });
    if (ok) {
      guard.on('error', () => {});
      guards.push(guard);
    }
  }
  return guards;
}
