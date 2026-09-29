import { parseArgs } from 'node:util';
import { z } from 'zod';
import { ProtocolError, type JoinMode } from '@ghostlink/shared';
import {
  consoleLogger,
  createNetModule,
  defaultModules,
  findFreeTcpPort,
  probeTcpPort,
  probeUdpPort,
  startServer,
  type GhostServer,
  type LocalAddress,
  type Logger,
  type NetModuleOptions,
  type NetStatus,
  type ServerInfo,
  type UpnpProtocol,
} from '@ghostlink/server';
import { LineRing } from './hostLogs.js';

/** Control requests from the parent (spec §9); each carries an id that its reply echoes. */
export type HostRequest =
  | { cmd: 'status' }
  | { cmd: 'logs' }
  | { cmd: 'invite'; maxUses?: number; expiresInHours?: number }
  | { cmd: 'reset-owner' };

/** Parent → hosted server. `shutdown` needs no reply: the process exits. */
export type HostCommand = { cmd: 'shutdown' } | (HostRequest & { id: number });

/**
 * Hosted server → parent. `code` is the errno/ProtocolError code of a startup failure
 * (e.g. EADDRINUSE), with the next free port when the port was busy (spec §8.5).
 */
export type HostMessage =
  | { type: 'ready'; port: number }
  | { type: 'error'; message: string; code?: string; suggestedPort?: number | null }
  | { type: 'reply'; id: number; ok: true; value: unknown }
  | { type: 'reply'; id: number; ok: false; error: string };

/** The reply to `status`. */
export interface HostedStatus extends ServerInfo {
  port: number;
  serverKeyId: string;
  version: string;
  localAddresses: LocalAddress[];
  net: NetStatus;
  /** LiveKit's public ports already taken by another program before the server started, e.g. "UDP 7882". */
  busyMediaPorts: string[];
}

/** What the utility process needs from `process.parentPort` (a fake in tests). */
export interface ParentPortLike {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  postMessage(message: HostMessage): void;
}

export interface HostArgs {
  dataDir: string;
  port: number;
  host: string;
  /** spec §9: Host mode always passes --upnp. */
  upnp?: boolean;
  nodeIp?: string;
  /** First run only (they seed server_meta). */
  name?: string;
  joinMode?: JoinMode;
  maxMembers?: number;
}

/** spec §8.5: LiveKit's public media ports (UDP mux and ICE-TCP), mapped and checked with the server's port. */
export const MEDIA_PORTS: ReadonlyArray<{ protocol: UpnpProtocol; port: number }> = [
  { protocol: 'UDP', port: 7882 },
  { protocol: 'TCP', port: 7881 },
];

const HOST_JOIN_MODES: readonly JoinMode[] = ['invite', 'open'];

/**
 * `--data <dir> --port <n> [--host <ip>] [--upnp] [--node-ip=<ip>] [--name=<text>]
 * [--join-mode=invite|open] [--max-members=<n>]`. The host defaults to loopback (no
 * firewall prompt). The parent passes `--name=<text>` in one piece, so a name that
 * starts with "-" can never be read as an option.
 */
export function parseHostArgs(argv: string[]): HostArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      data: { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
      upnp: { type: 'boolean' },
      'node-ip': { type: 'string' },
      name: { type: 'string' },
      'join-mode': { type: 'string' },
      'max-members': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values.data) throw new Error('--data is required');
  const port = Number(values.port ?? '');
  if (!/^\d{1,5}$/.test(values.port ?? '') || port > 65535) throw new Error('--port must be 0..65535');
  const args: HostArgs = { dataDir: values.data, port, host: values.host ?? '127.0.0.1' };
  if (values.upnp) args.upnp = true;
  if (values['node-ip'] !== undefined) args.nodeIp = values['node-ip'];
  if (values.name !== undefined) args.name = values.name;
  if (values['join-mode'] !== undefined) {
    const mode = values['join-mode'] as JoinMode;
    if (!HOST_JOIN_MODES.includes(mode)) throw new Error('--join-mode must be invite or open');
    args.joinMode = mode;
  }
  if (values['max-members'] !== undefined) {
    const text = values['max-members'];
    const n = Number(text);
    if (!/^\d{1,6}$/.test(text) || n < 1) throw new Error('--max-members must be a positive whole number');
    args.maxMembers = n;
  }
  return args;
}

const id = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const requestSchema = z.discriminatedUnion('cmd', [
  z.strictObject({ id, cmd: z.literal('status') }),
  z.strictObject({ id, cmd: z.literal('logs') }),
  z.strictObject({
    id,
    cmd: z.literal('invite'),
    maxUses: z.number().int().min(1).max(10_000).optional(),
    expiresInHours: z.number().positive().max(24 * 365).optional(),
  }),
  z.strictObject({ id, cmd: z.literal('reset-owner') }),
]);

function isShutdown(data: unknown): data is { cmd: 'shutdown' } {
  return typeof data === 'object' && data !== null && (data as { cmd?: unknown }).cmd === 'shutdown';
}

function requestId(data: unknown): number | null {
  const value = typeof data === 'object' && data !== null ? (data as { id?: unknown }).id : undefined;
  return id.safeParse(value).success ? (value as number) : null;
}

/** Tees every log line into the ring the `logs` command returns. */
function ringLogger(inner: Logger, ring: LineRing): Logger {
  const tee = (level: 'info' | 'warn' | 'error') => (msg: string, meta?: object) => {
    ring.push(`${new Date().toISOString()} ${level} ${msg}${meta === undefined ? '' : ` ${JSON.stringify(meta)}`}`);
    inner[level](msg, meta);
  };
  return { info: tee('info'), warn: tee('warn'), error: tee('error') };
}

