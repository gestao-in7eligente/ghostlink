import { utilityProcess } from 'electron';
import { fileURLToPath } from 'node:url';
import { ProtocolError, isErrorCode } from '@ghostlink/shared';
import { AppError } from '../shared/appErrors.js';
import type { HostCommand, HostMessage, HostRequest } from './hostedServer.js';
import { forwardText, logLines, type Log } from './log.js';

export interface ForkedServer {
  port: number;
  shutdown(): Promise<void>;
  /** Sends a control request (spec §9) and resolves with the reply's value. */
  request<T = unknown>(command: HostRequest, timeoutMs?: number): Promise<T>;
  /** Resolves with the exit code once the process is gone (after shutdown, or a crash). */
  exited: Promise<number>;
}

export interface ForkServerOptions {
  dataDir: string;
  port: number;
  /** Defaults to loopback; Hosting (M7) passes 0.0.0.0. */
  host?: string;
  /** Appended after the fixed arguments, e.g. Host mode's `--name=…` (see parseHostArgs). */
  args?: string[];
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
export const REQUEST_TIMEOUT_MS = 10_000;

/** out/main/serverEntry.js: the second main-process input of the electron-vite build. */
export function serverEntryPath(): string {
  return fileURLToPath(new URL('./serverEntry.js', import.meta.url));
}

function isHostMessage(m: unknown): m is HostMessage {
  const type = typeof m === 'object' && m !== null ? (m as { type?: unknown }).type : undefined;
  return type === 'ready' || type === 'error' || type === 'reply';
}

/** A reply's error code as a thrown error the IPC layer can pass on (anything unknown is INTERNAL). */
function replyError(code: string): Error {
  return isErrorCode(code) ? new ProtocolError(code) : new AppError('INTERNAL', `host command failed: ${code}`);
}

/**
 * Starts a GhostLink server in a utility process (spec §9) and waits for its
 * `ready` handshake over parentPort. The arguments are an ARRAY: an object in
 * that position would silently be taken as the options.
 */
export async function forkServer(opts: ForkServerOptions): Promise<ForkedServer> {
  const args = ['--data', opts.dataDir, '--port', String(opts.port), '--host', opts.host ?? '127.0.0.1', ...(opts.args ?? [])];
  const child = utilityProcess.fork(serverEntryPath(), args, { stdio: 'pipe', serviceName: 'GhostLink Server' });
  const streamError = (name: string) => (error: Error) => opts.onError?.(`hosted server ${name} stream error`, error);
  forwardText(child.stdout, (text) => opts.onLog?.(text, 'stdout'), streamError('stdout'));
  forwardText(child.stderr, (text) => opts.onLog?.(text, 'stderr'), streamError('stderr'));
  // An EventEmitter 'error' without a listener would throw in the main process.
  child.on('error', (type, location) => opts.onError?.(`hosted server ${type} at ${location}`));
  let gone = false;
  const exited = new Promise<number>((resolve) => child.once('exit', resolve));
  const pending = new Map<number, { resolve(value: unknown): void; reject(e: Error): void }>();
  void exited.then(() => {
    gone = true;
    for (const p of pending.values()) p.reject(new AppError('HOST_NOT_RUNNING', 'the hosted server exited'));
    pending.clear();
  });
  child.on('message', (message: unknown) => {
    if (!isHostMessage(message) || message.type !== 'reply') return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.ok) waiter.resolve(message.value);
    else waiter.reject(replyError(message.error));
  });

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('the hosted server did not become ready in time'));
    }, READY_TIMEOUT_MS);
    child.on('message', (message: unknown) => {
      if (!isHostMessage(message) || message.type === 'reply') return;
      clearTimeout(timer);
      if (message.type === 'ready') resolve(message.port);
      else reject(Object.assign(new Error(`the hosted server failed to start: ${message.message}`), { code: message.code }));
    });
    void exited.then((code) => {
      clearTimeout(timer);
      reject(new Error(`the hosted server exited with code ${code} before it was ready`));
    });
  });

  let nextId = 1;
  let stopping: Promise<void> | null = null;
  return {
    port,
    exited,
    request: <T>(command: HostRequest, timeoutMs = REQUEST_TIMEOUT_MS) => {
      if (gone) return Promise.reject(new AppError('HOST_NOT_RUNNING', 'the hosted server exited'));
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new AppError('TIMEOUT', `no reply to ${command.cmd}`));
        }, timeoutMs);
        const settle = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A) => {
          clearTimeout(timer);
          fn(...a);
        };
        pending.set(id, { resolve: settle((v: unknown) => resolve(v as T)), reject: settle(reject) });
        const message: HostCommand = { id, ...command };
        child.postMessage(message);
      });
    },
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
