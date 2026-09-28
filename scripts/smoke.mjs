// npm run smoke — checks the app packaged by `npm run dist` (spec §14 "Smoke do pacote"):
// 1. the fuses of the binary match spec §12;
// 2. app.asar holds no Vite optional-dependency stub (ws must stay an external dependency);
// 3. the app starts with GHOSTLINK_SMOKE=1 in a throwaway profile and exits 0 within 60 s.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  SMOKE_TIMEOUT_MS,
  fuseProblems,
  optionalPeerStubs,
  packagedApp,
  readFuses,
  runSmoke,
  smokeEnv,
  smokeVerdict,
} from './lib/smoke.mjs';

const distDir = fileURLToPath(new URL('../apps/desktop/dist/', import.meta.url));

/** @param {string} message */
function fail(message) {
  console.error(`\nsmoke-runner: FAILED - ${message}`);
  return 1;
}

async function main() {
  const app = packagedApp({ distDir, platform: process.platform, arch: process.arch });
  if (!existsSync(app.executable)) return fail(`no packaged app at ${app.executable}. Run "npm run dist" first.`);
  console.log(`smoke-runner: packaged app ${app.executable}`);

  const fuses = fuseProblems(await readFuses(app.executable));
  if (fuses.length > 0) return fail(`unsafe fuses:\n  ${fuses.join('\n  ')}`);
  console.log('smoke-runner: fuses match spec §12');

  const stubs = optionalPeerStubs(app.asar);
  if (stubs.length > 0) {
    return fail(`app.asar contains Vite optional-dependency stubs (${stubs.join(', ')}). `
      + 'Keep that package in apps/desktop "dependencies" so electron-vite leaves it external.');
  }
  console.log('smoke-runner: app.asar has no stubbed optional dependencies');

  // A throwaway profile keeps the run away from the real identity and from the
  // single-instance lock of a GhostLink that may already be running (the lock is per profile).
  const userData = mkdtempSync(join(tmpdir(), 'ghostlink-smoke-'));
  console.log(`smoke-runner: launching with GHOSTLINK_SMOKE=1 (timeout ${SMOKE_TIMEOUT_MS / 1000} s)\n`);
  try {
    const result = await runSmoke({
      command: app.executable,
      args: [`--user-data-dir=${userData}`],
      env: smokeEnv(process.env),
      onOutput: (chunk) => process.stdout.write(chunk),
    });
    const verdict = smokeVerdict(result);
    if (!verdict.ok) return fail(verdict.reason);
    console.log(`\nsmoke-runner: PASSED - ${verdict.reason}`);
    return 0;
  } finally {
    try {
      rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (error) {
      console.warn(`smoke-runner: could not remove ${userData}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

process.exitCode = await main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
