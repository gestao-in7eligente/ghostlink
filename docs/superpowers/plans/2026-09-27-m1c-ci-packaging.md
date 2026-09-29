# GhostLink M1c — CI and Packaging Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the Milestone 1 desktop app as a per-user NSIS installer (Windows) and ad-hoc signed DMGs (macOS arm64 + x64) with the spec §12 Electron fuses, prove every package starts with an automated smoke test, and run lint, typecheck, tests, packaging and the smoke test in GitHub Actions on every push to `main` and every pull request.

**Architecture:** `apps/desktop/electron-builder.yml` (electron-builder 26.15.3) turns the electron-vite output (`apps/desktop/out`) into installers; the build resources (`build/icon.svg`, `build/entitlements.mac.plist`, `build/installer.nsh`) sit next to it. A small Node runner, `scripts/smoke.mjs` (logic in `scripts/lib/smoke.mjs`), checks the packaged binary's fuses and `app.asar`, then launches the app with `GHOSTLINK_SMOKE=1` in a throwaway profile and requires exit code 0 plus the app's `smoke: OK` line within 60 s. `.github/workflows/ci.yml` has a `test` job (Windows, Linux, macOS) and a `package` job (Windows, macOS); policy tests in a new `tooling` Vitest project pin the security-relevant settings of both files.

**Tech Stack:** electron-builder 26.15.3 · Electron 44.4.5 · electron-vite 5.0.0 · @electron/fuses 2.1.3 · yaml 2.9.1 · Vitest 5.0.2 · TypeScript 6.0.3 (with `checkJs` for the `.mjs` scripts) · GitHub Actions (`actions/checkout` v7.0.1, `actions/setup-node` v7.0.0, `actions/upload-artifact` v7.0.1, pinned by SHA)

---

## Before you start (read once)

**Authoritative sources.** Names, versions and paths come from `docs/superpowers/plans/2026-09-27-m1-interfaces.md` (the "contract", §6 for this plan). Behaviour comes from `docs/superpowers/specs/2026-09-27-ghostlink-design.md` (Portuguese; §12 Electron security, §14 tests, §15 build and CI, §17 milestone 1). Every addition or deviation is listed in **Contract notes** at the end.

**Scope.** `electron-builder.yml` and its build resources, the packaged smoke test, the CI workflow, and the pt-BR README commands. **Out of scope:** `release.yml`, auto-update, code signing and `publisherName` (Milestone 9), LiveKit `extraResources` (Milestone 5), macOS deep-link `protocols` (Milestone 8), the e2e CI job (arrives with the first e2e test in Milestone 2).

**Prerequisites.** Plans 1a (`2026-09-27-m1a-shared-server.md`) and 1b (`2026-09-27-m1b-desktop.md`) are merged. Check:

```bash
git log --oneline | head -5
ls apps/desktop/electron.vite.config.ts apps/desktop/src/main/smoke.ts apps/desktop/src/main/serverEntry.ts scripts/run-electron.mjs
grep -n "smoke: OK" apps/desktop/src/main/smoke.ts
npm run build -w @ghostlink/desktop
```

Expected: the four files exist; `grep` prints the line that logs `smoke: OK (renderer ready, hosted server served TLS on port … and stopped)`; the electron-vite build ends with three `✓ built in …` lines and leaves `apps/desktop/out/main/serverEntry.js` and `apps/desktop/out/main/migrations/001_init.sql`. The smoke runner of this plan relies on two behaviours of plan 1b's `main/index.ts` + `main/smoke.ts`: in smoke mode the app logs a line starting with `smoke: OK` to **stdout** right before `app.exit(0)`, and it exits with code **1** when the single-instance lock is taken.

**Branch.** If you are on `main` and your executor did not create a worktree, first run `git switch -c m1c-ci-packaging`.

**Environment facts (verified on the Windows dev machine).**
- Run every command **from the repository root** in Git Bash unless a step says otherwise. They also run unchanged in GitHub Actions (`shell: bash` on all three OSes).
- The VS Code terminal exports `ELECTRON_RUN_AS_NODE=1`. It does **not** affect `npm run dist` (electron-builder never starts Electron), `npm run smoke` removes it, and the packaged app ignores it anyway (the `runAsNode` fuse is off). The *dev* Electron breaks with it; use `npm run dev` / `scripts/run-electron.mjs` there.
- The network is flaky. `npm install` always gets `--fetch-retries=6 --fetch-retry-mintimeout=5000`. The first `npm run dist` downloads the Electron 44.4.5 zip (~160 MB, cached in `%LOCALAPPDATA%\electron\Cache`) and electron-builder's NSIS, 7-Zip and icon toolsets (cached in `%LOCALAPPDATA%\electron-builder\Cache`). If a download fails, run the command again.
- Git Bash rewrites arguments that start with `/` into Windows paths (`/S` becomes `S:/`). Windows-only commands with `/` flags (installer `/S`, `reg … /f`) are prefixed with `MSYS_NO_PATHCONV=1`.
- Run one test file with `npm test -- <path>`. Vitest prints e.g. `Test Files  1 passed (1)` / `Tests  19 passed (19)`.

**Facts verified while writing this plan** (electron-builder 26.15.3 + electron-vite 5.0.0 + Electron 44.4.5 on this machine: every file of this plan was applied to a copy of the plan-1a server plus plan 1b's work-in-progress desktop app, then `npm test`, `npm run dist`, `npm run smoke` and the Task 10 checks were run). You do not need to re-verify them; they explain the design:

1. electron-vite 5 keeps **every** `dependencies` entry of `apps/desktop/package.json` external (except the ones plan 1b excludes: `@ghostlink/shared`, `@ghostlink/server`) and bundles everything else. electron-builder copies each `dependencies` entry, with its own dependencies, into `app.asar` (its npm collector finds 0 packages in a workspace member and falls back to `using manual traversal of node_modules` — that log line is expected). With plan 1b's list the `app.asar` is ~24 MB: besides the four packages the main-process bundles really load at run time (`ws`, `zod`, `@peculiar/x509`, `reflect-metadata`), it carries the TypeScript source of `@ghostlink/*`, React, zustand and ~420 Inter font files, all of which are bundled anyway. Moving those six bundled-only packages to `devDependencies` (plan 1b's contract note 13 invites it) gives a ~9 MB `app.asar` holding only the four runtime packages and their dependencies; the whole suite — plan 1b's `test/build.test.ts` included — `npm run dist` and `npm run smoke` pass both ways. Task 7 does that move.
2. **`ws` must stay external.** When Vite bundles `ws`, it replaces ws's optional `require('bufferutil')` with an empty stub (`__viteOptionalPeerDep_bufferutil_ws_true`); ws then calls `bufferUtil.mask` on every frame of 32+ bytes and throws `bufferUtil$1.mask is not a function` (reproduced with a 200-byte echo). The packaged smoke test (fork, TLS probe, shutdown) never sends such a frame, so `npm run smoke` scans `app.asar` for these stubs.
3. Without `extraMetadata`, the packaged app's `userData` is `%APPDATA%\@ghostlink\desktop` and the per-user install folder `%LOCALAPPDATA%\Programs\@ghostlinkdesktop` — both derived from the workspace name. Spec §3.6 freezes them from 0.1.0, so `extraMetadata` sets `productName: GhostLink` (→ `%APPDATA%\GhostLink`) and `name: ghostlink` (→ `%LOCALAPPDATA%\Programs\ghostlink`).
4. Without `author` in `apps/desktop/package.json`, electron-builder warns `author is missed in the package.json` and `GhostLink.exe` keeps Electron's `CompanyName` "GitHub, Inc.".
5. electron-builder 26.15.3 rasterizes `build/icon.svg` itself (its checksum-pinned `icons@1.1.0` WASM toolset: resvg + libvips) into a 7-size ICO (16–256 px) and an ICNS (`icp4`…`ic14`, up to 1024 px). Verified on Windows for both formats; the app and the installer carry the icon. No PNG/ICO/ICNS is committed and no rasterizer dependency is needed.
6. `${isUpdated}` is defined by electron-builder's generated NSIS header and usable in `installer.nsh`. Verified: silent install → the `HKCU\Software\Classes\ghostlink` key survives a reinstall (update path) → the uninstaller removes it.
7. `electronFuses` is applied (`executing @electron/fuses`); `@electron/fuses` 2.1.3 reads the six spec §12 values back from `win-unpacked/GhostLink.exe`. Changing one byte inside `app.asar` makes the app print `ASAR Integrity Violation: got a hash mismatch` and exit 1.
8. The packaged Electron 44 honours `--user-data-dir=<dir>` (`app.getPath('userData')` follows it), so the smoke test runs in a throwaway profile — away from the developer's real identity and from the single-instance lock of a GhostLink that may be running.
9. electron-builder's config keys were checked against `app-builder-lib/scheme.json` 26.15.3 (it validates the file and rejects unknown keys). `publisherName` lives at `win.signtoolOptions.publisherName` in 26.x (Milestone 9).
10. `electron@44.4.5` has **no** postinstall script: `npm ci` does not download the Electron binary; `require('electron')` downloads it on first use, and electron-builder downloads its own copy for packaging.

