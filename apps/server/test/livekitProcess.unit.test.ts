// LivekitProcess against a fake child (spawnImpl): the supervisor's own logic, with the
// POSIX semantics CI runs into on Linux and macOS, where a signal is a request LiveKit may
// defer or ignore, not the immediate TerminateProcess that child.kill() is on Windows.
import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../src/logger.js';
import { LivekitProcess } from '../src/livekit/process.js';

/** How the fake livekit-server reacts to SIGTERM: exit at once, ignore the first (LiveKit's startup window), or never. */
type TermBehaviour = 'exit' | 'ignore-first' | 'ignore';

class FakeChild extends EventEmitter {
  static nextPid = 90_000;
  readonly pid = FakeChild.nextPid++;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: string[] = [];
  constructor(private readonly onTerm: TermBehaviour) {
    super();
  }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    const terms = this.signals.filter((s) => s === 'SIGTERM').length;
    const exits = signal === 'SIGKILL' || this.onTerm === 'exit' || (this.onTerm === 'ignore-first' && terms >= 2);
    if (exits) queueMicrotask(() => this.die(signal === 'SIGKILL' ? null : 0, signal === 'SIGKILL' ? 'SIGKILL' : null));
    return true;
  }
  /** The process ends by itself or by a signal from outside. */
  die(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

let health: Server;
let port: number;
let dataDir: string;
const children: FakeChild[] = [];
const supervisors: LivekitProcess[] = [];

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'ghostlink-lkp-unit-'));
  health = createServer((_req, res) => res.end('OK')); // what the readiness probe asks
  await new Promise<void>((r) => health.listen(0, '127.0.0.1', () => r()));
  port = (health.address() as AddressInfo).port;
});

afterEach(async () => {
  vi.useRealTimers();
  for (const s of supervisors.splice(0)) await s.stop();
  children.splice(0);
  await new Promise<void>((r) => {
    health.close(() => r());
    health.closeAllConnections();
  });
  rmSync(dataDir, { recursive: true, force: true });
});

function supervise(onTerm: TermBehaviour = 'exit', events: string[] = []): LivekitProcess {
  const proc = new LivekitProcess({
    binaryPath: join(dataDir, 'livekit-server'),
    dataDir,
    logger: silentLogger,
    prepare: async () => ({ configPath: join(dataDir, 'livekit.yaml'), port }),
    onReady: () => events.push('ready'),
    onCrash: () => events.push('crash'),
    onGiveUp: () => events.push('giveUp'),
    backoffMs: () => 10,
    pidfileDeps: { isAlive: () => false, exePath: async () => null, kill: () => {}, sleep: async () => {} },
    spawnImpl: (() => {
      const child = new FakeChild(onTerm);
      children.push(child);
      return child;
    }) as unknown as typeof spawn,
  });
  supervisors.push(proc);
  return proc;
}

describe('LivekitProcess: a running LiveKit that ends is a crash, however it ended', () => {
  it.each([
    ['killed (SIGKILL: an OOM kill, a crash)', null, 'SIGKILL'],
    ['a graceful exit after a SIGTERM from outside', 0, null],
    ['an error exit', 1, null],
  ] as const)('%s: onCrash, then the supervised restart', async (_label, code, signal) => {
    const events: string[] = [];
    const proc = supervise('exit', events);
    await proc.start();
    children[0]!.die(code, signal);
    expect(events).toEqual(['ready', 'crash']);
    expect(proc.state).toBe('restarting');
    await vi.waitFor(() => expect(events).toEqual(['ready', 'crash', 'ready']));
    expect(children).toHaveLength(2);
    expect(proc.state).toBe('running');
  });

  it("survives several 'error' events from the child (Node may emit one per failed kill)", async () => {
    const proc = supervise();
    await proc.start();
    const child = children[0]!;
    expect(() => {
      child.emit('error', new Error('kill EPERM'));
      child.emit('error', new Error('kill EPERM'));
    }).not.toThrow();
    expect(proc.state).toBe('running');
  });
});

describe('LivekitProcess.stop on POSIX', () => {
  it('asks once when LiveKit honours SIGTERM', async () => {
    const proc = supervise('exit');
    await proc.start();
    await proc.stop();
    expect(children[0]!.signals).toEqual(['SIGTERM']);
    expect(proc.state).toBe('stopped');
  });

  it('sends a second SIGTERM (LiveKit: force stop) when the first was ignored, long before the SIGKILL', async () => {
    // LiveKit drops a SIGTERM that arrives in the ~100 ms between its HTTP answering (our
    // readiness) and its own "running" flag, and a graceful stop waits for participants.
    const proc = supervise('ignore-first');
    await proc.start();
    vi.useFakeTimers();
    const stopped = proc.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    await stopped;
    expect(children[0]!.signals).toEqual(['SIGTERM', 'SIGTERM']);
  });

  it('SIGKILLs a LiveKit that ignores every SIGTERM, after 5 s', async () => {
    const proc = supervise('ignore');
    await proc.start();
    vi.useFakeTimers();
    let done = false;
    const stopped = proc.stop().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(4_900);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await stopped;
    expect(children[0]!.signals).toEqual(['SIGTERM', 'SIGTERM', 'SIGKILL']);
  });
});
