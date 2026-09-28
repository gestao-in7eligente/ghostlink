import { utilityProcess } from 'electron';
import { fileURLToPath } from 'node:url';
import type { HostCommand, HostMessage } from './hostedServer.js';

export interface ForkedServer {
  port: number;
  shutdown(): Promise<void>;
}

export interface ForkServerOptions {
  dataDir: string;
  port: number;
  /** Defaults to loopback; Hosting (M7) passes 0.0.0.0. */
  host?: string;
  /** Receives the server's stdout/stderr (the pipes must be drained either way). */
  onLog?: (text: string) => void;
}

/** spec §9: `child.kill()` is only a fallback, 5 s after `shutdown` (on Windows it runs no handler). */
export const SHUTDOWN_GRACE_MS = 5_000;
export const READY_TIMEOUT_MS = 30_000;

/** out/main/serverEntry.js: the second main-process input of the electron-vite build. */
export function serverEntryPath(): string {
  return fileURLToPath(new URL('./serverEntry.js', import.meta.url));
}

function isHostMessage(m: unknown): m is HostMessage {
  return typeof m === 'object' && m !== null && ((m as { type?: unknown }).type === 'ready' || (m as { type?: unknown }).type === 'error');
}

/**
 * Starts a GhostLink server in a utility process (spec §9) and waits for its
 * `ready` handshake over parentPort. The arguments are an ARRAY: an object in
 * that position would silently be taken as the options.
 */
export async function forkServer(opts: ForkServerOptions): Promise<ForkedServer> {
  const args = ['--data', opts.dataDir, '--port', String(opts.port), '--host', opts.host ?? '127.0.0.1'];
  const child = utilityProcess.fork(serverEntryPath(), args, { stdio: 'pipe', serviceName: 'GhostLink Server' });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', (chunk: Buffer) => opts.onLog?.(chunk.toString('utf8')));
  }
  const exited = new Promise<number>((resolve) => child.once('exit', resolve));

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('the hosted server did not become ready in time'));
    }, READY_TIMEOUT_MS);
    child.on('message', (message: unknown) => {
      if (!isHostMessage(message)) return;
      clearTimeout(timer);
      if (message.type === 'ready') resolve(message.port);
      else reject(new Error(`the hosted server failed to start: ${message.message}`));
    });
    void exited.then((code) => {
      clearTimeout(timer);
      reject(new Error(`the hosted server exited with code ${code} before it was ready`));
    });
  });

  let stopping: Promise<void> | null = null;
  return {
    port,
    shutdown: () => {
      stopping ??= (async () => {
        const command: HostCommand = { cmd: 'shutdown' };
        child.postMessage(command);
        const fallback = setTimeout(() => child.kill(), SHUTDOWN_GRACE_MS);
        await exited;
        clearTimeout(fallback);
      })();
      return stopping;
    },
  };
}
