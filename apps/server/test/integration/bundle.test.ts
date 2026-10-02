import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SERVER_VERSION } from '../../src/index.js';

const serverRoot = fileURLToPath(new URL('../../', import.meta.url));
const cli = join(serverRoot, 'dist', 'cli.js');
const nodeFlags = ['--disable-warning=ExperimentalWarning'];
let dataDir: string;

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: serverRoot, stdio: 'pipe' });
  dataDir = mkdtempSync(join(tmpdir(), 'ghostlink-bundle-'));
}, 60_000);
afterAll(() => {
  // Best effort: on Windows under load the spawned CLI can still hold the database for a
  // moment (EPERM). A leftover temp folder must not fail the run.
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // The system temp cleaner takes it.
  }
});

describe('bundled CLI (dist/cli.js)', () => {
  it('ships the migrations next to the bundle', () => {
    expect(existsSync(cli)).toBe(true);
    expect(existsSync(join(serverRoot, 'dist', 'migrations', '001_init.sql'))).toBe(true);
  });

  it('runs "version" without node_modules-only tricks', () => {
    const out = execFileSync(process.execPath, [...nodeFlags, cli, 'version'], { encoding: 'utf8' });
    expect(out.trim()).toBe(SERVER_VERSION);
  });

  it("loads the Ghost DJ's LiveKit audio from the bundle and its native add-on in dist/node_modules", () => {
    // Exit code 1 when ffmpeg is missing on this machine: only the add-on line matters here.
    const r = spawnSync(process.execPath, [...nodeFlags, cli, 'ghost-dj'], { encoding: 'utf8', timeout: 30_000 });
    expect(r.stdout.split(/\r?\n/)).toContain('LiveKit audio (@livekit/rtc-node): ok');
  });

  it('"start" serves /health on the printed port', async () => {
    const child = spawn(process.execPath, [...nodeFlags, cli, 'start', '--data', dataDir, '--port', '0', '--host', '127.0.0.1'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        let buffer = '';
        const timer = setTimeout(() => reject(new Error(`no "Listening on" line; got: ${buffer}`)), 15_000);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          buffer += chunk;
          const m = /Listening on 127\.0\.0\.1:(\d+)/.exec(buffer);
          if (m) {
            clearTimeout(timer);
            resolve(Number(m[1]));
          }
        });
        child.once('exit', (code) => reject(new Error(`exited early with ${code}: ${buffer}`)));
      });
      const body = await new Promise<string>((resolve, reject) => {
        request({ host: '127.0.0.1', port, path: '/health', rejectUnauthorized: false }, (res) => {
          let b = '';
          res.on('data', (c: Buffer) => (b += c.toString()));
          res.on('end', () => resolve(b));
        }).on('error', reject).end();
      });
      expect(JSON.parse(body)).toMatchObject({ ok: true, version: SERVER_VERSION });
    } finally {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }
  }, 30_000);
});
