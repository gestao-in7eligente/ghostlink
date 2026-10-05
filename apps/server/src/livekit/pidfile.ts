import { execFile } from 'node:child_process';
import { readFileSync, readlinkSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeSecretFile } from '../config/paths.js';

export interface PidfileDeps {
  isAlive(pid: number): boolean;
  /** Full path of the executable running as `pid`, or null when unknown. */
  exePath(pid: number): Promise<string | null>;
  kill(pid: number): void;
  sleep(ms: number): Promise<void>;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((done) => {
    execFile(file, args, { timeout: 10_000, windowsHide: true }, (error, stdout) => done(error ? null : stdout.trim() || null));
  });
}

/** How to read another process's executable path on each OS (no wmic: gone from Windows 11 24H2+). */
async function exePath(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    try {
      return readlinkSync(`/proc/${pid}/exe`);
    } catch {
      return null;
    }
  }
  if (process.platform === 'win32') {
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).Path`]);
  }
  return run('ps', ['-o', 'comm=', '-p', String(pid)]);
}

export const systemPidfileDeps: PidfileDeps = {
  isAlive,
  exePath,
  kill: (pid) => process.kill(pid),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  return norm(a) === norm(b);
}

export function writePidfile(path: string, pid: number, exe: string): void {
  writeSecretFile(path, `${JSON.stringify({ pid, exe })}\n`);
}

export function removePidfile(path: string): void {
  rmSync(path, { force: true });
}

/**
 * Cleans up a LiveKit left behind by a crashed server (spec §8.1): kills the PID in the
 * pidfile only when that process is still running AND its executable is the expected
 * livekit-server (a recycled PID may now belong to anything). The pidfile is removed
 * in every case. Returns what happened.
 */
export async function killStaleLivekit(pidfile: string, expectedExe: string, deps: PidfileDeps = systemPidfileDeps): Promise<'none' | 'killed' | 'skipped'> {
  let recorded: { pid?: unknown; exe?: unknown };
  try {
    recorded = JSON.parse(readFileSync(pidfile, 'utf8')) as typeof recorded;
  } catch {
    removePidfile(pidfile);
    return 'none';
  }
  const pid = recorded.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || pid === process.pid || !deps.isAlive(pid)) {
    removePidfile(pidfile);
    return 'none';
  }
  const actual = await deps.exePath(pid);
  if (actual === null || !samePath(actual, expectedExe)) {
    removePidfile(pidfile);
    return 'skipped';
  }
  try {
    deps.kill(pid);
  } catch {
    // already gone
  }
  for (let i = 0; i < 30 && deps.isAlive(pid); i++) await deps.sleep(100);
  removePidfile(pidfile);
  return 'killed';
}
