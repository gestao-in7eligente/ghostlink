import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Runs the real `electron-vite build` into a temp dir and checks the properties
// the running app depends on (the smoke run then proves them in a real Electron).
const appDir = fileURLToPath(new URL('../', import.meta.url));
let out: string;
const read = (path: string) => readFileSync(join(out, path), 'utf8');

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), 'ghostlink-build-'));
  const cli = join(dirname(createRequire(import.meta.url).resolve('electron-vite/package.json')), 'bin', 'electron-vite.js');
  execFileSync(process.execPath, [cli, 'build', '--outDir', out, '--logLevel', 'error'], { cwd: appDir, stdio: 'pipe' });
}, 120_000);
afterAll(() => rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

describe('electron-vite build', () => {
  it('bundles both main entries and ships the server migrations next to them', () => {
    expect(existsSync(join(out, 'main', 'index.js'))).toBe(true);
    expect(existsSync(join(out, 'main', 'serverEntry.js'))).toBe(true);
    const source = readFileSync(join(appDir, '..', 'server', 'src', 'db', 'migrations', '001_init.sql'), 'utf8');
    expect(read('main/migrations/001_init.sql')).toBe(source);
  });

  it('bundles the workspace packages and leaves runtime dependencies in node_modules', () => {
    const entry = read('main/serverEntry.js');
    expect(entry).not.toContain('@ghostlink/');
    expect(entry).toMatch(/from "ws"/);
    expect(entry).toMatch(/from "zod"/);
  });

  it('imports reflect-metadata before @peculiar/x509 in the server bundle', () => {
    const entry = read('main/serverEntry.js');
    const polyfill = entry.indexOf('import "reflect-metadata"');
    expect(polyfill).toBeGreaterThanOrEqual(0);
    expect(polyfill).toBeLessThan(entry.indexOf('from "@peculiar/x509"'));
  });

  it('leaves electron-updater in node_modules (it loads its own CommonJS dependencies)', () => {
    expect(read('main/index.js')).toMatch(/from "electron-updater"/);
  });

  it('keeps the server (SQLite, x509) out of the window process bundle', () => {
    const main = read('main/index.js');
    for (const module of ['node:sqlite', '@peculiar/x509', 'reflect-metadata']) expect(main, module).not.toContain(module);
  });

  it('emits the sandboxed preload as CommonJS that only requires electron', () => {
    const preload = read('preload/index.cjs');
    expect(preload).not.toMatch(/^\s*(import|export)\s/m);
    expect([...preload.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1])).toEqual(['electron']);
  });

  it('emits a renderer that app:// can serve under the CSP: relative assets, no inline script', () => {
    const html = read('renderer/index.html');
    expect(html).toMatch(/<script type="module" crossorigin src="\.\/assets\/index-[\w-]+\.js"><\/script>/);
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
  });

  it('ships the noise suppressors as files under app:// (script-src allows no data: URLs)', () => {
    const assets = readdirSync(join(out, 'renderer', 'assets'));
    for (const wasm of ['rnnoise', 'rnnoise_simd', 'speex', 'gtcrn']) {
      expect(assets.filter((a) => new RegExp(`^${wasm}-[\\w-]+\\.wasm$`).test(a)), wasm).toHaveLength(1);
    }
    expect(assets.filter((a) => /^workletProcessor-[\w-]+\.js$/.test(a))).toHaveLength(3);
    expect(assets.filter((a) => /^workletPorts-[\w-]+\.js$/.test(a))).toHaveLength(1);
    const bundle = assets.filter((a) => /^index-[\w-]+\.js$/.test(a)).map((a) => read(`renderer/assets/${a}`)).join('\n');
    expect(bundle).toContain('workletPorts-');
    expect(bundle).not.toMatch(/data:(?:text|application)\/javascript|data:application\/wasm/);
  });
});
