import type { ServerModule } from './modules.js';
import { createVoiceModule } from './voice/index.js';

/**
 * The feature modules a real server runs: the CLI `start` command and the
 * desktop Hosting mode pass this list to startServer(). Tests pass their own.
 * Each feature track adds its module here (one import + one entry), in an order
 * that satisfies getModule() dependencies (a module after those it calls in init).
 */
export function defaultModules(): ServerModule[] {
  return [createVoiceModule()];
}
