import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestServer, type TestServer } from '../../../server/test/helpers/testClient.js';
import { runSmoke, type SmokeDeps } from '../../src/main/smoke.js';
import { deadPort } from '../helpers/net.js';

let t: TestServer;
beforeAll(async () => {
  t = await startTestServer();
});
afterAll(() => t.cleanup());

function deps(overrides: Partial<SmokeDeps> = {}) {
  const calls: string[] = [];
  const exits: number[] = [];
  const shutdown = vi.fn(async () => {
    calls.push('shutdown');
  });
  const d: SmokeDeps = {
    waitForLoad: async () => {
      calls.push('load');
    },
    rendererReady: async () => {
      calls.push('ready?');
      return calls.filter((c) => c === 'ready?').length >= 3; // ready on the third poll
    },
    forkServer: async () => {
      calls.push('fork');
      return { port: t.server.port, shutdown };
    },
    exit: (code) => exits.push(code),
    log: () => {},
    pollMs: 5,
    timeoutMs: 5_000,
    ...overrides,
  };
  return { d, calls, exits, shutdown };
}

describe('runSmoke', () => {
  it('waits for the page and the bridge, then starts, reaches and stops a hosted server → exit 0', async () => {
    const { d, calls, exits } = deps();
    await runSmoke(d);
    expect(calls).toEqual(['load', 'ready?', 'ready?', 'ready?', 'fork', 'shutdown']);
    expect(exits).toEqual([0]);
  });

  it('fails when the hosted server does not answer TLS, and still stops it', async () => {
    const port = await deadPort();
    const { d, exits, shutdown } = deps({ forkServer: async () => ({ port, shutdown: async () => shutdown() }) });
    await runSmoke(d);
    expect(exits).toEqual([1]);
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it('fails when the server cannot start', async () => {
    const messages: string[] = [];
    const { d, exits } = deps({ forkServer: async () => Promise.reject(new Error('listen EADDRINUSE')), log: (m) => messages.push(m) });
    await runSmoke(d);
    expect(exits).toEqual([1]);
    expect(messages).toEqual(['smoke: FAILED (listen EADDRINUSE)']);
  });

  it('fails when the renderer never becomes ready, exactly once', async () => {
    const { d, exits, calls } = deps({ rendererReady: async () => false, timeoutMs: 200 });
    await runSmoke(d);
    expect(exits).toEqual([1]);
    expect(calls).not.toContain('fork');
  });

  it('fails when the page never loads, and ignores a late load', async () => {
    let load!: () => void;
    const { d, exits } = deps({ waitForLoad: () => new Promise<void>((r) => { load = r; }), timeoutMs: 100 });
    const run = runSmoke(d);
    await new Promise((r) => setTimeout(r, 200));
    expect(exits).toEqual([1]);
    load();
    await run;
    expect(exits).toEqual([1]);
  });

  it('runs the P2P check after the hosted server stopped, and says so', async () => {
    const messages: string[] = [];
    const { d, calls, exits } = deps({ log: (m) => messages.push(m) });
    d.p2p = async () => {
      calls.push('p2p');
    };
    await runSmoke(d);
    expect(calls).toEqual(['load', 'ready?', 'ready?', 'ready?', 'fork', 'shutdown', 'p2p']);
    expect(exits).toEqual([0]);
    expect(messages[0]).toMatch(/^smoke: OK \(.*P2P link exchanged a message\)$/);
  });

  it('fails when the P2P check fails', async () => {
    const messages: string[] = [];
    const { d, exits } = deps({ log: (m) => messages.push(m) });
    d.p2p = async () => Promise.reject(new Error('P2P self-test timed out'));
    await runSmoke(d);
    expect(exits).toEqual([1]);
    expect(messages).toEqual(['smoke: FAILED (P2P self-test timed out)']);
  });
});
