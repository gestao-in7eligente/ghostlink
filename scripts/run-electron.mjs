// Starts Electron (directly or through electron-vite) with ELECTRON_RUN_AS_NODE removed.
// VS Code's terminal exports ELECTRON_RUN_AS_NODE=1, which turns the Electron binary
// into plain Node ("Cannot find module 'electron'"), so every launcher goes through here.
//
// Usage: node scripts/run-electron.mjs [--smoke] <electron|electron-vite> [args...]
//   --smoke  runs the app with GHOSTLINK_SMOKE=1 and a throwaway GHOSTLINK_USER_DATA,
//            and fails when it has not exited on its own within 90 s.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';

const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const smoke = argv[0] === '--smoke';
if (smoke) argv.shift();
const [tool, ...args] = argv;

let command;
let commandArgs;
if (tool === 'electron') {
  // In plain Node the electron package exports the path of the binary (and downloads it when missing).
  command = require('electron');
  commandArgs = args;
} else if (tool === 'electron-vite') {
  command = process.execPath;
  commandArgs = [join(dirname(require.resolve('electron-vite/package.json')), 'bin', 'electron-vite.js'), ...args];
} else {
  console.error('usage: node scripts/run-electron.mjs [--smoke] <electron|electron-vite> [args...]');
  process.exit(2);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let userData = null;
if (smoke) {
  userData = mkdtempSync(join(tmpdir(), 'ghostlink-smoke-'));
  env.GHOSTLINK_SMOKE = '1';
  env.GHOSTLINK_USER_DATA = userData;
}

const child = spawn(command, commandArgs, { stdio: 'inherit', env });
const killer = smoke
  ? setTimeout(() => {
    console.error('smoke: the app did not exit within 90 s');
    child.kill();
  }, 90_000)
  : null;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));

child.on('exit', (code, signal) => {
  if (killer) clearTimeout(killer);
  if (userData) rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  if (smoke) console.log(code === 0 ? 'smoke: OK' : `smoke: FAILED (${code ?? signal})`);
  process.exit(code ?? 1);
});
