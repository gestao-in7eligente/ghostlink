import { probeServerKeyId } from './connection.js';
import type { ForkedServer } from './hostProcess.js';

export const SMOKE_TIMEOUT_MS = 60_000;

export interface SmokeDeps {
  /** Resolves on the main window's did-finish-load. */
  waitForLoad(): Promise<void>;
  /** True once the page rendered and reached the main process through window.ghostlink. */
  rendererReady(): Promise<boolean>;
  forkServer(): Promise<Pick<ForkedServer, 'port' | 'shutdown'>>;
  exit(code: number): void;
  log(message: string): void;
  timeoutMs?: number;
  pollMs?: number;
}

/**
 * GHOSTLINK_SMOKE=1 (contract §5, spec §14): proves the built app works end to end —
 * the renderer loaded through app://, the preload bridge and IPC answer, and a
 * hosted server starts in a utility process, serves TLS and stops. Exits 0 on
 * success and 1 on any failure or after the timeout; exit() is called exactly once.
 */
export async function runSmoke(deps: SmokeDeps): Promise<void> {
  let finished = false;
  const finish = (code: number, message: string) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    deps.log(message);
    deps.exit(code);
  };
  const timer = setTimeout(() => finish(1, 'smoke: FAILED (timed out)'), deps.timeoutMs ?? SMOKE_TIMEOUT_MS);
  try {
    await deps.waitForLoad();
    while (!finished && !(await deps.rendererReady())) {
      await new Promise((r) => setTimeout(r, deps.pollMs ?? 100));
    }
    if (finished) return;
    const server = await deps.forkServer();
    try {
      await probeServerKeyId(`127.0.0.1:${server.port}`, { timeoutMs: 5_000 });
    } finally {
      await server.shutdown();
    }
    finish(0, `smoke: OK (renderer ready, hosted server served TLS on port ${server.port} and stopped)`);
  } catch (e) {
    finish(1, `smoke: FAILED (${e instanceof Error ? e.message : String(e)})`);
  }
}