function errorCodeOf(e: unknown): string | undefined {
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

/** "UDP 7882"-style labels of the media ports another program already holds. */
export async function busyMediaPorts(bindHost: string, ports = MEDIA_PORTS): Promise<string[]> {
  const busy: string[] = [];
  for (const p of ports) {
    const probe = p.protocol === 'UDP' ? await probeUdpPort(p.port, { bindHost }) : await probeTcpPort(p.port, { bindHost });
    if (!probe.free) busy.push(`${p.protocol} ${p.port}`);
  }
  return busy;
}

export interface HostedServerDeps {
  exit(code: number): void;
  start?: typeof startServer;
  logger?: Logger;
  /** Test seams for the net module (interfaces, UPnP discovery) and the media-port check. */
  localAddresses?: NetModuleOptions['localAddresses'];
  discover?: NetModuleOptions['discover'];
  mediaPorts?: typeof MEDIA_PORTS;
}

/**
 * The body of the hosted-server utility process (spec §9): starts the server with
 * the `net` module (addresses, UPnP, node_ip) first, reports `{ type: 'ready', port }`,
 * answers `status`, `logs`, `invite` and `reset-owner`, and on `{ cmd: 'shutdown' }`
 * closes it gracefully (UPnP mappings removed) and exits 0. Any startup failure is
 * reported as `{ type: 'error' }` followed by exit code 1.
 */
export async function runHostedServer(port: ParentPortLike, argv: string[], deps: HostedServerDeps): Promise<void> {
  const ring = new LineRing();
  const logger = ringLogger(deps.logger ?? consoleLogger, ring);
  let server: GhostServer;
  let args: HostArgs;
  let mediaBusy: string[] = [];
  const net = (a: HostArgs) =>
    createNetModule({
      upnp: a.upnp,
      manageAddresses: true,
      bindHost: a.host,
      nodeIp: a.nodeIp,
      mediaPorts: [...(deps.mediaPorts ?? MEDIA_PORTS)],
      localAddresses: deps.localAddresses,
      discover: deps.discover,
    });
  let netModule: ReturnType<typeof net>;
  try {
    args = parseHostArgs(argv);
    netModule = net(args);
    mediaBusy = await busyMediaPorts(args.host, deps.mediaPorts ?? MEDIA_PORTS);
    if (mediaBusy.length > 0) logger.warn(`media ports already in use by another program: ${mediaBusy.join(', ')}`);
    server = await (deps.start ?? startServer)({
      dataDir: args.dataDir,
      port: args.port,
      host: args.host,
      name: args.name,
      joinMode: args.joinMode,
      maxMembers: args.maxMembers,
      logger,
      // `net` first: voice waits (bounded) for its first UPnP answer and announces its node_ip
      // (the router's WAN IP, else the LAN), following later changes (spec §8.1).
      modules: [netModule, ...defaultModules()],
      // An explicit --node-ip wins in voice as well.
      voice: args.nodeIp === undefined ? undefined : { nodeIp: args.nodeIp },
    });
  } catch (e) {
    const code = errorCodeOf(e);
    const message: HostMessage = { type: 'error', message: e instanceof Error ? e.message : String(e), ...(code === undefined ? {} : { code }) };
    if (code === 'EADDRINUSE' && argv.length > 0) {
      try {
        const a = parseHostArgs(argv);
        message.suggestedPort = await findFreeTcpPort(a.port, { bindHost: a.host });
      } catch {
        message.suggestedPort = null;
      }
    }
    port.postMessage(message);
    deps.exit(1);
    return;
  }

  const handle = async (request: HostRequest): Promise<unknown> => {
    switch (request.cmd) {
      case 'status': {
        const netStatus = await netModule.refresh();
        const status: HostedStatus = {
          port: server.port,
          serverKeyId: server.serverKeyId,
          version: server.version,
          ...server.info(),
          localAddresses: netStatus.localAddresses,
          net: netStatus,
          busyMediaPorts: mediaBusy,
        };
        return status;
      }
      case 'logs':
        return ring.lines();
      case 'invite':
        return server.createInvite({ maxUses: request.maxUses, expiresInHours: request.expiresInHours });
      case 'reset-owner':
        logger.info('owner recovery: a new setup code was issued');
        return { setupCode: server.resetSetupCode() };
    }
  };

  let stopping = false;
  port.on('message', ({ data }) => {
    if (isShutdown(data)) {
      if (stopping) return;
      stopping = true;
      server.close().then(
        () => deps.exit(0),
        () => deps.exit(1),
      );
      return;
    }
    const replyId = requestId(data);
    if (replyId === null) return; // not a request of ours
    const parsed = requestSchema.safeParse(data);
    if (!parsed.success) {
      port.postMessage({ type: 'reply', id: replyId, ok: false, error: 'BAD_REQUEST' });
      return;
    }
    if (stopping) {
      port.postMessage({ type: 'reply', id: replyId, ok: false, error: 'SERVER_SHUTDOWN' });
      return;
    }
    handle(parsed.data).then(
      (value) => port.postMessage({ type: 'reply', id: replyId, ok: true, value }),
      (e: unknown) => {
        const code = e instanceof ProtocolError ? e.code : 'INTERNAL';
        if (code === 'INTERNAL') logger.error('host command failed', { cmd: parsed.data.cmd, error: e instanceof Error ? e.message : String(e) });
        port.postMessage({ type: 'reply', id: replyId, ok: false, error: code });
      },
    );
  });
  port.postMessage({ type: 'ready', port: server.port });
}
