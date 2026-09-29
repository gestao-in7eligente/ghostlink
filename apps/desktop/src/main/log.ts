// Main-process logging and crash safety. A GUI app must never die (or show Electron's
// modal "A JavaScript error occurred in the main process") because a console pipe went
// away: a packaged app often has no console at all, or one that closes before the app does.
// So everything goes to <userData>/logs/main.log, the console is only a best-effort mirror
// in development, and every stream the main process touches has an 'error' handler.
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import { formatWithOptions } from 'node:util';

export type LogLevel = 'info' | 'warn' | 'error';

/**
 * Never pass tokens, passwords, setup/invite codes, keys or message content (spec §7).
 * `redactSecrets` masks the obvious `key=value` / `"key":"value"` shapes as a safety net only.
 */
export interface Log {
  info(message: string, ...details: unknown[]): void;
  warn(message: string, ...details: unknown[]): void;
  error(message: string, ...details: unknown[]): void;
}

export const LOG_FILE = 'main.log';
/** The single rotated file kept next to `main.log`. */
export const LOG_OLD_FILE = 'main.old.log';
export const LOG_MAX_BYTES = 5 * 1024 * 1024;

const SECRET_KEY = String.raw`[A-Za-z_-]*?(?:token|secret|password|passphrase|setup[_-]?code|invite[_-]?code|private[_-]?key|authorization)`;
const JSON_SECRET = new RegExp(String.raw`("${SECRET_KEY}"\s*:\s*)"(?:[^"\\]|\\.)*"`, 'gi');
const KV_SECRET = new RegExp(String.raw`(\b${SECRET_KEY}\s*[=:]\s*)(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[^\s,;&"'}\]]+)`, 'gi');

/** Safety net for log lines: masks values of secret-looking keys. */
export function redactSecrets(text: string): string {
  return text.replace(JSON_SECRET, '$1"[redacted]"').replace(KV_SECRET, '$1[redacted]');
}

/** A pipe whose reader went away. Harmless for a log: the output is simply dropped. */
export function isBrokenPipe(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ERR_STREAM_WRITE_AFTER_END';
}

/** Any stream: Node's Readable/Writable, or the NodeJS.ReadableStream of a UtilityProcess. */
type StreamLike = Pick<NodeJS.EventEmitter, 'on'>;

type WritableLike = Pick<Writable, 'write' | 'destroyed' | 'writable'> & { writableEnded?: boolean };