**Commits.** Conventional style; every message ends with a blank line and the trailer shown in each task. Always use the heredoc form given in the task.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `scripts/vitest.config.ts` | Create | Vitest project `tooling`: tests for repository scripts and CI/packaging policies |
| `scripts/tsconfig.json` | Create | Typechecks the `.mjs` scripts (`checkJs`) and the tooling tests |
| `scripts/lib/smoke.mjs` | Create | Smoke building blocks: packaged-app paths, sanitized env, fuse check, `app.asar` stub scan, run-with-timeout, verdict |
| `scripts/smoke.mjs` | Create | `npm run smoke`: static checks of the package, then launches it in smoke mode and reports |
| `scripts/test/fixtures/fake-app.mjs` | Create | Stand-in "packaged app" with scripted behaviours for the runner tests |
| `scripts/test/smoke.test.ts` | Create | Runner behaviour: paths, env, pass/fail/timeout verdicts, fuse wire parsing, stub scan |
| `scripts/test/icon.test.ts` | Create | The icon is a self-contained 1024×1024 SVG in the spec palette |
| `scripts/test/macEntitlements.test.ts` | Create | Exactly the five spec §15 entitlements |
| `scripts/test/nsisInclude.test.ts` | Create | The uninstall hook removes only the `ghostlink://` key, never during updates |
| `scripts/test/electronBuilderConfig.test.ts` | Create | Pins identity, fuses, installer options, the exact runtime dependencies (`ws` among them) and the build toolchain as dev-only |
| `scripts/test/ciWorkflow.test.ts` | Create | Pins action SHAs, permissions, triggers, matrices, step order, keychain, artifacts |
| `apps/desktop/build/icon.svg` | Create | App icon source (ghost + chain link); electron-builder derives ICO/ICNS from it |
| `apps/desktop/build/entitlements.mac.plist` | Create | Hardened-runtime entitlements for the app and its helpers |
| `apps/desktop/build/installer.nsh` | Create | NSIS `customUnInstall`: delete `HKCU\Software\Classes\ghostlink` |
| `apps/desktop/electron-builder.yml` | Create | Packaging configuration (contract §6, spec §12/§15) |
| `.github/workflows/ci.yml` | Create | `test` and `package` jobs |
| `apps/desktop/package.json` | Modify | `author`, `dist` script, `electron-builder` devDependency; the six bundled-only packages move to `devDependencies` |
| `package.json` | Modify | Root scripts `dist`, `smoke`, `typecheck` (+ scripts/); devDependencies `@electron/fuses`, `yaml` |
| `package-lock.json` | Modify | Regenerated by `npm install` |
| `vitest.config.ts` | Modify | Adds the `scripts` project |
| `README.md` | Modify | pt-BR development, packaging and CI section |

---

### Task 1: Tooling test project for repository scripts

**Files:**
- Create: `scripts/vitest.config.ts`, `scripts/tsconfig.json`
- Modify: `vitest.config.ts`, `package.json`, `package-lock.json`

Configuration only; its "test" is that the new project and typecheck run cleanly while empty. The `tooling` project holds every test of this plan: they check repository files (`scripts/`, `apps/desktop/build/`, `electron-builder.yml`, `.github/`), not a workspace package.

- [ ] **Step 1: Install the two root dev tools**

`@electron/fuses` reads the fuse wire of the packaged binary (electron-builder bundles its own older copy, 1.8.0, nested under `app-builder-lib`; both coexist). `yaml` parses `electron-builder.yml` and `ci.yml` in the policy tests.

Run:
```bash
npm install --save-dev --save-exact --fetch-retries=6 --fetch-retry-mintimeout=5000 --no-audit --no-fund @electron/fuses@2.1.3 yaml@2.9.1
npm pkg get devDependencies.@electron/fuses devDependencies.yaml
```
Expected: `added 2 packages` (or a similar small number); then `{ "devDependencies.@electron/fuses": "2.1.3", "devDependencies.yaml": "2.9.1" }`.

- [ ] **Step 2: Create `scripts/vitest.config.ts`**

```ts
import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'tooling',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
```

- [ ] **Step 3: Create `scripts/tsconfig.json`**

Only this plan's files are listed, so `checkJs` never reaches other scripts (e.g. plan 1b's `run-electron.mjs`). The `.mjs` files carry JSDoc types and are checked like TypeScript.

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "types": ["node"],
    "allowJs": true,
    "checkJs": true
  },
  "include": ["smoke.mjs", "lib/**/*.mjs", "test/**/*.ts", "test/fixtures/**/*.mjs", "vitest.config.ts"]
}
```

- [ ] **Step 4: Register the project in the root `vitest.config.ts`**

Replace the whole file with (plan 1b left `projects: ['packages/shared', 'apps/server', 'apps/desktop']`):

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 'scripts' is the tooling project: smoke runner, packaging and CI policy tests.
    projects: ['packages/shared', 'apps/server', 'apps/desktop', 'scripts'],
  },
});
```

- [ ] **Step 5: Typecheck the scripts from the root `typecheck` script**

Run:
```bash
npm pkg set scripts.typecheck="npm run typecheck --workspaces --if-present && tsc -p scripts/tsconfig.json"
npm pkg get scripts.typecheck
```
Expected: `"npm run typecheck --workspaces --if-present && tsc -p scripts/tsconfig.json"`.

- [ ] **Step 6: Verify the empty project and the typecheck**

Run:
```bash
npx vitest run --project tooling --passWithNoTests
npm run typecheck
```
Expected: Vitest prints `No test files found, exiting with code 0`; `npm run typecheck` runs every workspace's `tsc` and then `tsc -p scripts/tsconfig.json` silently; exit code 0.

- [ ] **Step 7: Commit**

```bash
git add scripts/vitest.config.ts scripts/tsconfig.json vitest.config.ts package.json package-lock.json
git commit -m "$(cat <<'EOF'
test(tooling): add a Vitest project and typecheck for repository scripts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Smoke runner library

**Files:**
- Create: `scripts/lib/smoke.mjs`
- Test: `scripts/test/smoke.test.ts`, `scripts/test/fixtures/fake-app.mjs`

The packaged smoke test (spec §14) must not be fooled. Exit code 0 alone is not proof — a GhostLink that quits early (an old build, a lock taken by another instance) also exits 0 — so the verdict also requires the app's own `smoke: OK` line. A hung app is killed with its whole process tree (Electron starts GPU, renderer and utility helpers). Before launching, two static checks catch what a short run cannot: fuses that were not flipped (spec §12) and Vite's empty stubs for optional dependencies (verified fact 2). The fuse check is tested against byte-level fake binaries, including the macOS layout where the fuse wire lives in `Electron Framework`, not in the launcher.

- [ ] **Step 1: Create the fake app fixture**

`scripts/test/fixtures/fake-app.mjs`:

```js
// Stands in for the packaged app in smoke.test.ts. The first argument picks the behaviour.
// Exit codes are set through process.exitCode so piped output is always flushed.
import process from 'node:process';
import { setTimeout } from 'node:timers';

const [mode, ...rest] = process.argv.slice(2);
switch (mode) {
  case 'pass':
    console.log('[smoke] renderer loaded');
    console.log('smoke: OK (renderer ready, hosted server served TLS on port 50123 and stopped)');
    break;
  case 'exit-without-marker':
    console.log('another instance owns the lock; quitting');
    break;
  case 'crash':
    console.error('boom: the server entry failed to start');
    process.exitCode = 3;
    break;
  case 'marker-then-fail':
    console.log('smoke: OK (renderer ready, hosted server served TLS on port 50123 and stopped)');
    process.exitCode = 1;
    break;
  case 'hang':
    console.log('waiting forever');
    setTimeout(() => {}, 3_600_000);
    break;
  case 'echo-env':
    console.log(JSON.stringify({
      runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
      smoke: process.env.GHOSTLINK_SMOKE ?? null,
      args: rest,
    }));
    console.log('smoke: OK (renderer ready, hosted server served TLS on port 50123 and stopped)');
    break;
  default:
    console.error(`fake-app: unknown mode ${mode}`);
    process.exitCode = 64;
}
```

- [ ] **Step 2: Write the failing test**

`scripts/test/smoke.test.ts`:

```ts
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
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test -- scripts/test/smoke.test.ts`
Expected: FAIL — `Error: Cannot find module '../lib/smoke.mjs' imported from …/scripts/test/smoke.test.ts`.

- [ ] **Step 4: Implement `scripts/lib/smoke.mjs`**

```js
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- scripts/test/smoke.test.ts`
Expected: PASS — `Tests  19 passed (19)` (about 4 s; the timeout test waits 1.5 s).

- [ ] **Step 6: Typecheck and lint the scripts**

Run:
```bash
npx tsc -p scripts/tsconfig.json
npx eslint scripts
```
Expected: no output, exit code 0 for both.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/smoke.mjs scripts/test/smoke.test.ts scripts/test/fixtures/fake-app.mjs
git commit -m "$(cat <<'EOF'
feat(scripts): add the packaged-app smoke runner library

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `npm run smoke` entry point

**Files:**
- Create: `scripts/smoke.mjs`
- Modify: `package.json` (root script `smoke`)

The entry point only wires the tested pieces together: static checks first (cheap, precise error messages), then one launch in a throwaway profile (`--user-data-dir`, verified fact 8). The runner prefixes its own lines with `smoke-runner:` so they never look like the app's `smoke: OK`.

- [ ] **Step 1: Create `scripts/smoke.mjs`**

```js
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
```

- [ ] **Step 2: Add the root script**

Run:
```bash
npm pkg set scripts.smoke="node scripts/smoke.mjs"
npm pkg get scripts.smoke
```
Expected: `"node scripts/smoke.mjs"`.

- [ ] **Step 3: Check the failure path (nothing is packaged yet)**

Run:
```bash
npm run smoke; echo "exit=$?"
```
Expected (Windows): `smoke-runner: FAILED - no packaged app at C:\…\apps\desktop\dist\win-unpacked\GhostLink.exe. Run "npm run dist" first.` and `exit=1`. (macOS names `dist/mac-arm64/GhostLink.app/Contents/MacOS/GhostLink`; Linux prints `GhostLink is packaged for Windows and macOS only; there is no desktop build for "linux".`)

- [ ] **Step 4: Typecheck and lint**

Run:
```bash
npx tsc -p scripts/tsconfig.json
npx eslint scripts
```
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke.mjs package.json
git commit -m "$(cat <<'EOF'
feat(scripts): add npm run smoke for the packaged app

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: App icon

**Files:**
- Create: `apps/desktop/build/icon.svg`
- Test: `scripts/test/icon.test.ts`

Spec §11: an original SVG icon, "a ghost formed by a chain link", in the dark theme with the spectral cyan accent. The ghost's outline is one link and interlocks with a second link (over it at the top crossing, under it at the bottom). electron-builder rasterizes this file into the ICO and ICNS (verified fact 5), so the SVG is the only committed icon file. A self-contained SVG (no text, fonts, images or scripts) renders identically on every build machine.

- [ ] **Step 1: Write the failing test**

`scripts/test/icon.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// electron-builder 26 rasterizes this SVG itself (its checksum-pinned WASM icon tool) into the
// Windows .ico (16–256 px) and the macOS .icns (up to 1024 px): no PNG is committed.
const svg = readFileSync(fileURLToPath(new URL('../../apps/desktop/build/icon.svg', import.meta.url)), 'utf8');

