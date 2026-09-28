import { parseArgs } from 'node:util';
import { consoleLogger, startServer, type GhostServer, type Logger } from '@ghostlink/server';

/** Parent → hosted server (spec §9; Milestone 1 needs only `shutdown`). */
export interface HostCommand {
  cmd: 'shutdown';
}

/** Hosted server → parent. */
export type HostMessage = { type: 'ready'; port: number } | { type: 'error'; message: string };

/** What the utility process needs from `process.parentPort` (a fake in tests). */
export interface ParentPortLike {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  postMessage(message: HostMessage): void;
}

export interface HostArgs {
  dataDir: string;
  port: number;
  host: string;
}

/** `--data <dir> --port <n> [--host <ip>]`; the host defaults to loopback (no firewall prompt). */
export function parseHostArgs(argv: string[]): HostArgs {
  const { values } = parseArgs({
    args: argv,
    options: { data: { type: 'string' }, port: { type: 'string' }, host: { type: 'string' } },
    strict: true,
    allowPositionals: false,
  });
  if (!values.data) throw new Error('--data is required');
  const port = Number(values.port ?? '');
  if (!/^\d{1,5}$/.test(values.port ?? '') || port > 65535) throw new Error('--port must be 0..65535');
  return { dataDir: values.data, port, host: values.host ?? '127.0.0.1' };
}

function isShutdown(data: unknown): data is HostCommand {
  return typeof data === 'object' && data !== null && (data as { cmd?: unknown }).cmd === 'shutdown';
}

/**
 * The body of the hosted-server utility process (spec §9): starts the server,
 * reports `{ type: 'ready', port }`, and on `{ cmd: 'shutdown' }` closes it
 * gracefully and exits 0. Any startup failure is reported as `{ type: 'error' }`
 * followed by exit code 1.
 */
export async function runHostedServer(
  port: ParentPortLike,
  argv: string[],
  deps: { exit(code: number): void; start?: typeof startServer; logger?: Logger },
): Promise<void> {
  let server: GhostServer;
  try {
    const args = parseHostArgs(argv);
    server = await (deps.start ?? startServer)({ dataDir: args.dataDir, port: args.port, host: args.host, logger: deps.logger ?? consoleLogger });
  } catch (e) {
    port.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    deps.exit(1);
    return;
  }
  let stopping = false;
  port.on('message', ({ data }) => {
    if (stopping || !isShutdown(data)) return;
    stopping = true;
    server.close().then(
      () => deps.exit(0),
      () => deps.exit(1),
    );
  });
  port.postMessage({ type: 'ready', port: server.port });
}
