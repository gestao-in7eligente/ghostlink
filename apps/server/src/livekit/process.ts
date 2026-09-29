import { spawn, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { join } from 'node:path';
import type { Logger } from '../logger.js';
import { killStaleLivekit, removePidfile, writePidfile, type PidfileDeps } from './pidfile.js';

export type LivekitState = 'stopped' | 'starting' | 'running' | 'restarting' | 'failed';

export interface LivekitProcessOptions {
  binaryPath: string;
  dataDir: string;
  logger: Logger;
  /** Writes the config for this (re)start (fresh free ports) and returns its path and signaling port. */
  prepare(): Promise<{ configPath: string; port: number }>;
  /** After every successful (re)start: the signaling port answers. */
  onReady?(port: number): void;
  /** The running process stopped unexpectedly; a restart follows (onReady) unless the budget is spent (onGiveUp). */
  onCrash?(error: Error): void;
  /** The process stopped for good: the restart budget is spent. */
  onGiveUp?(error: Error): void;
  /** Restarts after a crash before giving up (spec §8.1: 5). */
  maxRestarts?: number;
  backoffMs?(attempt: number): number;
  readyTimeoutMs?: number;
  /** Uptime after which a crash no longer counts against the restart budget. */
  stableMs?: number;
  pidfileDeps?: PidfileDeps;
  spawnImpl?: typeof spawn;
}

const LOG_LINES_KEPT = 40;
/** stop(): a second SIGTERM after this long (LiveKit forces the stop on its second signal)… */
const STOP_FORCE_AFTER_MS = 1_000;
/** …and SIGKILL after this long, counted from the first. */
const STOP_KILL_AFTER_MS = 5_000;
const NOTEWORTHY = /\b(ERROR|FATAL|PANIC|WARN)\b|panic:|could not|failed/i;

/** GET http://127.0.0.1:<port>/ → 200 means LiveKit is up (its health route answers "OK"). */
function probe(port: number): Promise<boolean> {
  return new Promise((done) => {
    const req = request({ host: '127.0.0.1', port, path: '/', method: 'GET', timeout: 1_000 }, (res) => {
      res.resume();
      done(res.statusCode === 200);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => done(false));
    req.end();
  });
}

/** The child's environment without LIVEKIT_* variables, which LiveKit would read over our YAML. */
function childEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^LIVEKIT_/i.test(k)));
}

/**
 * Runs and supervises livekit-server (spec §8.1): `--config data/livekit.yaml`, never
 * `--dev`, never detached (it dies with us). A pidfile lets the next start kill an
 * orphan, but only after checking its executable path. A crash is restarted with
 * exponential backoff, at most `maxRestarts` times in a row; then onGiveUp().
 */
export class LivekitProcess {
  readonly #opts: LivekitProcessOptions;
  readonly #pidfile: string;
  #child: ChildProcess | null = null;
  #state: LivekitState = 'stopped';
  #port: number | null = null;
  #restarts = 0;
  #restartTimer: NodeJS.Timeout | null = null;
  #stopping = false;
  #lines: string[] = [];
  #lastError: Error | null = null;

  constructor(opts: LivekitProcessOptions) {
    this.#opts = opts;
    this.#pidfile = join(opts.dataDir, 'livekit.pid');
  }

  get state(): LivekitState {
    return this.#state;
  }

  /** The internal signaling/API port while running. */
  get port(): number | null {
    return this.#state === 'running' ? this.#port : null;
  }

  get lastError(): Error | null {
    return this.#lastError;
  }