/** Writes if the stream can still take data; never throws. Returns false when the text was dropped. */
export function safeWrite(stream: WritableLike | null | undefined, text: string | Uint8Array): boolean {
  if (!stream || stream.destroyed || !stream.writable || stream.writableEnded) return false;
  try {
    stream.write(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Gives a stream an 'error' handler: broken pipes are swallowed, anything else goes to
 * `onOther`. Without a handler, an EPIPE on process.stdout becomes an uncaught exception.
 */
export function guardStream(stream: StreamLike | null | undefined, onOther?: (error: Error) => void): void {
  stream?.on('error', (error: Error) => {
    if (!isBrokenPipe(error)) onOther?.(error);
  });
}

/**
 * Drains `source` (e.g. a utility process's stdout) into `onText`. The source is always
 * read to the end, so the child never blocks on a full pipe, and neither its errors nor
 * a throwing `onText` can escape.
 */
export function forwardText(source: StreamLike | null | undefined, onText: (text: string) => void, onError?: (error: Error) => void): void {
  if (!source) return;
  guardStream(source, onError);
  source.on('data', (chunk: Buffer | string) => {
    try {
      onText(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * `source.pipe(destination)` that survives the destination going away: both streams get
 * an 'error' handler, and once the destination errors or closes its data is dropped
 * while the source keeps being drained.
 */
export function forwardStream(source: StreamLike | null | undefined, destination: Writable, onError?: (error: Error) => void): void {
  let open = true;
  const close = () => {
    open = false;
  };
  guardStream(destination, onError);
  destination.on('error', close);
  destination.on('close', close);
  forwardText(source, (text) => {
    if (open && !safeWrite(destination, text)) open = false;
  }, onError);
}

export interface FileLogOptions {
  /** `<userData>/logs`; created when missing. */
  dir: string;
  maxBytes?: number;
  /** Development only: receives every line, e.g. to echo it on the console. */
  mirror?: ((line: string, level: LogLevel) => void) | null;
  now?: () => Date;
}

/**
 * Appends to `main.log`; when a line would push it past `maxBytes`, the file becomes
 * `main.old.log` (replacing the previous one) and a new `main.log` starts. Every write
 * opens and closes the file, so nothing holds it open, and no failure ever throws.
 */
export class FileLog implements Log {
  readonly path: string;
  readonly oldPath: string;
  readonly #maxBytes: number;
  readonly #mirror: FileLogOptions['mirror'];
  readonly #now: () => Date;
  #size = 0;

  constructor(opts: FileLogOptions) {
    this.path = join(opts.dir, LOG_FILE);
    this.oldPath = join(opts.dir, LOG_OLD_FILE);
    this.#maxBytes = opts.maxBytes ?? LOG_MAX_BYTES;
    this.#mirror = opts.mirror;
    this.#now = opts.now ?? (() => new Date());
    try {
      mkdirSync(opts.dir, { recursive: true });
      this.#size = statSync(this.path).size;
    } catch {
      this.#size = 0;
    }
  }

  info(message: string, ...details: unknown[]): void {
    this.write('info', message, details);
  }

  warn(message: string, ...details: unknown[]): void {
    this.write('warn', message, details);
  }

  error(message: string, ...details: unknown[]): void {
    this.write('error', message, details);
  }

  write(level: LogLevel, message: string, details: unknown[]): void {
    const body = redactSecrets(details.length === 0 ? message : formatWithOptions({ colors: false, depth: 4 }, message, ...details));
    const line = `${this.#now().toISOString()} ${level} ${body}\n`;
    const bytes = Buffer.byteLength(line);
    try {
      if (this.#size > 0 && this.#size + bytes > this.#maxBytes) this.#rotate();
      appendFileSync(this.path, line, { mode: 0o600 });
      this.#size += bytes;
    } catch {
      // Disk full, permissions, antivirus lock: losing a log line beats crashing.
    }
    try {
      this.#mirror?.(line, level);
    } catch {
      // The mirror is best-effort by definition.
    }
  }

  #rotate(): void {
    rmSync(this.oldPath, { force: true });
    renameSync(this.path, this.oldPath);
    this.#size = 0;
  }
}

/** Raw text from another process (the hosted server's stdout): one log line per text line. */
export function logLines(log: Log, prefix: string, text: string, level: LogLevel = 'info'): void {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() !== '') log[level](`${prefix} ${line}`);
  }
}

/** Mirror for development runs: stderr for warnings and errors, stdout otherwise. */
export function consoleMirror(line: string, level: LogLevel): void {
  safeWrite(level === 'info' ? process.stdout : process.stderr, line);
}

let current: Log = {
  info: (message, ...details) => consoleMirror(`${formatWithOptions({ colors: false }, message, ...details)}\n`, 'info'),
  warn: (message, ...details) => consoleMirror(`${formatWithOptions({ colors: false }, message, ...details)}\n`, 'warn'),
  error: (message, ...details) => consoleMirror(`${formatWithOptions({ colors: false }, message, ...details)}\n`, 'error'),
};

/**
 * The main process's log. Before `setMainLog` (and in unit tests) it writes to the
 * console through `safeWrite`; the bootstrap points it at the `FileLog` right away.
 */
export const mainLog: Log = {
  info: (message, ...details) => current.info(message, ...details),
  warn: (message, ...details) => current.warn(message, ...details),
  error: (message, ...details) => current.error(message, ...details),
};

export function setMainLog(log: Log): void {
  current = log;
}

type ProcessLike = Pick<NodeJS.Process, 'on'>;

export interface CrashHandlerDeps {
  log: Log;
  /** GHOSTLINK_SMOKE=1: any uncaught error fails the run with exit code 1. */
  smoke: boolean;
  exit(code: number): void;
  target?: ProcessLike;
}

/**
 * Logs uncaught exceptions and unhandled rejections instead of letting Electron show its
 * modal error dialog (Electron only shows it when nobody else listens). Outside smoke
 * mode the app keeps running; in smoke mode the run fails with exit code 1.
 */
export function installCrashHandlers(deps: CrashHandlerDeps): void {
  const target = deps.target ?? process;
  target.on('uncaughtException', (error: Error) => {
    deps.log.error('uncaught exception:', error);
    if (deps.smoke) deps.exit(1);
  });
  target.on('unhandledRejection', (reason: unknown) => {
    deps.log.error('unhandled promise rejection:', reason);
    if (deps.smoke) deps.exit(1);
  });
}

/** process.stdout/stderr must never turn a vanished console into a crash. */
export function guardStdio(target: Pick<NodeJS.Process, 'stdout' | 'stderr'> = process, log: Log = mainLog): void {
  guardStream(target.stdout, (error) => log.warn('stdout error:', error));
  guardStream(target.stderr, (error) => log.warn('stderr error:', error));
}
