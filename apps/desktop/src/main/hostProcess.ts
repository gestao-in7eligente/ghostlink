import { utilityProcess } from 'electron';
import { fileURLToPath } from 'node:url';
import type { HostCommand, HostMessage } from './hostedServer.js';
import { forwardText, logLines, type Log } from './log.js';

export interface ForkedServer {
  port: number;
  shutdown(): Promise<void>;
}

export interface ForkServerOptions {
  dataDir: string;
  port: number;
  /** Defaults to loopback; Hosting (M7) passes 0.0.0.0. */
  host?: string;
  /**
   * Receives the server's stdout/stderr (the pipes are drained either way). Never pipe
   * them into process.stdout: that pipe may be closed (packaged app, closed terminal).
   */
  onLog?: (text: string, stream: 'stdout' | 'stderr') => void;
  /** Stream errors and fatal V8 errors of the utility process (all non-fatal for the app). */
  onError?: (message: string, error?: Error) => void;
}

/** Sends the hosted server's output and stream errors to a log (never to process.stdout). */
export function hostedServerLogging(log: Log): Pick<ForkServerOptions, 'onLog' | 'onError'> {
  return {
    onLog: (text, stream) => logLines(log, '[server]', text, stream === 'stderr' ? 'warn' : 'info'),
    onError: (message, error) => (error ? log.warn(message, error) : log.warn(message)),
  };
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
  const streamError = (name: string) => (error: Error) => opts.onError?.(`hosted server ${name} stream error`, error);
  forwardText(child.stdout, (text) => opts.onLog?.(text, 'stdout'), streamError('stdout'));
  forwardText(child.stderr, (text) => opts.onLog?.(text, 'stderr'), streamError('stderr'));
  // An EventEmitter 'error' without a listener would throw in the main process.
  child.on('error', (type, location) => opts.onError?.(`hosted server ${type} at ${location}`));
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
