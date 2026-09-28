import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FuseState, FuseV1Options } from '@electron/fuses';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EXPECTED_FUSES,
  SMOKE_OK_MARKER,
  fuseProblems,
  optionalPeerStubs,
  packagedApp,
  readFuses,
  runSmoke,
  smokeEnv,
  smokeVerdict,
} from '../lib/smoke.mjs';

const fakeApp = fileURLToPath(new URL('./fixtures/fake-app.mjs', import.meta.url));
// @electron/fuses scans binaries for this sentinel (dist/constants.js; not exported by the package).
const FUSE_SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
const FUSE_WIRE_LENGTH = 9; // Electron 44 has 9 V1 fuses

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ghostlink-smoke-test-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Wire as electron-builder leaves it: the six spec §12 fuses set, the rest left enabled. */
function safeWire(): Record<number, number> {
  const wire: Record<number, number> = {};
  for (let i = 0; i < FUSE_WIRE_LENGTH; i++) wire[i] = FuseState.ENABLE;
  for (const [name, state] of Object.entries(EXPECTED_FUSES)) wire[FuseV1Options[name as keyof typeof FuseV1Options]] = state;
  return wire;
}

/** Bytes laid out like a real Electron binary: padding, sentinel, version 1, length, states. */
function fakeElectronBinary(wire: Record<number, number>, length = FUSE_WIRE_LENGTH): Buffer {
  const states = Buffer.alloc(length);
  for (let i = 0; i < length; i++) states[i] = wire[i] ?? FuseState.ENABLE;
  return Buffer.concat([Buffer.alloc(4096, 0x2a), Buffer.from(FUSE_SENTINEL), Buffer.from([1, length]), states, Buffer.alloc(4096, 0x2a)]);
}

describe('packagedApp', () => {
  it('points at win-unpacked on Windows, whatever the host CPU (the build is x64 only)', () => {
    for (const arch of ['x64', 'arm64']) {
      expect(packagedApp({ distDir: 'dist', platform: 'win32', arch })).toEqual({
        executable: join('dist', 'win-unpacked', 'GhostLink.exe'),
        asar: join('dist', 'win-unpacked', 'resources', 'app.asar'),
      });
    }
  });

  it('points inside the .app bundle of the host architecture on macOS', () => {
    expect(packagedApp({ distDir: 'dist', platform: 'darwin', arch: 'arm64' })).toEqual({
      executable: join('dist', 'mac-arm64', 'GhostLink.app', 'Contents', 'MacOS', 'GhostLink'),
      asar: join('dist', 'mac-arm64', 'GhostLink.app', 'Contents', 'Resources', 'app.asar'),
    });
    expect(packagedApp({ distDir: 'dist', platform: 'darwin', arch: 'x64' }).executable)
      .toBe(join('dist', 'mac', 'GhostLink.app', 'Contents', 'MacOS', 'GhostLink'));
  });

  it('refuses platforms GhostLink does not ship a desktop build for', () => {
    expect(() => packagedApp({ distDir: 'dist', platform: 'linux', arch: 'x64' })).toThrow(/Windows and macOS only/);
  });
});

describe('smokeEnv', () => {
  it('drops every spelling of ELECTRON_RUN_AS_NODE and forces GHOSTLINK_SMOKE=1', () => {
    const base = {
      PATH: '/usr/bin',
      ELECTRON_RUN_AS_NODE: '1',
      electron_run_as_node: '1',
      Ghostlink_Smoke: '0',
      EMPTY: undefined,
    };
    const env = smokeEnv(base);
    expect(env).toEqual({ PATH: '/usr/bin', GHOSTLINK_SMOKE: '1' });
    expect(base.ELECTRON_RUN_AS_NODE).toBe('1'); // input untouched
  });
});

describe('runSmoke + smokeVerdict', () => {
  const run = (mode: string, timeoutMs = 20_000, extra: string[] = []) =>
    runSmoke({ command: process.execPath, args: [fakeApp, mode, ...extra], env: smokeEnv(process.env), timeoutMs });

  it('passes when the app exits 0 after printing the marker, and captures its log', async () => {
    const chunks: string[] = [];
    const result = await runSmoke({
      command: process.execPath,
      args: [fakeApp, 'pass'],
      env: smokeEnv(process.env),
      onOutput: (chunk) => chunks.push(chunk),
    });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.output).toContain('[smoke] renderer loaded');
    expect(chunks.join('')).toBe(result.output);
    expect(smokeVerdict(result)).toMatchObject({ ok: true });
  });

  it('fails an exit code 0 without the marker (e.g. a second instance that just quit)', async () => {
    const verdict = smokeVerdict(await run('exit-without-marker'));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain(SMOKE_OK_MARKER);
    expect(verdict.reason).toMatch(/single-instance lock/);
  });

  it('fails a non-zero exit even when the marker was printed, and keeps stderr', async () => {
    const crash = await run('crash');
    expect(crash.output).toContain('boom: the server entry failed to start');
    expect(smokeVerdict(crash)).toEqual({ ok: false, reason: 'the app exited with code 3' });
    expect(smokeVerdict(await run('marker-then-fail'))).toEqual({ ok: false, reason: 'the app exited with code 1' });
  });

  it('kills an app that hangs and reports the timeout', async () => {
    const result = await run('hang', 1_500);
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(10_000);
    expect(smokeVerdict(result, 1_500)).toEqual({ ok: false, reason: 'the app did not exit within 1.5 s and was killed' });
  });

  it('hands the sanitized environment and the arguments to the app', async () => {
    const result = await runSmoke({
      command: process.execPath,
      args: [fakeApp, 'echo-env', '--user-data-dir=/tmp/x'],
      env: smokeEnv({ ...process.env, ELECTRON_RUN_AS_NODE: '1' }),
    });
    const seen = JSON.parse(result.output.split('\n')[0]!) as { runAsNode: string | null; smoke: string | null; args: string[] };
    expect(seen).toEqual({ runAsNode: null, smoke: '1', args: ['--user-data-dir=/tmp/x'] });
  });

  it('rejects when the executable does not exist', async () => {
    await expect(runSmoke({ command: join(tempDir(), 'missing.exe'), env: smokeEnv(process.env) })).rejects.toThrow(/ENOENT/);
  });
});

