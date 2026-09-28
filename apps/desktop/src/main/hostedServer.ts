import { parseArgs } from 'node:util';
import { z } from 'zod';
import { ProtocolError, formatHostPort, type JoinMode } from '@ghostlink/shared';
import {
  consoleLogger,
  localIPv4Addresses,
  startServer,
  type GhostServer,
  type LocalAddress,
  type Logger,
  type ServerInfo,
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

/** Hosted server → parent. `code` is the errno/ProtocolError code of a startup failure (e.g. EADDRINUSE). */
export type HostMessage =
  | { type: 'ready'; port: number }
  | { type: 'error'; message: string; code?: string }
  | { type: 'reply'; id: number; ok: true; value: unknown }
  | { type: 'reply'; id: number; ok: false; error: string };

/** The reply to `status`. */
export interface HostedStatus extends ServerInfo {
  port: number;
  serverKeyId: string;
  version: string;
  localAddresses: LocalAddress[];
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
  /** First run only (they seed server_meta). */
  name?: string;
  joinMode?: JoinMode;
  maxMembers?: number;
}

const HOST_JOIN_MODES: readonly JoinMode[] = ['invite', 'open'];

/**
 * `--data <dir> --port <n> [--host <ip>] [--name=<text>] [--join-mode=invite|open] [--max-members=<n>]`.
 * The host defaults to loopback (no firewall prompt). The parent passes `--name=<text>`
 * in one piece, so a name that starts with "-" can never be read as an option.
 */
export function parseHostArgs(argv: string[]): HostArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      data: { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
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

/**
 * The addresses to put in invites: every local address when bound to all
 * interfaces, only the bound one otherwise, none on loopback (the server then
 * falls back to 127.0.0.1:<port>). Phase 2 adds the UPnP WAN address.
 */
export function advertisedAddresses(bindHost: string, port: number, local: readonly LocalAddress[]): string[] {
  const usable = bindHost === '0.0.0.0' ? local : local.filter((l) => l.ip === bindHost);
  return usable.map((l) => formatHostPort(l.ip, port));
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

/**
 * The body of the hosted-server utility process (spec §9): starts the server,
 * reports `{ type: 'ready', port }`, answers the control requests `status`,
 * `logs`, `invite` and `reset-owner`, and on `{ cmd: 'shutdown' }` closes it
 * gracefully and exits 0. Any startup failure is reported as `{ type: 'error' }`
 * followed by exit code 1.
 */
export async function runHostedServer(
  port: ParentPortLike,
  argv: string[],
  deps: { exit(code: number): void; start?: typeof startServer; logger?: Logger; localAddresses?: () => LocalAddress[] },
): Promise<void> {
  const ring = new LineRing();
  const logger = ringLogger(deps.logger ?? consoleLogger, ring);
  const local = deps.localAddresses ?? (() => localIPv4Addresses());
  let server: GhostServer;
  let args: HostArgs;
  try {
    args = parseHostArgs(argv);
    server = await (deps.start ?? startServer)({
      dataDir: args.dataDir,
      port: args.port,
      host: args.host,
      name: args.name,
      joinMode: args.joinMode,
      maxMembers: args.maxMembers,
      logger,
    });
  } catch (e) {
    const code = errorCodeOf(e);
    port.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e), ...(code === undefined ? {} : { code }) });
    deps.exit(1);
    return;
  }

  /** Keeps server_meta.public_addresses in step with the interfaces (spec §3.5). */
  const advertise = (): LocalAddress[] => {
    const found = local();
    try {
      const next = advertisedAddresses(args.host, server.port, found);
      // The Host panel polls status every few seconds: only write when something changed.
      if (next.join(',') !== server.info().publicAddresses.join(',')) server.setPublicAddresses(next);
    } catch (e) {
      logger.warn('could not update the public addresses', { error: e instanceof Error ? e.message : String(e) });
    }
    return found;
  };
  advertise();

  const handle = (request: HostRequest): unknown => {
    switch (request.cmd) {
      case 'status': {
        const localAddresses = advertise();
        const status: HostedStatus = { port: server.port, serverKeyId: server.serverKeyId, version: server.version, ...server.info(), localAddresses };
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
    try {
      port.postMessage({ type: 'reply', id: replyId, ok: true, value: handle(parsed.data) });
    } catch (e) {
      const code = e instanceof ProtocolError ? e.code : 'INTERNAL';
      if (code === 'INTERNAL') logger.error('host command failed', { cmd: parsed.data.cmd, error: e instanceof Error ? e.message : String(e) });
      port.postMessage({ type: 'reply', id: replyId, ok: false, error: code });
    }
  });
  port.postMessage({ type: 'ready', port: server.port });
}