describe('apps/desktop/build/icon.svg', () => {
  it('is a 1024×1024 drawing', () => {
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1024" height="1024" viewBox="0 0 1024 1024">/);
  });

  it('is self-contained, so it renders the same on every build machine', () => {
    // No fonts (text renders differently per machine), no external or embedded images, no scripts.
    expect(svg).not.toMatch(/<(text|image|script|foreignObject|style)\b/);
    const hrefs = [...svg.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(href).toMatch(/^#[\w-]+$/);
    for (const [, id] of [...svg.matchAll(/(?:href="#|url\(#)([\w-]+)/g)]) expect(svg, id).toContain(`id="${id}"`);
  });

  it('uses the spec §11 palette: near-black tile, spectral cyan', () => {
    expect(svg).toContain('stop-color="#161a20"');
    expect(svg).toContain('stop-color="#0b0d10"');
    expect(svg).toContain('stroke="#5eead4"');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- scripts/test/icon.test.ts`
Expected: FAIL — `Error: ENOENT: no such file or directory, open '…\apps\desktop\build\icon.svg'`.

- [ ] **Step 3: Create `apps/desktop/build/icon.svg`**

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <!-- GhostLink app icon (placeholder): a ghost whose outline is a chain link,
       interlocked with a second link. Colors: spec §11 (near-black tile, spectral cyan). -->
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#161a20"/>
      <stop offset="1" stop-color="#0b0d10"/>
    </linearGradient>
    <path id="ghost" d="M232 720V440A200 200 0 0 1 632 440V720A66.67 66.67 0 0 1 498.67 720A66.67 66.67 0 0 1 365.33 720A66.67 66.67 0 0 1 232 720Z"/>
    <rect id="link" x="520" y="520" width="280" height="160" rx="80"/>
    <clipPath id="crossing-top"><rect x="592" y="480" width="80" height="80"/></clipPath>
    <clipPath id="crossing-bottom"><rect x="592" y="640" width="80" height="80"/></clipPath>
  </defs>
  <rect x="64" y="64" width="896" height="896" rx="200" fill="url(#tile)"/>
  <use href="#link" fill="none" stroke="#2dd4bf" stroke-width="56"/>
  <use href="#ghost" fill="none" stroke="#5eead4" stroke-width="56" stroke-linejoin="round"/>
  <!-- The links interlock: the second link passes over the ghost at the top crossing… -->
  <g clip-path="url(#crossing-top)">
    <use href="#link" fill="none" stroke="#101318" stroke-width="104"/>
    <use href="#link" fill="none" stroke="#2dd4bf" stroke-width="56"/>
  </g>
  <!-- …and under it at the bottom crossing. -->
  <g clip-path="url(#crossing-bottom)">
    <use href="#ghost" fill="none" stroke="#0e1115" stroke-width="104" stroke-linejoin="round"/>
    <use href="#ghost" fill="none" stroke="#5eead4" stroke-width="56" stroke-linejoin="round"/>
  </g>
  <ellipse cx="360" cy="460" rx="36" ry="48" fill="#5eead4"/>
  <ellipse cx="504" cy="460" rx="36" ry="48" fill="#5eead4"/>
</svg>
```

The two dark halo strokes (`#101318`, `#0e1115`) match the tile gradient at the heights of the two crossings, so the "gap" that creates the over/under effect is invisible against the background.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- scripts/test/icon.test.ts`
Expected: PASS — `Tests  3 passed (3)`.

- [ ] **Step 5: Look at it**

Open `apps/desktop/build/icon.svg` in a browser (on Windows: `start apps/desktop/build/icon.svg`). Expected: a rounded dark tile; a cyan ghost outline with two oval eyes and a three-scallop hem; a teal horizontal link through the ghost's right side, passing over the ghost's edge at the top crossing and under it at the bottom crossing.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/build/icon.svg scripts/test/icon.test.ts
git commit -m "$(cat <<'EOF'
feat(desktop): add the GhostLink app icon

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: macOS hardened-runtime entitlements

**Files:**
- Create: `apps/desktop/build/entitlements.mac.plist`
- Test: `scripts/test/macEntitlements.test.ts`

Spec §15: ad-hoc signing with the hardened runtime needs `cs.allow-jit` and `cs.allow-unsigned-executable-memory` (V8), `cs.disable-library-validation` (mandatory with ad-hoc: the frameworks carry no Team ID), plus `device.audio-input` and `device.camera`. A custom file **replaces** electron-builder's template, so the three `cs.*` keys must be repeated. Each extra entitlement weakens the runtime (e.g. `get-task-allow` lets any process attach a debugger), so the test pins the exact set.

- [ ] **Step 1: Write the failing test**

`scripts/test/macEntitlements.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const plist = readFileSync(fileURLToPath(new URL('../../apps/desktop/build/entitlements.mac.plist', import.meta.url)), 'utf8');

describe('apps/desktop/build/entitlements.mac.plist', () => {
  it('is a single plist dictionary', () => {
    expect(plist).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>\r?\n<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN" "http:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd">/);
    expect(plist.match(/<plist version="1\.0">/g)).toHaveLength(1);
    expect(plist.match(/<dict>/g)).toHaveLength(1);
  });

  it('grants exactly the five spec §15 entitlements, all true', () => {
    // The file replaces electron-builder's template, so the three cs.* keys must be repeated here.
    const entries = [...plist.matchAll(/<key>([^<]+)<\/key>\s*<(true|false)\/>/g)].map((m) => [m[1], m[2]]);
    expect(entries).toEqual([
      ['com.apple.security.cs.allow-jit', 'true'],
      ['com.apple.security.cs.allow-unsigned-executable-memory', 'true'],
      ['com.apple.security.cs.disable-library-validation', 'true'],
      ['com.apple.security.device.audio-input', 'true'],
      ['com.apple.security.device.camera', 'true'],
    ]);
  });

  it('grants nothing else (no debugger attach, no DYLD injection, no sandbox exceptions)', () => {
    expect(plist.match(/<key>/g)).toHaveLength(5);
    expect(plist).not.toMatch(/get-task-allow|allow-dyld-environment-variables|disable-executable-page-protection/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- scripts/test/macEntitlements.test.ts`
Expected: FAIL — `Error: ENOENT: no such file or directory, open '…\apps\desktop\build\entitlements.mac.plist'`.

- [ ] **Step 3: Create `apps/desktop/build/entitlements.mac.plist`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <!-- Replaces electron-builder's default template (spec §15), so it repeats its cs.* keys. -->
    <!-- V8 JIT under the hardened runtime. -->
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <!-- Required with ad-hoc signing: the helpers and frameworks carry no Team ID. -->
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
    <!-- Voice and camera (NSMicrophoneUsageDescription / NSCameraUsageDescription in Info.plist). -->
    <key>com.apple.security.device.audio-input</key>
    <true/>
    <key>com.apple.security.device.camera</key>
    <true/>
  </dict>
</plist>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- scripts/test/macEntitlements.test.ts`
Expected: PASS — `Tests  3 passed (3)`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/build/entitlements.mac.plist scripts/test/macEntitlements.test.ts
git commit -m "$(cat <<'EOF'
build(desktop): add macOS hardened-runtime entitlements

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: NSIS uninstall hook

**Files:**
- Create: `apps/desktop/build/installer.nsh`
- Test: `scripts/test/nsisInclude.test.ts`

Spec §12: the app registers `ghostlink://` under `HKCU\Software\Classes\ghostlink` at run time, and the uninstaller must remove that key. electron-builder runs the **old** uninstaller with `--updated` during an update; deleting the key then would break deep links until the new version starts once, so the deletion is guarded by `${isUpdated}` (defined by electron-builder's generated NSIS header — verified fact 6). The file must never delete user data: `identity.bin` lives in `%APPDATA%\GhostLink`.

- [ ] **Step 1: Write the failing test**

`scripts/test/nsisInclude.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CRYPTO_LABELS } from '@ghostlink/shared';
import { describe, expect, it } from 'vitest';

const nsh = readFileSync(fileURLToPath(new URL('../../apps/desktop/build/installer.nsh', import.meta.url)), 'utf8');
const statements = nsh.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith(';'));

describe('apps/desktop/build/installer.nsh', () => {
  it('defines only the customUnInstall hook', () => {
    expect(statements.filter((l) => l.startsWith('!macro '))).toEqual(['!macro customUnInstall']);
    expect(statements.at(-1)).toBe('!macroend');
  });

  it('deletes the per-user ghostlink:// handler, except when an update runs the old uninstaller', () => {
    // electron-builder runs the previous uninstaller with --updated during an update; deleting the
    // key then would break deep links until the new version starts and registers it again.
    expect(statements).toEqual([
      '!macro customUnInstall',
      '${ifNot} ${isUpdated}',
      `DeleteRegKey HKCU "Software\\Classes\\${CRYPTO_LABELS.scheme}"`,
      '${endIf}',
      '!macroend',
    ]);
  });

  it('never touches machine-wide keys or user data (identity.bin lives in %APPDATA%)', () => {
    expect(nsh).not.toMatch(/HKLM|HKEY_LOCAL_MACHINE|\$APPDATA|\$LOCALAPPDATA|RMDir|Delete\s/i);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- scripts/test/nsisInclude.test.ts`
Expected: FAIL — `Error: ENOENT: no such file or directory, open '…\apps\desktop\build\installer.nsh'`.

- [ ] **Step 3: Create `apps/desktop/build/installer.nsh`**

```nsis
; Included by electron-builder's NSIS script (nsis.include, spec §12).
; The app registers ghostlink:// under HKCU at run time (app.setAsDefaultProtocolClient),
; so the uninstaller removes that key. An update runs the old uninstaller with --updated:
; keep the key then, or deep links break until the new version starts once.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Classes\ghostlink"
  ${endIf}
!macroend
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- scripts/test/nsisInclude.test.ts`
Expected: PASS — `Tests  3 passed (3)`. (The script compiles for real in Task 10.)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/build/installer.nsh scripts/test/nsisInclude.test.ts
git commit -m "$(cat <<'EOF'
build(desktop): remove the ghostlink:// handler on uninstall

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: electron-builder configuration and the desktop packaging fields

**Files:**
- Create: `apps/desktop/electron-builder.yml`
- Modify: `apps/desktop/package.json` (`author`, `scripts.dist`, `devDependencies`, `dependencies`), `package.json` (root `scripts.dist`), `package-lock.json`
- Test: `scripts/test/electronBuilderConfig.test.ts`

Contract §6 and spec §12/§15, with three packaging fixes verified on this machine: `extraMetadata` freezes the userData and install folder names (fact 3), `author` replaces Electron's "GitHub, Inc." (fact 4), and the six packages electron-vite bundles anyway move to `devDependencies`, so `app.asar` holds only what the bundles load at run time (fact 1; plan 1b's contract note 13). The test pins that exact runtime set — `ws` must stay in it (fact 2) and the build toolchain must never enter it — and every security-relevant value: `mac.minimumSystemVersion` must be the *string* `"13.0"` (unquoted YAML `13.0` is the number 13), `mac.identity` must be `"-"` (null skips signing and the fuse-patched binary stops launching), `deleteAppDataOnUninstall` must be false (identity).

- [ ] **Step 1: Write the failing test**

`scripts/test/electronBuilderConfig.test.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_ID, APP_NAME } from '@ghostlink/shared';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const desktop = fileURLToPath(new URL('../../apps/desktop/', import.meta.url));
const read = (file: string) => readFileSync(join(desktop, file), 'utf8');

type Dict = Record<string, unknown>;
const config = parse(read('electron-builder.yml')) as Dict & {
  extraMetadata: Dict;
  electronFuses: Dict;
  win: Dict;
  nsis: Dict;
  mac: Dict & { extendInfo: Dict };
  dmg: Dict;
};
const pkg = JSON.parse(read('package.json')) as {
  main: string;
  author?: string;
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe('apps/desktop/electron-builder.yml', () => {
  it('uses the frozen app identity (spec §3.6)', () => {
    expect(config.appId).toBe(APP_ID);
    expect(config.productName).toBe(APP_NAME);
    // Packaged package.json: productName names the userData folder, name the install folder.
    // Without this they would derive from "@ghostlink/desktop".
    expect(config.extraMetadata).toEqual({ name: 'ghostlink', productName: APP_NAME });
  });

  it('packages only the build output, in an integrity-checked asar, without rebuilding or publishing', () => {
    expect(config.directories).toEqual({ output: 'dist', buildResources: 'build' });
    expect(config.files).toEqual(['out/**', 'package.json']);
    expect(pkg.main.replace(/^\.\//, '')).toMatch(/^out\//);
    expect(config.asar).toBe(true);
    expect(config.npmRebuild).toBe(false); // spec §15: @electron/rebuild would try MSVC
    expect(config.publish).toBeNull();
    expect(pkg.scripts.dist).toBe('npm run build && electron-builder --config electron-builder.yml --publish never');
  });

  it('flips exactly the spec §12 fuses', () => {
    expect(config.electronFuses).toEqual({
      runAsNode: false,
      enableNodeCliInspectArguments: false,
      enableNodeOptionsEnvironmentVariable: false,
      onlyLoadAppFromAsar: true,
      enableEmbeddedAsarIntegrityValidation: true,
      grantFileProtocolExtraPrivileges: false,
    });
  });

  it('builds a per-user one-click NSIS installer that keeps user data on uninstall', () => {
    expect(config.win).toEqual({ target: [{ target: 'nsis', arch: ['x64'] }] });
    expect(config.nsis).toEqual({
      oneClick: true,
      perMachine: false,
      deleteAppDataOnUninstall: false, // identity.bin lives in userData (spec §3.1)
      artifactName: '${productName}-Setup-${version}.${ext}',
      include: 'build/installer.nsh',
    });
  });

  it('builds ad-hoc signed, hardened DMGs for both Mac architectures, without zip', () => {
    expect(config.mac.target).toEqual([{ target: 'dmg', arch: ['arm64', 'x64'] }]);
    expect(config.mac.identity).toBe('-'); // null would skip signing and the fused binary would not launch
    expect(config.mac.hardenedRuntime).toBe(true);
    expect(config.mac.entitlements).toBe('build/entitlements.mac.plist');
    expect(config.mac.entitlementsInherit).toBe('build/entitlements.mac.plist');
    expect(config.mac.minimumSystemVersion).toBe('13.0'); // a string: unquoted YAML 13.0 is the number 13
    expect(config.dmg).toEqual({ artifactName: '${productName}-${version}-mac-${arch}.${ext}' });
  });

  it('explains why GhostLink asks for the microphone and the camera', () => {
    expect(config.mac.extendInfo).toEqual({
      NSMicrophoneUsageDescription: 'GhostLink uses the microphone for voice chat.',
      NSCameraUsageDescription: 'GhostLink uses the camera for video calls.',
    });
  });

  it('references build resources that exist', () => {
    for (const file of [config.icon, config.nsis.include, config.mac.entitlements]) {
      expect(typeof file).toBe('string');
      expect(existsSync(join(desktop, file as string)), String(file)).toBe(true);
    }
  });
});

describe('apps/desktop/package.json (packaging)', () => {
  // electron-vite leaves every "dependencies" entry external, and electron-builder copies each
  // one (with its own dependencies) into app.asar; devDependencies never reach the package.
  // These are exactly the packages the main-process bundles import at run time (plan 1b's
  // build.test.ts checks that ws and zod stay external and that reflect-metadata loads before x509).
  // Add one only for a package that must stay external (a native module, electron-updater…).
  const RUNTIME_DEPENDENCIES = ['@peculiar/x509', 'reflect-metadata', 'ws', 'zod'];

  it('ships only the packages the bundles load at run time', () => {
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(RUNTIME_DEPENDENCIES);
  });

  it('keeps ws a runtime dependency, so electron-vite never bundles it', () => {
    // Bundled, ws's optional `bufferutil` probe becomes an empty stub and every WebSocket frame
    // of 32+ bytes throws "bufferUtil.mask is not a function".
    expect(pkg.dependencies).toMatchObject({ ws: '8.22.0' });
  });

  it('bundles the workspace packages and the renderer libraries instead of shipping them', () => {
    // The workspace packages export TypeScript source; React, zustand and the font are in the renderer bundle.
    for (const name of ['@ghostlink/server', '@ghostlink/shared', 'react', 'react-dom', 'zustand', '@fontsource/inter']) {
      expect(pkg.devDependencies?.[name], name).toBeDefined();
    }
  });

  it('keeps the build toolchain out of the packaged app', () => {
    for (const tool of ['electron', 'electron-builder', 'electron-vite']) expect(pkg.dependencies?.[tool], tool).toBeUndefined();
    expect(pkg.devDependencies).toMatchObject({ electron: '44.4.5', 'electron-builder': '26.15.3', 'electron-vite': '5.0.0' });
  });

  it('names an author, which becomes the Windows CompanyName instead of Electron\'s "GitHub, Inc."', () => {
    expect(pkg.author).toBe('GhostLink contributors');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- scripts/test/electronBuilderConfig.test.ts`
Expected: FAIL — `Error: ENOENT: no such file or directory, open '…\apps\desktop\electron-builder.yml'`.

- [ ] **Step 3: Install electron-builder and make sure `ws` is a runtime dependency**

Both commands are idempotent (`ws` is already listed by plan 1b).

Run:
```bash
npm install --save-dev --save-exact -w @ghostlink/desktop --fetch-retries=6 --fetch-retry-mintimeout=5000 --no-audit --no-fund electron-builder@26.15.3
npm install --save --save-exact -w @ghostlink/desktop --fetch-retries=6 --fetch-retry-mintimeout=5000 --no-audit --no-fund ws@8.22.0
npx electron-builder --version
```
Expected: `added … packages`, then `up to date` (or `changed 1 package`), then `26.15.3`.

- [ ] **Step 4: Create `apps/desktop/electron-builder.yml`**

```yaml
# electron-builder 26.15.3 configuration (spec §12 and §15, contract §6).
# Validated against app-builder-lib/scheme.json; scripts/test/electronBuilderConfig.test.ts pins the security-relevant values.
appId: app.ghostlink.desktop
productName: GhostLink
copyright: Copyright © 2026 GhostLink contributors
# Written into the packaged package.json. Frozen since 0.1.0 (spec §3.6):
#   productName -> userData folder (%APPDATA%\GhostLink, ~/Library/Application Support/GhostLink),
#   name        -> per-user install folder (%LOCALAPPDATA%\Programs\ghostlink).
# The workspace name "@ghostlink/desktop" would otherwise leak into both.
extraMetadata:
  name: ghostlink
  productName: GhostLink
directories:
  output: dist
  buildResources: build
icon: build/icon.svg
files:
  - out/**
  - package.json
asar: true
# Mandatory: @electron/rebuild would try to compile native modules with MSVC (spec §15).
npmRebuild: false
publish: null
electronFuses:
  runAsNode: false
  enableNodeCliInspectArguments: false
  enableNodeOptionsEnvironmentVariable: false
  onlyLoadAppFromAsar: true
  enableEmbeddedAsarIntegrityValidation: true
  grantFileProtocolExtraPrivileges: false
win:
  target:
    - target: nsis
      arch: [x64]
nsis:
  oneClick: true
  perMachine: false
  # userData holds identity.bin; uninstalling must never delete it (spec §3.1).
  deleteAppDataOnUninstall: false
  artifactName: ${productName}-Setup-${version}.${ext}
  include: build/installer.nsh
mac:
  target:
    - target: dmg
      arch: [arm64, x64]
  category: public.app-category.social-networking
  # Ad-hoc signature. Never null: that skips signing and the fuse-patched binary stops launching.
  identity: "-"
  hardenedRuntime: true
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
  minimumSystemVersion: "13.0"
  extendInfo:
    NSMicrophoneUsageDescription: GhostLink uses the microphone for voice chat.
    NSCameraUsageDescription: GhostLink uses the camera for video calls.
dmg:
  artifactName: ${productName}-${version}-mac-${arch}.${ext}
```

- [ ] **Step 5: Set the author and the `dist` script of the desktop package**

`dist` is the contract §6 command, run inside `apps/desktop` (`npm run build` there is `npm run build -w @ghostlink/desktop`). electron-builder builds for the host OS: NSIS x64 on Windows, both DMGs on macOS.

Run:
```bash
npm pkg set -w @ghostlink/desktop author="GhostLink contributors" scripts.dist="npm run build && electron-builder --config electron-builder.yml --publish never"
npm pkg get -w @ghostlink/desktop author scripts.dist
```
Expected:
```
{
  "@ghostlink/desktop": {
    "author": "GhostLink contributors",
    "scripts.dist": "npm run build && electron-builder --config electron-builder.yml --publish never"
  }
}
```

- [ ] **Step 6: Move the bundled-only packages to `devDependencies`**

electron-vite bundles `@ghostlink/server` and `@ghostlink/shared` (TypeScript source, excluded from externalization by plan 1b) and the renderer libraries `react`, `react-dom`, `zustand` and `@fontsource/inter`; as `dependencies` they would also be copied into `app.asar`. The four packages the main-process bundles import at run time stay: `ws`, `zod`, `@peculiar/x509`, `reflect-metadata`. The script keeps the exact versions, fails loudly if plan 1b's list changed, and sorts `devDependencies`; `npm install` then refreshes the `dev` flags in `package-lock.json`.

Run:
```bash
node --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs';
const file = 'apps/desktop/package.json';
const pkg = JSON.parse(readFileSync(file, 'utf8'));
const bundled = ['@fontsource/inter', '@ghostlink/server', '@ghostlink/shared', 'react', 'react-dom', 'zustand'];
for (const name of bundled) {
  if (!(name in pkg.dependencies)) throw new Error(name + ' is not a runtime dependency');
  pkg.devDependencies[name] = pkg.dependencies[name];
  delete pkg.dependencies[name];
}
pkg.devDependencies = Object.fromEntries(Object.entries(pkg.devDependencies).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
console.log('runtime dependencies:', Object.keys(pkg.dependencies).join(', '));
"
npm install --fetch-retries=6 --fetch-retry-mintimeout=5000 --no-audit --no-fund
node -e "const d=require('./package-lock.json').packages['apps/desktop'];console.log(Object.keys(d.dependencies).join(' '))"
```
Expected: `runtime dependencies: @peculiar/x509, reflect-metadata, ws, zod`; `npm install` prints `up to date` (nothing is downloaded); the lockfile line prints `@peculiar/x509 reflect-metadata ws zod`.

- [ ] **Step 7: Add the root `dist` script**

Run:
```bash
npm pkg set scripts.dist="npm run dist -w @ghostlink/desktop"
npm pkg get scripts.dist
```
Expected: `"npm run dist -w @ghostlink/desktop"`.

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm test -- scripts/test/electronBuilderConfig.test.ts`
Expected: PASS — `Tests  12 passed (12)`.

- [ ] **Step 9: Check the desktop build and the whole suite**

Run:
```bash
npm run build -w @ghostlink/desktop
grep -c 'from "ws"' apps/desktop/out/main/serverEntry.js
npm run typecheck
npm test
```
Expected: the electron-vite build ends with three `✓ built in …` lines; `grep` prints `1` (ws stays an import, it is not bundled); typecheck exits 0; Vitest prints `Test Files  58 passed (58)` and `Tests  724 passed | 6 skipped (730)` on Windows — plan 1b's 53 files / 690 tests (its `test/build.test.ts` included) plus the 5 tooling files / 40 tests so far.

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/electron-builder.yml apps/desktop/package.json package.json package-lock.json scripts/test/electronBuilderConfig.test.ts
git commit -m "$(cat <<'EOF'
build(desktop): package with electron-builder (NSIS, ad-hoc DMG, fuses)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`
- Test: `scripts/test/ciWorkflow.test.ts`

Contract §6 and spec §15. Choices the test pins, and why:
- **Supply chain:** every action pinned to a full commit SHA with its version in a comment, from an allowlist of three reviewed actions (SHAs looked up on 2026-09-28: `actions/checkout` v7.0.1 → `3d3c42e5…`, `actions/setup-node` v7.0.0 → `82076278…`, `actions/upload-artifact` v7.0.1 → `043fb46d…`; all three tags point directly at commits).
- **Least privilege:** `permissions: { contents: read }` for the whole workflow and no job-level override; `persist-credentials: false` so the token is not left in `.git/config` while untrusted PR code (npm scripts) runs; no `pull_request_target`/`workflow_run`; no secrets at all.
- **Triggers:** push to `main`, every pull request, manual runs. `concurrency` cancels superseded runs of the same ref.
- **Robustness:** `npm ci` retried 3 times (flaky networks), npm's own fetch retries via `npm_config_*`; `fail-fast: false` so one OS failing does not hide the others; every job has a timeout.
- **Packaging:** `npm run dist` then `npm run smoke`. On macOS a temporary, unlocked default keychain is created **before** the smoke test (spec §14): `safeStorage` and Chromium's cookie encryption use the default keychain, and a locked-keychain prompt would hang the app until the timeout. Installers are uploaded for 7 days even when the smoke test fails (to debug them), but not when `dist` failed.
- `test` and `package` run in parallel (packaging problems are independent of test failures).

- [ ] **Step 1: Write the failing test**

`scripts/test/ciWorkflow.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface Job {
  'runs-on': string;
  'timeout-minutes'?: number;
  permissions?: unknown;
  strategy: { 'fail-fast': boolean; matrix: { os: string[] } };
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  permissions: unknown;
  concurrency: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, Job>;
}

const source = readFileSync(fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)), 'utf8');
const workflow = parse(source) as Workflow;
const jobs = Object.entries(workflow.jobs);
const steps = jobs.flatMap(([, job]) => job.steps);
const runIndex = (job: Job, command: string) => job.steps.findIndex((s) => s.run?.split('\n').some((l) => l.trim() === command));

// Reviewed actions only. Updating one = new SHA + version comment, checked by the tests below.
const ALLOWED_ACTIONS = ['actions/checkout', 'actions/setup-node', 'actions/upload-artifact'];

describe('ci.yml supply chain', () => {
  it('pins every action to a full commit SHA with its version as a comment', () => {
    const uses = [...source.matchAll(/^\s*(?:-\s+)?uses:\s*(.+)$/gm)].map((m) => m[1]!.trim());
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) expect(line, line).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  });

  it('uses only reviewed actions', () => {
    for (const step of steps.filter((s) => s.uses !== undefined)) {
      expect(ALLOWED_ACTIONS, step.uses).toContain(step.uses!.split('@')[0]);
    }
  });

  it('runs with a read-only token that is not left in .git/config', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    for (const [name, job] of jobs) expect(job.permissions, name).toBeUndefined();
    for (const step of steps.filter((s) => s.uses?.startsWith('actions/checkout@'))) {
      expect(step.with?.['persist-credentials']).toBe(false);
    }
  });

  it('never runs untrusted code with repository secrets', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch']);
    expect(source).not.toMatch(/pull_request_target|workflow_run|secrets\./);
  });
});

describe('ci.yml jobs', () => {
  it('cancels superseded runs of the same ref', () => {
    expect(workflow.concurrency).toEqual({ group: 'ci-${{ github.ref }}', 'cancel-in-progress': true });
  });

  it('bounds every job in time and lets every OS finish', () => {
    for (const [name, job] of jobs) {
      expect(job['timeout-minutes'], name).toBeGreaterThan(0);
      expect(job.strategy['fail-fast'], name).toBe(false);
    }
  });

  it('installs Node 24 with the npm cache in every job', () => {
    for (const [name, job] of jobs) {
      const setup = job.steps.find((s) => s.uses?.startsWith('actions/setup-node@'));
      expect(setup?.with, name).toEqual({ 'node-version': '24.x', cache: 'npm' });
      expect(job.steps.find((s) => s.name === 'Install dependencies')?.run, name).toMatch(/for attempt in 1 2 3; do\s+npm ci && exit 0/);
    }
  });

  it('tests on Windows, Linux and macOS: lint, typecheck, then tests', () => {
    const test = workflow.jobs.test!;
    expect(test.strategy.matrix.os).toEqual(['windows-latest', 'ubuntu-latest', 'macos-latest']);
    const order = ['npm run lint', 'npm run typecheck', 'npm test'].map((c) => runIndex(test, c));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('packages on Windows and macOS, then smoke tests the package', () => {
    const pack = workflow.jobs.package!;
    expect(pack.strategy.matrix.os).toEqual(['windows-latest', 'macos-latest']);
    const dist = runIndex(pack, 'npm run dist');
    const smoke = runIndex(pack, 'npm run smoke');
    expect(dist).toBeGreaterThan(0);
    expect(smoke).toBeGreaterThan(dist);
    expect(pack.steps[dist]!.id).toBe('dist');
  });

  it('unlocks a temporary keychain before the macOS smoke test (spec §14)', () => {
    const pack = workflow.jobs.package!;
    const index = pack.steps.findIndex((s) => s.run?.includes('security create-keychain'));
    expect(index).toBeGreaterThan(0);
    expect(index).toBeLessThan(runIndex(pack, 'npm run smoke'));
    const step = pack.steps[index]!;
    expect(step.if).toBe("runner.os == 'macOS'");
    for (const command of ['create-keychain', 'set-keychain-settings', 'unlock-keychain', 'list-keychains -d user -s', 'default-keychain -d user -s']) {
      expect(step.run).toContain(`security ${command}`);
    }
    expect(step.run).toContain('::add-mask::');
  });

  it('keeps the installers for 7 days, even when the smoke test fails', () => {
    const upload = workflow.jobs.package!.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'))!;
    expect(upload.if).toBe("${{ !cancelled() && steps.dist.outcome == 'success' }}");
    expect(upload.with).toMatchObject({ 'if-no-files-found': 'error', 'retention-days': 7 });
    expect(String(upload.with?.path).trim().split('\n')).toEqual([
      'apps/desktop/dist/GhostLink-Setup-*.exe',
      'apps/desktop/dist/GhostLink-*-mac-*.dmg',
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- scripts/test/ciWorkflow.test.ts`
Expected: FAIL — `Error: ENOENT: no such file or directory, open '…\.github\workflows\ci.yml'`.

- [ ] **Step 3: Create `.github/workflows/ci.yml`**

```yaml
# Continuous integration (spec §15 "CI", contract §6).
# - test:    lint, typecheck, unit + integration tests on Windows, Linux and macOS.
# - package: NSIS installer / ad-hoc signed DMGs with fuses, then the packaged smoke test.
# Actions are pinned by commit SHA; scripts/test/ciWorkflow.test.ts enforces the policies below.
name: CI

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

defaults:
  run:
    shell: bash

env:
  # Flaky networks: npm retries each request before failing the whole install.
  npm_config_fetch_retries: '6'
  npm_config_fetch_retry_mintimeout: '5000'
  npm_config_audit: 'false'
  npm_config_fund: 'false'

jobs:
  test:
    name: Test (${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    timeout-minutes: 30
    strategy:
      fail-fast: false
      matrix:
        os: [windows-latest, ubuntu-latest, macos-latest]
    steps:
      - name: Check out
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Set up Node.js 24
        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 24.x
          cache: npm
      - name: Install dependencies
        run: |
          for attempt in 1 2 3; do
            npm ci && exit 0
            echo "::warning::npm ci failed (attempt ${attempt} of 3), retrying in 20 s"
            sleep 20
          done
          exit 1
      - name: Lint
        run: npm run lint
      - name: Typecheck
        run: npm run typecheck
      - name: Unit and integration tests
        run: npm test

  package:
    name: Package and smoke test (${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    timeout-minutes: 45
    strategy:
      fail-fast: false
      matrix:
        os: [windows-latest, macos-latest]
    steps:
      - name: Check out
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Set up Node.js 24
        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 24.x
          cache: npm
      - name: Install dependencies
        run: |
          for attempt in 1 2 3; do
            npm ci && exit 0
            echo "::warning::npm ci failed (attempt ${attempt} of 3), retrying in 20 s"
            sleep 20
          done
          exit 1
      - name: Build installers
        id: dist
        run: npm run dist
      # safeStorage and Chromium's cookie encryption use the default keychain. On a runner it
      # may be locked, and a keychain prompt would hang the smoke test until the timeout.
      - name: Create a temporary unlocked keychain
        if: runner.os == 'macOS'
        run: |
          keychain="$RUNNER_TEMP/ghostlink-ci.keychain-db"
          password="$(openssl rand -hex 24)"
          echo "::add-mask::$password"
          security create-keychain -p "$password" "$keychain"
          security set-keychain-settings -lut 21600 "$keychain"
          security unlock-keychain -p "$password" "$keychain"
          security list-keychains -d user -s "$keychain" $(security list-keychains -d user | xargs)
          security default-keychain -d user -s "$keychain"
      - name: Smoke test the packaged app
        run: npm run smoke
      - name: Upload installers
        if: ${{ !cancelled() && steps.dist.outcome == 'success' }}
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: ghostlink-${{ runner.os }}-${{ github.sha }}
          path: |
            apps/desktop/dist/GhostLink-Setup-*.exe
            apps/desktop/dist/GhostLink-*-mac-*.dmg
          if-no-files-found: error
          retention-days: 7
```

Notes: `npm ci && exit 0` is safe under the runner's `bash -e` (a failing command before `&&` does not trigger `errexit`). `security list-keychains -s` replaces the user search list, so the existing keychains (`xargs` strips the quotes `security` prints) are appended after the temporary one. On Windows the `*.dmg` pattern and on macOS the `*.exe` pattern match nothing; `if-no-files-found` applies to the union.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- scripts/test/ciWorkflow.test.ts`
Expected: PASS — `Tests  11 passed (11)`.

- [ ] **Step 5: Lint the workflow with actionlint (one-off local check, Windows)**

actionlint 1.7.12 catches expression, context and schema mistakes GitHub would only report after a push. The checksum is the one published in `actionlint_1.7.12_checksums.txt`.

Run:
```bash
tmp="$(mktemp -d)"
curl -fsSL --retry 5 --retry-delay 3 -o "$tmp/actionlint.zip" https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_windows_amd64.zip
echo "6e7241b51e6817ea6a047693d8e6fed13b31819c9a0dd6c5a726e1592d22f6e9  $tmp/actionlint.zip" | sha256sum -c -
unzip -q -o "$tmp/actionlint.zip" -d "$tmp"
"$tmp/actionlint.exe" -color=false .github/workflows/ci.yml; echo "actionlint exit=$?"
rm -rf "$tmp"
```
Expected: `…/actionlint.zip: OK`, no findings, `actionlint exit=0`. (On macOS use `actionlint_1.7.12_darwin_arm64.tar.gz`, SHA-256 `aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f`, and `tar -xzf`; on Linux `actionlint_1.7.12_linux_amd64.tar.gz`, `8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8`.)

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml scripts/test/ciWorkflow.test.ts
git commit -m "$(cat <<'EOF'
ci: add lint, typecheck, test and package + smoke workflow

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: README (pt-BR)

**Files:**
- Modify: `README.md`

Documentation only (spec §2.1: README in pt-BR). The new section keeps every command and note plan 1b wrote there (`build`, `dev`, `smoke:dev`, the Electron download and `ELECTRON_RUN_AS_NODE` notes) and adds packaging and CI.

- [ ] **Step 1: Replace the development section**

In `README.md`, replace everything from the line `## Desenvolvimento` up to (not including) the line `## Licença` with:

````markdown
## Desenvolvimento

Requisitos: Node.js 24.14 ou mais novo. O app desktop roda e é empacotado no Windows e no macOS; o servidor e os testes também rodam no Linux.

```bash
npm install          # instala todos os workspaces
npm test             # testes de unidade e integração (Vitest)
npm run lint         # ESLint
npm run typecheck    # TypeScript em todos os pacotes e em scripts/
npm run build        # typecheck + servidor (apps/server/dist/cli.js) + app (apps/desktop/out)
npm run dev          # abre o app em modo de desenvolvimento (electron-vite)
npm run smoke:dev    # abre o app compilado com GHOSTLINK_SMOKE=1 e confere que ele sobe e fecha sozinho
```

Rodar o servidor local: `npm run dev -w @ghostlink/server -- start --data .data --port 7700`.

O binário do Electron é baixado na primeira vez que é usado (ou com `node node_modules/electron/install.js`). No terminal do VS Code, a variável `ELECTRON_RUN_AS_NODE=1` faz o Electron virar Node puro; por isso todo comando que abre o app passa por `scripts/run-electron.mjs` (ou, no app empacotado, pelo `npm run smoke`), que remove essa variável. O app empacotado ignora a variável de qualquer jeito (fuse `runAsNode` desligado).

Estrutura: `packages/shared` (protocolo e regras comuns), `apps/server` (servidor + CLI `ghostlink-server`), `apps/desktop` (app Electron: `src/main`, `src/preload`, `src/renderer`) e `scripts/` (ferramentas do repositório: smoke test do pacote e testes das regras de CI e empacotamento). O design completo está em `docs/superpowers/specs/`.

### Empacotar

```bash
npm run dist         # instalador do sistema atual em apps/desktop/dist
npm run smoke        # abre o app empacotado em modo smoke e confere que ele sai com código 0
```

- **Windows:** `apps/desktop/dist/GhostLink-Setup-<versão>.exe` (NSIS; instala só para o usuário atual, sem pedir administrador, em `%LOCALAPPDATA%\Programs\ghostlink`). A pasta `apps/desktop/dist/win-unpacked/` tem o mesmo app, pronto para rodar sem instalar.
- **macOS:** `apps/desktop/dist/GhostLink-<versão>-mac-arm64.dmg` e `GhostLink-<versão>-mac-x64.dmg`, com assinatura ad-hoc.
- O `npm run smoke` confere os fuses do Electron (spec §12), procura no `app.asar` dependências opcionais trocadas por stubs e abre o app com `GHOSTLINK_SMOKE=1` num perfil temporário. O app precisa carregar a janela, iniciar e parar o servidor embutido e sair com código 0 em até 60 s.
- Os instaladores **não são assinados** (a assinatura paga fica fora do MVP). Um instalador baixado da internet faz o SmartScreen avisar ("Mais informações" → "Executar assim mesmo"); no macOS 15 ou mais novo, libere em Ajustes do Sistema > Privacidade e Segurança. Nada disso afeta o `npm run smoke`, que roda o app gerado na própria máquina.
- O `app.asar` é protegido por checagem de integridade: qualquer alteração depois do empacotamento faz o app recusar abrir ("ASAR Integrity Violation").

## Integração contínua

O `.github/workflows/ci.yml` roda em todo push na `main`, em pull requests e sob demanda:

- **test:** lint, typecheck e testes no Windows, Linux e macOS (Node 24);
- **package:** `npm run dist` e `npm run smoke` no Windows e no macOS (no macOS, com um keychain temporário). Os instaladores ficam como artefatos da execução por 7 dias.

As actions são fixadas por SHA de commit e o token só tem leitura; `scripts/test/ciWorkflow.test.ts` confere essas regras.

````

- [ ] **Step 2: Check the rendered structure**

Run: `grep -n "^#" README.md`
Expected:
```
1:# GhostLink
7:## Desenvolvimento
27:### Empacotar
40:## Integração contínua
49:## Licença
```
(Verified against both the plan-1a and the plan-1b README. If the introduction above `## Desenvolvimento` changed, the numbers shift; the order must be exactly this.)

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs: document dev, packaging and CI commands (pt-BR)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Package and smoke test locally (Windows)

**Files:** none (fix-ups only if a check fails; commit them with a `fix(…)` message).

This is the real end-to-end proof on the dev machine; CI repeats Steps 1–2 on Windows and macOS. All commands run from the repository root in Git Bash; closing any running GhostLink first avoids locked files.

- [ ] **Step 1: Build the installer from a clean state**

Run:
```bash
rm -rf apps/desktop/dist apps/desktop/out
npm run dist
ls apps/desktop/dist
```
Expected (40–90 s), among other lines (`packageManager not detected by file…`, `searching for node modules…`, more `signing with signtool.exe…`, and `downloaded … progress=100%` on a first run):
```
> ghostlink@0.1.0 dist
> npm run dist -w @ghostlink/desktop
> @ghostlink/desktop@0.1.0 dist
> npm run build && electron-builder --config electron-builder.yml --publish never
… electron-vite: three "✓ built in …" lines …
  • electron-builder  version=26.15.3 os=10.0.26200
  • loaded configuration  file=…\apps\desktop\electron-builder.yml
  • skipped dependencies rebuild  reason=npmRebuild is set to false
  • packaging       platform=win32 arch=x64 electron=44.4.5 appOutDir=dist\win-unpacked
  • using manual traversal of node_modules to build dependency tree
  • updating asar integrity executable resource  executablePath=dist\win-unpacked\GhostLink.exe
  • executing @electron/fuses  electronPath=dist\win-unpacked\GhostLink.exe
  • signing with signtool.exe  path=dist\win-unpacked\GhostLink.exe
  • building        target=nsis file=dist\GhostLink-Setup-0.1.0.exe archs=x64 oneClick=true perMachine=false
  • building block map  blockMapFile=dist\GhostLink-Setup-0.1.0.exe.blockmap
```
and the listing `GhostLink-Setup-0.1.0.exe  GhostLink-Setup-0.1.0.exe.blockmap  builder-debug.yml  win-unpacked`. There must be **no** `author is missed`, `default Electron icon is used` or `⨯` line. The `signing with signtool.exe` lines are harmless: without a certificate nothing is signed (`Get-AuthenticodeSignature` reports `NotSigned`).

- [ ] **Step 2: Run the smoke test (with the VS Code variable set on purpose)**

Run:
```bash
ELECTRON_RUN_AS_NODE=1 npm run smoke; echo "exit=$?"
```
Expected:
```
smoke-runner: packaged app C:\…\apps\desktop\dist\win-unpacked\GhostLink.exe
smoke-runner: fuses match spec §12
smoke-runner: app.asar has no stubbed optional dependencies
smoke-runner: launching with GHOSTLINK_SMOKE=1 (timeout 60 s)

smoke: OK (renderer ready, hosted server served TLS on port 5xxxx and stopped)

smoke-runner: PASSED - the app exited with code 0 after 0.8 s
exit=0
```
Everything between the `launching` line and the verdict is the app's own output (plan 1b's `smoke.ts` prints one line; any extra log lines are fine). The duration is usually 1–5 s; a first run right after a Windows Defender scan can take longer. Afterwards `ls "$APPDATA" | grep -i ghostlink` prints nothing: the run used a temporary profile.

- [ ] **Step 3: Inspect the package**

Run:
```bash
npx electron-fuses read --app apps/desktop/dist/win-unpacked/GhostLink.exe
node -e "const b=require('node:fs').readFileSync(process.argv[1]);const h=JSON.parse(b.subarray(16,16+b.readUInt32LE(12)).toString());console.log('app.asar:',Object.keys(h.files).join(' '));console.log('node_modules:',Object.keys(h.files.node_modules?.files??{}).join(' '));console.log('out/main:',Object.keys(h.files.out.files.main.files).join(' '))" apps/desktop/dist/win-unpacked/resources/app.asar
powershell -NoProfile -Command "(Get-Item 'apps/desktop/dist/win-unpacked/GhostLink.exe').VersionInfo | Select-Object CompanyName, ProductName, LegalCopyright, FileVersion | Format-List"
```
Expected:
- fuses: `RunAsNode is Disabled`, `EnableNodeOptionsEnvironmentVariable is Disabled`, `EnableNodeCliInspectArguments is Disabled`, `EnableEmbeddedAsarIntegrityValidation is Enabled`, `OnlyLoadAppFromAsar is Enabled`, `GrantFileProtocolExtraPrivileges is Disabled` (the other three lines are Electron defaults);
- `app.asar: node_modules out package.json`; `node_modules: @peculiar asn1js pvtsutils pvutils reflect-metadata tslib tsyringe ws zod` (the four runtime dependencies and what they pull in — no `@ghostlink`, `react` or `@fontsource`); `out/main: chunks index.js migrations serverEntry.js`; `ls -l apps/desktop/dist/win-unpacked/resources/app.asar` shows about 9 MB;
- `CompanyName : GhostLink contributors`, `ProductName : GhostLink`, `LegalCopyright : Copyright © 2026 GhostLink contributors`, `FileVersion : 0.1.0`. In Explorer, `GhostLink.exe` and `GhostLink-Setup-0.1.0.exe` show the ghost icon.

- [ ] **Step 4: Prove the asar integrity check (spec §12 "nothing may change app.asar")**

Flip one letter inside `out/main` code in a **copy** of the app and start it:

Run:
```bash
tamper="$(mktemp -d)"
cp -r apps/desktop/dist/win-unpacked "$tamper/app"
node -e "const fs=require('node:fs');const p=process.argv[1];const b=fs.readFileSync(p);const i=b.indexOf('GHOSTLINK_SMOKE');if(i<0)throw new Error('marker not found');b[i+1]^=0x20;fs.writeFileSync(p,b);console.log('flipped byte',i+1);" "$tamper/app/resources/app.asar"
GHOSTLINK_SMOKE=1 "$tamper/app/GhostLink.exe" --user-data-dir="$tamper/profile"; echo "exit=$?"
sleep 3; rm -rf "$tamper"
```
Expected: `flipped byte …`, then `ASAR Integrity Violation: got a hash mismatch (… vs …)` and `exit=1`.

- [ ] **Step 5: Install, update and uninstall (per-user, no admin)**

This checks `perMachine: false`, the install folder from `extraMetadata.name`, and `installer.nsh` (verified fact 6). The key is created by hand because deep-link registration only arrives in Milestone 8. Skip this step if a real GhostLink is installed on this machine (the uninstaller would remove it).

Run:
```bash
export MSYS_NO_PATHCONV=1
./apps/desktop/dist/GhostLink-Setup-0.1.0.exe /S; echo "install exit=$?"
ls "$LOCALAPPDATA/Programs/ghostlink/GhostLink.exe"
reg add 'HKCU\Software\Classes\ghostlink' /v 'URL Protocol' /d '' /f
./apps/desktop/dist/GhostLink-Setup-0.1.0.exe /S; echo "update exit=$?"
reg query 'HKCU\Software\Classes\ghostlink' >/dev/null 2>&1 && echo "key kept after update" || echo "key LOST after update"
"$LOCALAPPDATA/Programs/ghostlink/Uninstall GhostLink.exe" /S; echo "uninstall exit=$?"
sleep 5
reg query 'HKCU\Software\Classes\ghostlink' >/dev/null 2>&1 && echo "key STILL PRESENT" || echo "key removed by uninstall"
ls "$LOCALAPPDATA/Programs/ghostlink" 2>/dev/null || echo "install folder removed"
unset MSYS_NO_PATHCONV
```
Expected: `install exit=0`; the `ls` prints the path; `reg` prints its localized success message; `update exit=0`; `key kept after update`; `uninstall exit=0`; `key removed by uninstall`; `install folder removed`. The installer runs silently and does not start the app, so `%APPDATA%\GhostLink` is not created.

- [ ] **Step 6: If something failed — known causes and fixes**

| Symptom | Cause | Fix |
|---|---|---|
| `EBUSY`/`EPERM` removing `apps/desktop/dist`, or `dist` fails replacing `win-unpacked` | A `GhostLink.exe` from an earlier run is still alive, or Defender is scanning it | `MSYS_NO_PATHCONV=1 taskkill /IM GhostLink.exe /F`, wait a few seconds, re-run |
| `dist` stops at `downloading …` / `ECONNRESET` / checksum error | Flaky network while fetching Electron, NSIS, 7-Zip or the icon toolset | Re-run `npm run dist` (downloads are cached once complete) |
| `smoke-runner: FAILED - no packaged app at …` | `npm run dist` not run, or it failed | Run `npm run dist` and read its errors |
| `smoke-runner: FAILED - unsafe fuses: …` | `electronFuses` edited or removed | Restore `electronFuses` from Task 7; never flip fuses with another tool after packaging (it breaks the macOS signature) |
| `smoke-runner: FAILED - app.asar contains Vite optional-dependency stubs (__viteOptionalPeerDep_bufferutil_ws_true)` | `ws` was bundled (removed from `dependencies`, or `externalizeDeps` disabled/excluding it) | Put `ws` back in `apps/desktop` `dependencies` and keep main-process externalization on |
| `the app exited with code 1` and the log shows `smoke: FAILED (the hosted server exited …)` or `ENOENT … migrations` | The server bundle cannot find its migrations or a module | Check `out/main/migrations/001_init.sql` exists after `npm run build -w @ghostlink/desktop` (plan 1b's `copyServerMigrations`) |
| `the app exited with code 1` with no `smoke:` line at all | Another GhostLink holds the lock in the same profile, or the main process crashed before smoke mode | The runner always uses a fresh profile, so read the log above the verdict for the crash |
| `the app did not exit within 60 s` | Renderer never became ready (e.g. an ESM preload under `sandbox: true` leaves `window.ghostlink` undefined) or a dialog is blocking | Build the preload as CJS (plan 1b) and re-run; on macOS make sure the temporary keychain step ran |
| `ASAR Integrity Violation` when running the real (untampered) package | `app.asar` was modified after packaging | Rebuild with `npm run dist`; never patch `app.asar` |
| Dev Electron: `Cannot find module 'electron'` / `does not provide an export named …` | `ELECTRON_RUN_AS_NODE=1` from the VS Code terminal | Use `npm run dev` or `unset ELECTRON_RUN_AS_NODE`; the packaged app is immune |
| SmartScreen "Windows protected your PC" | Only for installers downloaded from the internet (Mark-of-the-Web), e.g. CI artifacts | "More info" → "Run anyway". Irrelevant for `npm run smoke`, which runs the local build |

- [ ] **Step 7: Confirm a clean tree**

Run: `git status --short`
Expected: empty output (`apps/desktop/dist/` and `apps/desktop/out/` are ignored by the root `.gitignore`).

---

### Task 11: Final verification

**Files:** none (fix-ups only if a gate fails).

- [ ] **Step 1: Run every gate**

Run:
```bash
npm run lint
npm run typecheck
npm test
```
Expected: lint and typecheck exit 0 with no diagnostics; Vitest prints `Test Files  59 passed (59)` and `Tests  735 passed | 6 skipped (741)` on Windows (on Linux/macOS the skipped POSIX-only tests run too) — plan 1b's 53 files / 690 tests plus the `tooling` project's 6 files / 51 tests (`smoke` 19, `electronBuilderConfig` 12, `ciWorkflow` 11, `icon` 3, `macEntitlements` 3, `nsisInclude` 3).

- [ ] **Step 2: Run CI on GitHub when the repository has a remote**

Run: `git remote get-url origin`

- If it prints a GitHub URL: push and watch the run.
  ```bash
  git push -u origin HEAD
  sleep 15 # let GitHub register the run
  gh run watch "$(gh run list --branch "$(git branch --show-current)" --workflow CI --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
  ```
  Expected: five green jobs — `Test (windows-latest)`, `Test (ubuntu-latest)`, `Test (macos-latest)`, `Package and smoke test (windows-latest)`, `Package and smoke test (macos-latest)`; the macOS package log shows `smoke-runner: PASSED`, and the run has two artifacts, `ghostlink-Windows-<sha>` (the `.exe`) and `ghostlink-macOS-<sha>` (both `.dmg` files).
- If it fails with `error: No such remote 'origin'`: the repository is not published yet (spec §15: publication is decided in Milestone 9). Tasks 8 (policy tests + actionlint) and 10 are the gate until then; the first push runs this workflow unchanged.

- [ ] **Step 3: Commit only if Steps 1–2 required fixes**

```bash
git add -A
git commit -m "$(cat <<'EOF'
fix: address CI and packaging verification findings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Spec coverage (self-review)

| Spec requirement | Where |
|---|---|
| §3.6 `appId` and the userData folder fixed from 0.1.0 | Task 7 (`appId`, `extraMetadata`), test `electronBuilderConfig` |
| §8.4 `NSMicrophoneUsageDescription` / `NSCameraUsageDescription` | Task 7 (`mac.extendInfo`) |
| §11 original SVG icon, ghost made of a chain link, dark theme + spectral cyan | Task 4 |
| §12 fuses `runAsNode`/`enableNodeCliInspectArguments`/`enableNodeOptionsEnvironmentVariable` off, `onlyLoadAppFromAsar`/`enableEmbeddedAsarIntegrityValidation` on, `grantFileProtocolExtraPrivileges` off, applied by electron-builder | Task 7 (config), Tasks 2–3 (read back from the binary on every smoke run), Task 10 Step 3 |
| §12 nothing may alter `app.asar` after packaging | Task 10 Step 4 (tamper → `ASAR Integrity Violation`) |
| §12 uninstaller deletes `HKCU\Software\Classes\ghostlink` via `nsis.include: build/installer.nsh` / `customUnInstall` | Task 6, Task 10 Step 5 |
| §12 `GHOSTLINK_SMOKE` works when packaged, only opens/checks/exits | Tasks 2–3 (runner), plan 1b (`smoke.ts`) |
| §14 package smoke: `GHOSTLINK_SMOKE=1`, exit 0, 60 s, no Playwright, Windows and macOS arm64 | Tasks 2, 3, 8, 10 |
| §14 environment: remove `ELECTRON_RUN_AS_NODE`; macOS CI creates and unlocks a temporary keychain before the smoke test | Task 2 (`smokeEnv`), Task 8 |
| §15 electron-builder pinned; `npmRebuild: false`; `appId`, `productName` | Task 7 |
| §15 Windows `nsis` `oneClick`, `perMachine: false`, `artifactName`, `include` | Task 7 |
| §15 macOS `dmg` arm64 + x64 in one job, `dmg.artifactName`, no `zip`, `minimumSystemVersion: "13.0"`, `identity: "-"`, `hardenedRuntime`, `entitlements` + `entitlementsInherit` with the five keys replacing the template | Tasks 5, 7 |
| §15 builds with `--publish never` | Task 7 (`dist` script), test `electronBuilderConfig` |
| §15 CI: actions pinned by SHA, minimal permissions, `ci.yml` on push and PR, typecheck/lint/tests on Windows/Linux/macOS, packaging + smoke on Windows and macOS | Task 8 |
| §17 step 1: `ci.yml` on Windows, Linux and macOS; packaging skeleton (NSIS + ad-hoc DMG with fuses built in CI) with the smoke test | Tasks 1–11 |

Deferred by design (see Scope): e2e job on `windows-latest` (§15, first e2e in M2), `extraResources` for LiveKit (M5), macOS `protocols` (M8), `publisherName`, `release.yml`, updater, Sigstore/Ed25519 signing (M9).

---

## Contract notes

The contract was followed for every name, version and path it defines. Below are the problems found while verifying it against electron-builder 26.15.3, electron-vite 5.0.0 and Electron 44.4.5, and every addition this plan makes.

1. **Desktop `dependencies` vs. bundling (contract §1 calls react, react-dom, zustand, … "desktop dep").** electron-vite 5 externalizes every `dependencies` entry and electron-builder ships each one (with its transitive dependencies) in `app.asar`. With plan 1b's list the package also carried what is bundled anyway: the TypeScript source of `@ghostlink/*`, React, zustand and ~420 Inter font files (~24 MB asar). Task 7 moves those six packages to `devDependencies`, as plan 1b's contract note 13 invites; `dependencies` keep exactly what the main-process bundles import at run time — `ws`, `zod`, `@peculiar/x509`, `reflect-metadata` — which is also what plan 1b's `test/build.test.ts` asserts (~9 MB asar; full suite, `dist` and smoke verified). **Recommended fix:** say in contract §1 that desktop packages electron-vite bundles are `devDependencies`; later runtime additions (native `uiohook-napi` in M8, `electron-updater` in M9) go to `dependencies` and to `RUNTIME_DEPENDENCIES` in `electronBuilderConfig.test.ts`.
2. **`ws` must never be bundled.** Vite replaces ws's optional `bufferutil` probe with an empty stub, and ws then throws `bufferUtil.mask is not a function` on every frame of 32+ bytes (reproduced with a 200-byte echo). Plan 1b's smoke (fork + TLS probe + shutdown) cannot catch it, so `npm run smoke` scans `app.asar` for `__viteOptionalPeerDep_*` and `electronBuilderConfig.test.ts` keeps `ws` in `dependencies`. **Recommended fix:** add to contract §5: "main/preload builds keep `ws` external; never set `externalizeDeps: false` for main". A later smoke step that completes a real `hello → welcome` handshake against the forked server would also cover it.
3. **Frozen userData / install folder names are not in the contract.** Without `extraMetadata`, the packaged app uses `%APPDATA%\@ghostlink\desktop` and installs into `%LOCALAPPDATA%\Programs\@ghostlinkdesktop` (verified). Task 7 adds `extraMetadata: { name: ghostlink, productName: GhostLink }`. Development runs keep the workspace-derived profile (`@ghostlink/desktop`), which keeps dev experiments away from the installed app's identity (plan 1b's contract note 12 asks for exactly this split). **Recommended fix:** add both names to contract §6 as frozen values.
4. **`author`** is added to `apps/desktop/package.json` (`GhostLink contributors`): without it the exe's `CompanyName` stays "GitHub, Inc." and electron-builder warns.
5. **`dist` script shape.** Contract §6 says `dist = npm run build -w @ghostlink/desktop && electron-builder … --publish never`, run in `apps/desktop`. Implemented as the desktop script `npm run build && electron-builder --config electron-builder.yml --publish never` plus the root script `npm run dist -w @ghostlink/desktop` — the same commands in the same directory.
6. **Smoke pass criteria (contract §5/§6 define only "exit code 0 within 60 s").** The runner additionally requires the `smoke: OK` line that plan 1b's `smoke.ts` logs, checks the fuses of the binary and scans `app.asar`, and launches the app with `--user-data-dir=<temp>` (the packaged app ignores `GHOSTLINK_USER_DATA` by design; Electron 44 honours the Chromium switch). **Recommended fix:** record in contract §5 that `smoke.ts` logs `smoke: OK …` to stdout right before `app.exit(0)` — `scripts/lib/smoke.mjs` (`SMOKE_OK_MARKER`) depends on it.
7. **Preload format (for plan 1b, already handled there).** A sandboxed preload must be CommonJS: with electron-vite's default ESM preload (`index.mjs`) the page loads but `window.ghostlink` is silently `undefined` (verified). Plan 1b builds `preload/index.cjs`; its `rendererReady()` smoke check would catch a regression.
8. **Icon.** The contract does not name icon files. Only `build/icon.svg` is committed and set as `icon:`; electron-builder 26.15.3 produces the ICO and ICNS from it (verified for both formats). No PNG and no rasterizer dependency.
9. **Repository layout additions (contract §2):** a fourth Vitest project `scripts` (named `tooling`) with `scripts/vitest.config.ts` and `scripts/tsconfig.json`; the root `typecheck` script also runs `tsc -p scripts/tsconfig.json`; `scripts/lib/`, `scripts/test/`. New root devDependencies, pinned: `@electron/fuses` 2.1.3 and `yaml` 2.9.1.
10. **`publisherName` (spec §15)** is part of the Milestone 9 updater work; in electron-builder 26.x the key is `win.signtoolOptions.publisherName` (not `win.publisherName`).
11. **CI details the contract leaves open:** triggers are push to `main`, pull requests and `workflow_dispatch`; `test` and `package` run in parallel; `persist-credentials: false`; only three allowlisted actions. The spec §15 e2e job on `windows-latest` is not in contract §6 and is added together with the first e2e test (M2).
12. **Electron 44 has no npm postinstall — and CI does not need the binary.** `npm ci` never downloads it; `require('electron')` (plan 1b's `run-electron.mjs`) downloads it on first use, and electron-builder downloads its own copy for packaging. Plan 1b's contract note 11 suggests running `node node_modules/electron/install.js` in CI right after `npm ci`. Not done: with no `node_modules/electron/dist` at all, the whole suite (plan 1b's mocked-electron tests and its real `electron-vite build` test included), `npm run dist` and `npm run smoke` passed on this machine, so the step would only add a ~160 MB download to each of the five jobs. Add it if a future CI step starts the dev Electron (e.g. an e2e job).
13. **macOS x64 DMG is built but not launched in CI** (the `macos-latest` runner is arm64); spec §14 asks for the arm64 smoke only. The x64 build is covered by the policy tests and by electron-builder's own signing/validation.
14. **Possible scope change from `2026-09-28-v0.1-release.md`** (a draft written in parallel with this plan): it defers the macOS build to v0.2 and says "macOS runs tests only". This plan follows contract §6 (package + smoke on `windows-latest` **and** `macos-latest`). If the owner adopts the release draft, remove `macos-latest` from `jobs.package.strategy.matrix.os` in `ci.yml` and from the matching expectation in `ciWorkflow.test.ts`; nothing else changes (the macOS keychain step is already conditional on `runner.os`).
15. **For plan 1b (observed while verifying):** every smoke run leaves the hosted server's data folder (`%TEMP%\ghostlink-smoke-*` with `ghostlink.db`, `tls/server.key`, `setup-code.txt`) behind, because `index.ts` creates it with `mkdtempSync(app.getPath('temp'))` and never removes it. Harmless on CI runners, but it accumulates on developer machines. **Recommended fix:** create it under `app.getPath('userData')` (which `npm run smoke` and `smoke:dev` already delete) or remove it after `server.shutdown()`.
