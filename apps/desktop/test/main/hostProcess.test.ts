import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Plays an Electron UtilityProcess (queueMicrotask, not setImmediate: it keeps working under fake timers). */
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  posted: unknown[] = [];
  killed = 0;
  /** What the fake server does when it receives { cmd: 'shutdown' }. */
  onShutdown: 'exit' | 'hang' = 'exit';
  postMessage(message: unknown): void {
    this.posted.push(message);
    if ((message as { cmd?: string }).cmd === 'shutdown' && this.onShutdown === 'exit') queueMicrotask(() => this.emit('exit', 0));
  }
  kill(): boolean {
    this.killed++;
    queueMicrotask(() => this.emit('exit', 1));
    return true;
  }
}

const electron = vi.hoisted(() => ({ utilityProcess: { fork: vi.fn() } }));
vi.mock('electron', () => electron);

const { READY_TIMEOUT_MS, SHUTDOWN_GRACE_MS, forkServer, serverEntryPath } = await import('../../src/main/hostProcess.js');

function nextChild(): FakeChild {
  const child = new FakeChild();
  electron.utilityProcess.fork.mockImplementationOnce(() => child);
  return child;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('forkServer (spec §9)', () => {
  it('forks serverEntry with an argument ARRAY, piped stdio and a service name', async () => {
    const child = nextChild();
    const started = forkServer({ dataDir: '/data', port: 0 });
    child.emit('message', { type: 'ready', port: 43210 });
    await started;
    expect(electron.utilityProcess.fork).toHaveBeenCalledWith(
      serverEntryPath(),
      ['--data', '/data', '--port', '0', '--host', '127.0.0.1'],
      { stdio: 'pipe', serviceName: 'GhostLink Server' },
    );
    expect(serverEntryPath()).toMatch(/serverEntry\.js$/);
  });

  it('resolves with the port from the ready message and drains the logs', async () => {
    const child = nextChild();
    const logs: string[] = [];
    const started = forkServer({ dataDir: '/data', port: 0, onLog: (t) => logs.push(t) });
    child.stdout.write('listening\n');
    child.emit('message', { something: 'unrelated' });
    child.emit('message', { type: 'ready', port: 43210 });
    expect((await started).port).toBe(43210);
    expect(logs).toEqual(['listening\n']);
  });

  it('rejects with the reason the server reported', async () => {
    const child = nextChild();
    const started = forkServer({ dataDir: '/data', port: 7700 });
    child.emit('message', { type: 'error', message: 'listen EADDRINUSE' });
    await expect(started).rejects.toThrow(/EADDRINUSE/);
  });

  it('rejects when the process dies before it is ready', async () => {
    const child = nextChild();
    const started = forkServer({ dataDir: '/data', port: 0 });
    child.emit('exit', 1);
    await expect(started).rejects.toThrow(/exited with code 1/);
  });

  it('kills a server that never becomes ready', async () => {
    vi.useFakeTimers();
    const child = nextChild();
    const started = forkServer({ dataDir: '/data', port: 0 });
    const outcome = expect(started).rejects.toThrow(/did not become ready/);
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS);
    await outcome;
    expect(child.killed).toBe(1);
  });

  it('shuts down with a message, not a kill, and only once', async () => {
    const child = nextChild();
    const started = forkServer({ dataDir: '/data', port: 0 });
    child.emit('message', { type: 'ready', port: 1 });
    const server = await started;
    await Promise.all([server.shutdown(), server.shutdown()]);
    expect(child.posted).toEqual([{ cmd: 'shutdown' }]);
    expect(child.killed).toBe(0);
  });

  it('falls back to kill() when the server ignores shutdown for 5 s', async () => {
    vi.useFakeTimers();
    const child = nextChild();
    child.onShutdown = 'hang';
    const started = forkServer({ dataDir: '/data', port: 0 });
    child.emit('message', { type: 'ready', port: 1 });
    const server = await started;
    const stopped = server.shutdown();
    await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS - 1);
    expect(child.killed).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await stopped;
    expect(child.killed).toBe(1);
  });
});