describe('fuseProblems', () => {
  it('accepts exactly the spec §12 fuse settings', () => {
    expect(fuseProblems({ version: '1', ...safeWire() })).toEqual([]);
  });

  it('reports each unsafe fuse by name', () => {
    const wire = safeWire();
    wire[FuseV1Options.RunAsNode] = FuseState.ENABLE;
    wire[FuseV1Options.OnlyLoadAppFromAsar] = FuseState.INHERIT;
    wire[FuseV1Options.EnableEmbeddedAsarIntegrityValidation] = FuseState.REMOVED;
    expect(fuseProblems({ version: '1', ...wire })).toEqual([
      'RunAsNode: expected disabled, found enabled',
      'EnableEmbeddedAsarIntegrityValidation: expected enabled, found removed',
      'OnlyLoadAppFromAsar: expected enabled, found inherit',
    ]);
  });

  it('reports fuses missing from a shorter (older Electron) wire and unknown wire versions', () => {
    const short: Record<string, unknown> = { version: '1' };
    for (let i = 0; i < 5; i++) short[i] = safeWire()[i];
    expect(fuseProblems(short)).toEqual([
      'OnlyLoadAppFromAsar: missing from the fuse wire',
      'GrantFileProtocolExtraPrivileges: missing from the fuse wire',
    ]);
    expect(fuseProblems({ version: '2', ...safeWire() })).toEqual(['unsupported fuse wire version "2" (expected "1")']);
  });
});

describe('readFuses', () => {
  it('reads the wire from a Windows executable', async () => {
    const exe = join(tempDir(), 'GhostLink.exe');
    writeFileSync(exe, fakeElectronBinary(safeWire()));
    expect(fuseProblems(await readFuses(exe))).toEqual([]);
  });

  it('reads the Electron Framework binary when given the macOS app executable', async () => {
    const app = join(tempDir(), 'GhostLink.app', 'Contents');
    mkdirSync(join(app, 'MacOS'), { recursive: true });
    mkdirSync(join(app, 'Frameworks', 'Electron Framework.framework'), { recursive: true });
    writeFileSync(join(app, 'MacOS', 'GhostLink'), 'launcher stub without a fuse wire');
    const unsafe = safeWire();
    unsafe[FuseV1Options.RunAsNode] = FuseState.ENABLE;
    writeFileSync(join(app, 'Frameworks', 'Electron Framework.framework', 'Electron Framework'), fakeElectronBinary(unsafe));
    expect(fuseProblems(await readFuses(join(app, 'MacOS', 'GhostLink')))).toEqual(['RunAsNode: expected disabled, found enabled']);
  });

  it('fails on a binary without a fuse wire', async () => {
    const exe = join(tempDir(), 'not-electron.exe');
    writeFileSync(exe, Buffer.alloc(1024, 0x2a));
    await expect(readFuses(exe)).rejects.toThrow(/sentinel/);
  });
});

describe('optionalPeerStubs', () => {
  /** app.asar layout: a binary header, then every file stored uncompressed. */
  function fakeAsar(...files: string[]): string {
    const path = join(tempDir(), 'app.asar');
    writeFileSync(path, Buffer.concat([Buffer.from([4, 0, 0, 0, 0xff, 0xfe, 0x00]), ...files.map((f) => Buffer.from(f, 'utf8'))]));
    return path;
  }

  it('names every distinct stub Vite left in the bundles', () => {
    const asar = fakeAsar(
      'import{a}from"node:fs";const __viteOptionalPeerDep_bufferutil_ws_true = {};getAugmentedNamespace(__viteOptionalPeerDep_bufferutil_ws_true);',
      '"use strict";const __viteOptionalPeerDep_utf_8_validate_ws_true$1 = {};',
    );
    expect(optionalPeerStubs(asar)).toEqual([
      '__viteOptionalPeerDep_bufferutil_ws_true',
      '__viteOptionalPeerDep_utf_8_validate_ws_true$1',
    ]);
  });

  it('accepts an archive where ws stayed external', () => {
    expect(optionalPeerStubs(fakeAsar('import { WebSocketServer } from "ws";', '{"name":"ws","version":"8.22.0"}'))).toEqual([]);
  });

  it('fails loudly when the archive is missing', () => {
    expect(() => optionalPeerStubs(join(tempDir(), 'app.asar'))).toThrow(/ENOENT/);
  });
});
