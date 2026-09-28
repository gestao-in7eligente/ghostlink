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

describe('forkServer control channel (spec §9)', () => {
  async function ready(opts: Partial<Parameters<typeof forkServer>[0]> = {}) {
    const child = nextChild();
    const started = forkServer({ dataDir: '/data', port: 7700, host: '0.0.0.0', ...opts });
    child.emit('message', { type: 'ready', port: 7700 });
    return { child, server: await started };
  }

  it('appends the extra arguments after the fixed ones', async () => {
    await ready({ args: ['--name=Casa', '--join-mode=open'] });
    expect(electron.utilityProcess.fork).toHaveBeenLastCalledWith(
      serverEntryPath(),
      ['--data', '/data', '--port', '7700', '--host', '0.0.0.0', '--name=Casa', '--join-mode=open'],
      { stdio: 'pipe', serviceName: 'GhostLink Server' },
    );
  });

  it('rejects a startup failure with the errno code the server reported', async () => {
    const child = nextChild();
    const started = forkServer({ dataDir: '/data', port: 7700 });
    child.emit('message', { type: 'error', message: 'listen EADDRINUSE: address already in use 0.0.0.0:7700', code: 'EADDRINUSE' });
    await expect(started).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });

  it('matches replies to requests by id, in any order', async () => {
    const { child, server } = await ready();
    const status = server.request({ cmd: 'status' });
    const logs = server.request({ cmd: 'logs' });
    const [first, second] = child.posted as Array<{ id: number; cmd: string }>;
    expect(first).toEqual({ id: expect.any(Number), cmd: 'status' });
    expect(second).toEqual({ id: expect.any(Number), cmd: 'logs' });
    expect(first!.id).not.toBe(second!.id);
    child.emit('message', { type: 'reply', id: second!.id, ok: true, value: ['line'] });
    child.emit('message', { type: 'reply', id: 424242, ok: true, value: 'stray' });
    child.emit('message', { type: 'reply', id: first!.id, ok: true, value: { port: 7700 } });
    await expect(logs).resolves.toEqual(['line']);
    await expect(status).resolves.toEqual({ port: 7700 });
  });

  it('turns an error reply into a coded error', async () => {
    const { child, server } = await ready();
    const invite = server.request({ cmd: 'invite', maxUses: 0 });
    const [sent] = child.posted as Array<{ id: number }>;
    child.emit('message', { type: 'reply', id: sent!.id, ok: false, error: 'BAD_REQUEST' });
    await expect(invite).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('times out a request that gets no reply', async () => {
    vi.useFakeTimers();
    const { server } = await ready();
    const status = server.request({ cmd: 'status' }, 1_000);
    const outcome = expect(status).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(1_000);
    await outcome;
  });

  it('fails pending and later requests once the process is gone, and reports the exit code', async () => {
    const { child, server } = await ready();
    const pending = server.request({ cmd: 'status' });
    child.emit('exit', 3);
    await expect(pending).rejects.toMatchObject({ code: 'HOST_NOT_RUNNING' });
    await expect(server.exited).resolves.toBe(3);
    await expect(server.request({ cmd: 'logs' })).rejects.toMatchObject({ code: 'HOST_NOT_RUNNING' });
  });
});
