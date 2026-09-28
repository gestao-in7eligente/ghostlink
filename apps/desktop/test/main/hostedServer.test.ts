import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../../../server/src/index.js';
import { startTestServer } from '../../../server/test/helpers/testClient.js';
import { probeServerKeyId } from '../../src/main/connection.js';
import { parseHostArgs, runHostedServer, type HostMessage } from '../../src/main/hostedServer.js';
import { useTempDir } from '../helpers/tempDir.js';

const dir = useTempDir();

/** Plays process.parentPort: records what the child posts, lets the test send commands. */
function fakeParentPort() {
  const emitter = new EventEmitter();
  const posted: HostMessage[] = [];
  return {
    posted,
    port: {
      on: (event: 'message', listener: (e: { data: unknown }) => void) => emitter.on(event, listener),
      postMessage: (m: HostMessage) => posted.push(m),
    },
    send: (data: unknown) => emitter.emit('message', { data }),
  };
}

function exitRecorder() {
  const codes: number[] = [];
  let resolve!: (code: number) => void;
  const done = new Promise<number>((r) => {
    resolve = r;
  });
  return {
    codes,
    done,
    exit: (code: number) => {
      codes.push(code);
      resolve(code);
    },
  };
}

describe('parseHostArgs', () => {
  it('reads --data, --port and an optional --host (loopback by default)', () => {
    expect(parseHostArgs(['--data', '/d', '--port', '0'])).toEqual({ dataDir: '/d', port: 0, host: '127.0.0.1' });
    expect(parseHostArgs(['--data', '/d', '--port', '7700', '--host', '0.0.0.0'])).toEqual({ dataDir: '/d', port: 7700, host: '0.0.0.0' });
  });

  it.each([
    [['--port', '0']],
    [['--data', '/d']],
    [['--data', '/d', '--port', '65536']],
    [['--data', '/d', '--port', '-1']],
    [['--data', '/d', '--port', '7700', '--evil', 'x']],
    [['--data', '/d', '--port', '7700', 'positional']],
  ])('rejects %j', (argv) => {
    expect(() => parseHostArgs(argv)).toThrow();
  });
});

describe('runHostedServer (utility process body, spec §9)', () => {
  it('reports ready with the bound port, serves TLS, and shuts down gracefully on command', async () => {
    const parent = fakeParentPort();
    const exit = exitRecorder();
    await runHostedServer(parent.port, ['--data', dir.path, '--port', '0'], { exit: exit.exit, logger: silentLogger });
    const [ready] = parent.posted;
    expect(ready).toEqual({ type: 'ready', port: expect.any(Number) });
    const port = (ready as { port: number }).port;
    expect(await probeServerKeyId(`127.0.0.1:${port}`)).toMatch(/^[A-Za-z0-9_-]{43}$/);

    parent.send({ cmd: 'status' }); // not a shutdown: ignored
    parent.send({ cmd: 'shutdown' });
    parent.send({ cmd: 'shutdown' }); // only once
    expect(await exit.done).toBe(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(exit.codes).toEqual([0]);
    await expect(probeServerKeyId(`127.0.0.1:${port}`, { timeoutMs: 1_000 })).rejects.toMatchObject({ code: 'UNREACHABLE' });
  });

  it('reports bad arguments and exits 1', async () => {
    const parent = fakeParentPort();
    const exit = exitRecorder();
    await runHostedServer(parent.port, ['--port', '0'], { exit: exit.exit, logger: silentLogger });
    expect(parent.posted).toEqual([{ type: 'error', message: '--data is required' }]);
    expect(exit.codes).toEqual([1]);
  });

  it('reports a busy port and exits 1', async () => {
    const busy = await startTestServer();
    try {
      const parent = fakeParentPort();
      const exit = exitRecorder();
      await runHostedServer(parent.port, ['--data', dir.path, '--port', String(busy.server.port)], { exit: exit.exit, logger: silentLogger });
      expect(parent.posted).toEqual([{ type: 'error', message: expect.stringMatching(/EADDRINUSE/) }]);
      expect(exit.codes).toEqual([1]);
    } finally {
      await busy.cleanup();
    }
  });
});
