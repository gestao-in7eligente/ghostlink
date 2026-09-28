// Building blocks of scripts/smoke.mjs (spec §12 fuses, §14 packaged smoke test).
// No top-level side effects, so scripts/test/smoke.test.ts can exercise every piece.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';

export const PRODUCT_NAME = 'GhostLink';
export const SMOKE_TIMEOUT_MS = 60_000;
/** Start of the line apps/desktop/src/main/smoke.ts logs right before app.exit(0). */
export const SMOKE_OK_MARKER = 'smoke: OK';

/** Fuse states the packaged binary must carry (spec §12; electron-builder flips them before signing). */
export const EXPECTED_FUSES = Object.freeze({
  RunAsNode: FuseState.DISABLE,
  EnableNodeOptionsEnvironmentVariable: FuseState.DISABLE,
  EnableNodeCliInspectArguments: FuseState.DISABLE,
  EnableEmbeddedAsarIntegrityValidation: FuseState.ENABLE,
  OnlyLoadAppFromAsar: FuseState.ENABLE,
  GrantFileProtocolExtraPrivileges: FuseState.DISABLE,
});

const STATE_NAMES = new Map([
  [FuseState.DISABLE, 'disabled'],
  [FuseState.ENABLE, 'enabled'],
  [FuseState.REMOVED, 'removed'],
  [FuseState.INHERIT, 'inherit'],
]);

/**
 * Files electron-builder leaves in apps/desktop/dist for the host platform.
 * Windows builds are x64 only (they also run on Windows on Arm through emulation);
 * macOS builds exist for arm64 (dist/mac-arm64) and x64 (dist/mac).
 * @param {{ distDir: string; platform: string; arch: string }} target
 * @returns {{ executable: string; asar: string }}
 */
export function packagedApp({ distDir, platform, arch }) {
  if (platform === 'win32') {
    const root = join(distDir, 'win-unpacked');
    return { executable: join(root, `${PRODUCT_NAME}.exe`), asar: join(root, 'resources', 'app.asar') };
  }
  if (platform === 'darwin') {
    const contents = join(distDir, arch === 'arm64' ? 'mac-arm64' : 'mac', `${PRODUCT_NAME}.app`, 'Contents');
    return { executable: join(contents, 'MacOS', PRODUCT_NAME), asar: join(contents, 'Resources', 'app.asar') };
  }
  throw new Error(`GhostLink is packaged for Windows and macOS only; there is no desktop build for "${platform}".`);
}

/**
 * Environment for the app under test: no ELECTRON_RUN_AS_NODE (VS Code exports it, and it
 * would turn an unfused Electron into plain Node) and GHOSTLINK_SMOKE=1. Windows variable
 * names are case-insensitive, so every spelling of both names is replaced.
 * @param {Record<string, string | undefined>} base
 * @returns {Record<string, string>}
 */
export function smokeEnv(base) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    const upper = key.toUpperCase();
    if (value === undefined || upper === 'ELECTRON_RUN_AS_NODE' || upper === 'GHOSTLINK_SMOKE') continue;
    env[key] = value;
  }
  env.GHOSTLINK_SMOKE = '1';
  return env;
}

/**
 * Lists fuse settings that differ from EXPECTED_FUSES. An empty list means the binary is safe.
 * @param {Record<string, unknown>} wire result of getCurrentFuseWire()
 * @returns {string[]}
 */
export function fuseProblems(wire) {
  if (wire.version !== '1') return [`unsupported fuse wire version "${String(wire.version)}" (expected "1")`];
  /** @type {string[]} */
  const problems = [];
  for (const [name, expected] of Object.entries(EXPECTED_FUSES)) {
    const actual = wire[FuseV1Options[/** @type {keyof typeof FuseV1Options} */ (name)]];
    if (actual === undefined) {
      problems.push(`${name}: missing from the fuse wire`);
    } else if (actual !== expected) {
      const found = STATE_NAMES.get(/** @type {number} */ (actual)) ?? `unknown state ${String(actual)}`;
      problems.push(`${name}: expected ${STATE_NAMES.get(expected)}, found ${found}`);
    }
  }
  return problems;
}

/**
 * Reads the fuse wire of a packaged app. On macOS @electron/fuses maps
 * "<name>.app/Contents/MacOS/<name>" to the Electron Framework binary that holds the wire.
 * @param {string} executable
 */
export function readFuses(executable) {
  return getCurrentFuseWire(executable);
}

/**
 * Names of the stubs Vite writes when it bundles a package whose optional dependency is
 * missing (`__viteOptionalPeerDep_<dep>_<package>_<flag>`). ws probes `bufferutil` inside
 * try/catch; with the stub the probe "succeeds" and every WebSocket frame of 32+ bytes then
 * throws "bufferUtil.mask is not a function". Such packages must stay external.
 * app.asar stores files uncompressed, so scanning its bytes finds a stub in any bundle.
 * @param {string} asarPath
 * @returns {string[]}
 */
export function optionalPeerStubs(asarPath) {
  const text = readFileSync(asarPath).toString('latin1');
  return [...new Set(text.match(/__viteOptionalPeerDep_[\w$]+/g) ?? [])].sort();
}

/**
 * @typedef {{ exitCode: number | null; signal: string | null; timedOut: boolean; output: string; durationMs: number }} SmokeResult
 */

/**
 * Runs the app and resolves when it exits or after `timeoutMs`, killing the whole process
 * tree on timeout (Electron starts GPU, renderer and utility child processes).
 * @param {{ command: string; args?: string[]; env: Record<string, string>; timeoutMs?: number; onOutput?: (chunk: string) => void }} options
 * @returns {Promise<SmokeResult>}
 */
export function runSmoke({ command, args = [], env, timeoutMs = SMOKE_TIMEOUT_MS, onOutput = () => {} }) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group on POSIX, so a timeout can kill the helpers too.
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    let output = '';
    let timedOut = false;
    const collect = (/** @type {Buffer} */ chunk) => {
      const text = chunk.toString('utf8');
      output += text;
      onOutput(text);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, timedOut, output, durationMs: Date.now() - started });
    });
  });
}

/** @param {number | undefined} pid */
function killTree(pid) {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

/**
 * Pass only when the app exited by itself with code 0 AND reached the end of smoke mode.
 * Exit code 0 alone is not enough: a second instance quits with 0 when the single-instance
 * lock is taken, without testing anything.
 * @param {SmokeResult} result
 * @param {number} [timeoutMs]
 * @returns {{ ok: boolean; reason: string }}
 */
export function smokeVerdict(result, timeoutMs = SMOKE_TIMEOUT_MS) {
  if (result.timedOut) return { ok: false, reason: `the app did not exit within ${timeoutMs / 1000} s and was killed` };
  if (result.exitCode !== 0) {
    const how = result.exitCode === null ? `signal ${result.signal}` : `code ${result.exitCode}`;
    return { ok: false, reason: `the app exited with ${how}` };
  }
  if (!result.output.includes(SMOKE_OK_MARKER)) {
    return {
      ok: false,
      reason: `the app exited with code 0 but never printed "${SMOKE_OK_MARKER}" `
        + '(smoke mode not reached, or another GhostLink instance held the single-instance lock)',
    };
  }
  return { ok: true, reason: `the app exited with code 0 after ${(result.durationMs / 1000).toFixed(1)} s` };
}