  /** First start. Resolves when LiveKit answers; on failure the supervisor keeps retrying and this rejects. */
  async start(): Promise<void> {
    this.#stopping = false;
    const stale = await killStaleLivekit(this.#pidfile, this.#opts.binaryPath, this.#opts.pidfileDeps);
    if (stale === 'killed') this.#opts.logger.warn('stopped an orphaned LiveKit process from a previous run');
    try {
      await this.#launch();
    } catch (e) {
      this.#scheduleRestart(e as Error);
      throw e;
    }
  }

  /** Stops the process (and any pending restart). Idempotent. */
  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
    const child = this.#child;
    this.#child = null;
    this.#state = 'stopped';
    this.#port = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<'exited'>((r) => child.once('exit', () => r('exited')));
      const within = (ms: number) => Promise.race([exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms).unref())]);
      // On Windows kill() is TerminateProcess and the first call ends it. On POSIX SIGTERM is
      // a request: LiveKit drops one that arrives before its own "running" flag (up to ~100 ms
      // after its HTTP port, our readiness, answers) and a graceful stop waits for the
      // participants to leave. Its second signal forces the stop; SIGKILL is the last resort.
      child.kill();
      if ((await within(STOP_FORCE_AFTER_MS)) === 'timeout') {
        child.kill();
        if ((await within(STOP_KILL_AFTER_MS - STOP_FORCE_AFTER_MS)) === 'timeout') {
          child.kill('SIGKILL');
          await exited;
        }
      }
    }
    removePidfile(this.#pidfile);
  }

  async #launch(): Promise<void> {
    this.#state = this.#restarts > 0 ? 'restarting' : 'starting';
    const { configPath, port } = await this.#opts.prepare();
    if (this.#stopping) throw new Error('stopped');
    this.#port = port;
    this.#lines = [];
    const child = (this.#opts.spawnImpl ?? spawn)(this.#opts.binaryPath, ['--config', configPath], {
      cwd: this.#opts.dataDir,
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: false,
    });
    this.#child = child;
    if (child.pid !== undefined) writePidfile(this.#pidfile, child.pid, this.#opts.binaryPath);
    const onData = (chunk: Buffer) => this.#collect(chunk.toString('utf8'));
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    let exitedEarly: ((e: Error) => void) | null = null;
    const startedAt = Date.now();
    // 'on', not 'once': Node may emit 'error' more than once (e.g. per failed kill()), and an
    // 'error' without a listener would throw. A crash itself always comes as 'exit'.
    child.on('error', (e) => {
      if (exitedEarly) exitedEarly(e);
      else this.#opts.logger.warn('livekit-server process error', { error: e.message });
    });
    child.once('exit', (code, signal) => {
      const error = new Error(`livekit-server exited (${signal ?? `code ${code}`})${this.#tail()}`);
      exitedEarly?.(error);
      if (this.#child !== child || this.#stopping) return;
      this.#child = null;
      this.#port = null;
      if (this.#state === 'running') {
        if (Date.now() - startedAt > (this.#opts.stableMs ?? 60_000)) this.#restarts = 0;
        this.#opts.logger.error('LiveKit stopped unexpectedly', { code, signal });
        this.#state = 'restarting'; // not running from here on, also for onCrash
        this.#opts.onCrash?.(error);
        this.#scheduleRestart(error);
      }
    });

    const deadline = Date.now() + (this.#opts.readyTimeoutMs ?? 20_000);
    await new Promise<void>((resolveReady, rejectReady) => {
      let settled = false;
      exitedEarly = (e) => {
        if (settled) return;
        settled = true;
        rejectReady(e);
      };
      const poll = async () => {
        while (!settled) {
          if (this.#child !== child || this.#stopping) {
            settled = true;
            rejectReady(new Error('stopped'));
            return;
          }
          if (await probe(port)) {
            settled = true;
            resolveReady();
            return;
          }
          if (Date.now() > deadline) {
            settled = true;
            child.kill();
            rejectReady(new Error(`livekit-server did not answer within the startup timeout${this.#tail()}`));
            return;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
      };
      void poll();
    });
    exitedEarly = null;
    this.#state = 'running';
    this.#lastError = null;
    this.#opts.logger.info('LiveKit is running', { port });
    this.#opts.onReady?.(port);
  }

  #scheduleRestart(error: Error): void {
    if (this.#stopping) return;
    this.#lastError = error;
    const max = this.#opts.maxRestarts ?? 5;
    if (this.#restarts >= max) {
      this.#state = 'failed';
      this.#opts.logger.error('LiveKit failed too many times; voice is unavailable until the server restarts', { error: error.message });
      this.#opts.onGiveUp?.(error);
      return;
    }
    const attempt = this.#restarts++;
    const delay = this.#opts.backoffMs?.(attempt) ?? Math.min(500 * 2 ** attempt, 15_000);
    this.#state = 'restarting';
    this.#opts.logger.warn('restarting LiveKit', { attempt: attempt + 1, of: max, inMs: delay });
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      this.#launch().catch((e: Error) => this.#scheduleRestart(e));
    }, delay);
    this.#restartTimer.unref();
  }

  #collect(text: string): void {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim().slice(0, 300);
      if (!line) continue;
      this.#lines.push(line);
      if (this.#lines.length > LOG_LINES_KEPT) this.#lines.shift();
      if (NOTEWORTHY.test(line)) this.#opts.logger.warn('livekit', { line });
    }
  }

  #tail(): string {
    const tail = this.#lines.slice(-5);
    return tail.length ? `: ${tail.join(' | ')}` : '';
  }
}
