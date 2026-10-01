import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateState } from '../../src/shared/updates.js';
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  STARTUP_CHECK_TIMEOUT_MS,
  STARTUP_SKIP_AFTER_MS,
  UPDATES_FILE,
  Updater,
  appUpdateConfigVerifies,
  createUpdaterBackend,
  type StartupOutcome,
  type StartupStep,
  type UpdaterBackend,
} from '../../src/main/updater.js';
import { useTempDir } from '../helpers/tempDir.js';

const dir = useTempDir('ghostlink-updater-');

class FakeBackend extends EventEmitter implements UpdaterBackend {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  allowPrerelease = true;
  allowDowngrade = true;
  disableWebInstaller = false;
  verifyUpdateCodeSignature: UpdaterBackend['verifyUpdateCodeSignature'] = async () => 'default verifier';
  setFeedURL = vi.fn();
  checkForUpdates = vi.fn(async () => {
    this.emit('checking-for-update');
    return null;
  });
  quitAndInstall = vi.fn();
}

let backend: FakeBackend;
let states: UpdateState[];
const fetchReleaseFile = vi.fn(async (_url: string, _maxBytes: number) => new Uint8Array(64));

function load(opts: { supported?: boolean } = {}): Updater {
  return Updater.load({
    backend: opts.supported === false ? null : backend,
    userDataDir: dir.path,
    currentVersion: '0.1.0',
    fetchReleaseFile,
    emit: (state) => states.push(state),
    log: () => {},
  });
}
const last = () => states.at(-1)!;

beforeEach(() => {
  backend = new FakeBackend();
  states = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Updater configuration (spec §15)', () => {
  it('configures electron-updater for verified background installs from the GitHub releases', () => {
    const updater = load();
    updater.start();
    expect(backend.autoDownload).toBe(true);
    expect(backend.autoInstallOnAppQuit).toBe(true);
    expect(backend.allowPrerelease).toBe(false);
    expect(backend.allowDowngrade).toBe(false);
    expect(backend.disableWebInstaller).toBe(true);
    expect(backend.setFeedURL).toHaveBeenCalledWith({ provider: 'github', owner: 'gestao-in7eligente', repo: 'ghostlink' });
    updater.dispose();
  });

  it('replaces the Authenticode check with the Ed25519 release-signature check', async () => {
    fetchReleaseFile.mockClear();
    const updater = load();
    updater.start();
    // No update announced yet: whatever was downloaded is refused without a network call.
    await expect(backend.verifyUpdateCodeSignature(['x'], join(dir.path, 'a.exe'))).resolves.toMatch(/version/i);
    expect(fetchReleaseFile).not.toHaveBeenCalled();
    backend.emit('update-available', { version: '0.1.1' });
    await expect(backend.verifyUpdateCodeSignature(['x'], join(dir.path, 'a.exe'))).resolves.toEqual(expect.any(String));
    const release = 'https://github.com/gestao-in7eligente/ghostlink/releases/download/v0.1.1';
    expect(fetchReleaseFile).toHaveBeenCalledWith(`${release}/GhostLink-Setup-0.1.1.exe.ed25519`, 64);
    expect(fetchReleaseFile).toHaveBeenCalledWith(`${release}/checksums-sha256.txt`, expect.any(Number));
    expect(fetchReleaseFile).toHaveBeenCalledWith(`${release}/checksums-sha256.txt.ed25519`, 64);
    updater.dispose();
  });

  it('refuses an update that is not newer than the running app, without a network call', async () => {
    fetchReleaseFile.mockClear();
    const updater = load();
    updater.start();
    for (const version of ['0.1.0', '0.0.9']) {
      backend.emit('update-available', { version });
      await expect(backend.verifyUpdateCodeSignature(['x'], join(dir.path, 'a.exe'))).resolves.toMatch(/not newer/);
    }
    expect(fetchReleaseFile).not.toHaveBeenCalled();
    updater.dispose();
  });

  it('does nothing at all when unsupported (dev, smoke, not Windows)', async () => {
    const updater = load({ supported: false });
    updater.start();
    expect(updater.state()).toEqual({ status: 'unsupported', autoCheck: true, currentVersion: '0.1.0', version: null, percent: null, lastCheckedAt: null });
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    await updater.checkNow();
    expect(backend.checkForUpdates).not.toHaveBeenCalled();
    expect(backend.setFeedURL).not.toHaveBeenCalled();
    expect(() => updater.restart()).toThrow();
    updater.dispose();
  });
});

describe('Updater schedule', () => {
  it('checks shortly after startup and then every 6 hours', async () => {
    const updater = load();
    updater.start();
    expect(backend.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(1);
    backend.emit('update-not-available', { version: '0.1.0' });
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(CHECK_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
    updater.dispose();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3);
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('never checks while turned off, and persists the choice', async () => {
    const updater = load();
    updater.setAutoCheck(false);
    updater.start();
    expect(updater.state().status).toBe('disabled');
    expect(backend.autoInstallOnAppQuit).toBe(false);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(backend.checkForUpdates).not.toHaveBeenCalled();
    updater.dispose();

    expect(JSON.parse(readFileSync(join(dir.path, UPDATES_FILE), 'utf8'))).toEqual({ version: 1, autoCheck: false });
    const reloaded = load();
    expect(reloaded.state().autoCheck).toBe(false);
    reloaded.dispose();
  });

  it('checks right away when turned back on', async () => {
    const updater = load();
    updater.setAutoCheck(false);
    updater.start();
    const state = updater.setAutoCheck(true);
    expect(state.autoCheck).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(backend.autoInstallOnAppQuit).toBe(true);
    updater.dispose();
  });

  it('starts from the default (on) with a missing or corrupt settings file', () => {
    expect(existsSync(join(dir.path, UPDATES_FILE))).toBe(false);
    expect(load().state().autoCheck).toBe(true);
    writeFileSync(join(dir.path, UPDATES_FILE), '{"version":1,"autoCheck":"yes"}');
    expect(load().state().autoCheck).toBe(true);
  });

  it('does not start a second check while one is running or an update is waiting', async () => {
    const updater = load();
    updater.start();
    backend.checkForUpdates.mockImplementation(async () => {
      backend.emit('checking-for-update');
      backend.emit('update-available', { version: '0.1.1' });
      return null;
    });
    await updater.checkNow();
    expect(updater.state().status).toBe('downloading');
    await updater.checkNow();
    backend.emit('update-downloaded', { version: '0.1.1' });
    await updater.checkNow();
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(1);
    updater.dispose();
  });

  it('survives a failing check (offline) and goes back to idle', async () => {
    const updater = load();
    updater.start();
    backend.checkForUpdates.mockImplementation(async () => {
      backend.emit('checking-for-update');
      backend.emit('error', Object.assign(new Error('net::ERR_INTERNET_DISCONNECTED'), { code: 'ERR_NETWORK' }));
      throw new Error('net::ERR_INTERNET_DISCONNECTED');
    });
    await expect(updater.checkNow()).resolves.toBeUndefined();
    expect(updater.state().status).toBe('idle');
    updater.dispose();
  });
});

describe('Updater: the time of the last check ("Você está na versão mais recente")', () => {
  /** checkForUpdates the way electron-updater runs it: the events come before the promise resolves. */
  function nextCheck(...events: Array<[string, unknown?]>) {
    backend.checkForUpdates.mockImplementationOnce(async () => {
      backend.emit('checking-for-update');
      for (const [event, payload] of events) backend.emit(event, payload);
      return null;
    });
  }

  it('records when a check got an answer, with or without an update, and keeps it when a check fails', async () => {
    vi.setSystemTime(new Date(2026, 9, 1, 14, 2));
    const first = Date.now();
    const updater = load();
    updater.start();
    expect(updater.state().lastCheckedAt).toBeNull();

    nextCheck(['update-not-available', { version: '0.1.0' }]);
    await updater.checkNow();
    expect(last()).toMatchObject({ status: 'idle', lastCheckedAt: first });

    vi.setSystemTime(first + 60_000); // offline: the error event, then the rejected promise
    backend.checkForUpdates.mockImplementationOnce(async () => {
      backend.emit('checking-for-update');
      backend.emit('error', Object.assign(new Error('net::ERR_INTERNET_DISCONNECTED'), { code: 'ERR_NETWORK' }));
      throw new Error('net::ERR_INTERNET_DISCONNECTED');
    });
    await updater.checkNow();
    expect(last()).toMatchObject({ status: 'idle', lastCheckedAt: first });

    vi.setSystemTime(first + 120_000);
    nextCheck(['update-available', { version: '0.1.1' }]);
    await updater.checkNow();
    expect(last()).toMatchObject({ status: 'downloading', version: '0.1.1', lastCheckedAt: first + 120_000 });
    updater.dispose();
  });

  it('lets the person check by hand with automatic checks off, and stays "disabled" afterwards', async () => {
    const updater = load();
    updater.setAutoCheck(false);
    updater.start();
    nextCheck(['update-not-available', { version: '0.1.0' }]);
    await updater.checkNow();
    expect(backend.checkForUpdates).toHaveBeenCalledOnce();
    expect(updater.state()).toMatchObject({ status: 'disabled', lastCheckedAt: Date.now() });
    expect(last()).toEqual(updater.state());
    updater.dispose();
  });
});

describe('Updater state for the banner', () => {
  it('reports download progress and the downloaded version', () => {
    vi.setSystemTime(new Date(2026, 9, 1, 14, 2));
    const foundAt = Date.now();
    const updater = load();
    updater.start();
    backend.emit('checking-for-update');
    expect(last().status).toBe('checking');
    backend.emit('update-available', { version: '0.1.1' });
    expect(last()).toMatchObject({ status: 'downloading', version: '0.1.1', percent: 0 });
    backend.emit('download-progress', { percent: 41.7 });
    backend.emit('download-progress', { percent: 41.9 }); // same whole percent: no new event
    expect(states.filter((s) => s.percent === 42)).toHaveLength(1);
    backend.emit('update-downloaded', { version: '0.1.1' });
    expect(last()).toEqual({ status: 'downloaded', autoCheck: true, currentVersion: '0.1.0', version: '0.1.1', percent: null, lastCheckedAt: foundAt });
    expect(updater.state()).toEqual(last());
    updater.dispose();
  });

  it('tells the person when a download fails the signature check', () => {
    const updater = load();
    updater.start();
    backend.emit('update-available', { version: '0.1.1' });
    backend.emit('error', Object.assign(new Error('not signed by the application owner'), { code: 'ERR_UPDATER_INVALID_SIGNATURE' }));
    expect(last()).toMatchObject({ status: 'rejected', version: '0.1.1' });
    expect(() => updater.restart()).toThrow();
    expect(backend.quitAndInstall).not.toHaveBeenCalled();
    updater.dispose();
  });

  it('never shows a malformed version string from latest.yml', () => {
    const updater = load();
    updater.start();
    backend.emit('update-available', { version: '<img src=x>' });
    expect(last()).toMatchObject({ status: 'downloading', version: null });
    updater.dispose();
  });

  it('restarts into the installer only once an update is downloaded', () => {
    const updater = load();
    updater.start();
    expect(() => updater.restart()).toThrow();
    backend.emit('update-available', { version: '0.1.1' });
    expect(() => updater.restart()).toThrow();
    backend.emit('update-downloaded', { version: '0.1.1' });
    updater.restart();
    expect(backend.quitAndInstall).toHaveBeenCalledWith(true, true);
    updater.dispose();
  });

  it('keeps a downloaded update when checks are turned off', () => {
    const updater = load();
    updater.start();
    backend.emit('update-available', { version: '0.1.1' });
    backend.emit('update-downloaded', { version: '0.1.1' });
    expect(updater.setAutoCheck(false)).toMatchObject({ status: 'downloaded', autoCheck: false });
    updater.dispose();
  });
});

describe('Updater.checkAtStartup (atualizar ao abrir, spec §4)', () => {
  /** Runs the startup check the way index.ts does: the splash collects the steps, its link aborts. */
  function openApp(updater: Updater, onStep?: (step: StartupStep) => void) {
    const steps: StartupStep[] = [];
    const skip = new AbortController();
    let outcome: StartupOutcome | null = null;
    const done = updater
      .checkAtStartup({
        signal: skip.signal,
        onStep: (step) => {
          steps.push(step);
          onStep?.(step);
        },
      })
      .then((result) => (outcome = result));
    return { steps, skip, done, outcome: () => outcome };
  }
  /** checkForUpdates the way electron-updater runs it: the events come before the promise resolves. */
  function checkFinds(...events: Array<[string, unknown?]>) {
    backend.checkForUpdates.mockImplementation(async () => {
      backend.emit('checking-for-update');
      for (const [event, payload] of events) backend.emit(event, payload);
      return null;
    });
  }

  it('uses the spec times: 10 s for the check, 20 s of download before "Open without updating"', () => {
    expect(STARTUP_CHECK_TIMEOUT_MS).toBe(10_000);
    expect(STARTUP_SKIP_AFTER_MS).toBe(20_000);
  });

  it('opens the app when there is no new version', async () => {
    checkFinds(['update-not-available', { version: '0.1.0' }]);
    const updater = load();
    const run = openApp(updater);
    await run.done;
    expect(run.outcome()).toBe('continue');
    expect(run.steps[0]).toEqual({ step: 'checking' });
    expect(run.steps).not.toContainEqual({ step: 'installing' });
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(backend.quitAndInstall).not.toHaveBeenCalled();
    expect(updater.state().status).toBe('idle');
    updater.dispose();
  });

  it('opens the app when the check fails (offline)', async () => {
    backend.checkForUpdates.mockImplementation(async () => {
      backend.emit('checking-for-update');
      backend.emit('error', Object.assign(new Error('net::ERR_INTERNET_DISCONNECTED'), { code: 'ERR_NETWORK' }));
      throw new Error('net::ERR_INTERNET_DISCONNECTED');
    });
    const updater = load();
    const run = openApp(updater);
    await run.done;
    expect(run.outcome()).toBe('continue');
    expect(updater.state().status).toBe('idle');
    expect(backend.quitAndInstall).not.toHaveBeenCalled();
    updater.dispose();
  });

  it('opens the app when the check takes longer than 10 s', async () => {
    backend.checkForUpdates.mockImplementation(() => {
      backend.emit('checking-for-update');
      return new Promise<never>(() => {});
    });
    const updater = load();
    const run = openApp(updater);
    await vi.advanceTimersByTimeAsync(STARTUP_CHECK_TIMEOUT_MS - 1);
    expect(run.outcome()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(run.outcome()).toBe('continue');
    expect(backend.quitAndInstall).not.toHaveBeenCalled();
    updater.dispose();
  });

  it('installs a new version once it is downloaded and verified: quitAndInstall(true, true) once', async () => {
    checkFinds(['update-available', { version: '0.1.1' }]);
    const updater = load();
    const run = openApp(updater);
    await vi.advanceTimersByTimeAsync(0);
    expect(run.steps.at(-1)).toEqual({ step: 'downloading', percent: 0, canSkip: false });
    backend.emit('download-progress', { percent: 42.2 });
    expect(run.steps.at(-1)).toEqual({ step: 'downloading', percent: 42, canSkip: false });
    // The 10 s limit is for the check only: a slower download is not cut off.
    await vi.advanceTimersByTimeAsync(STARTUP_CHECK_TIMEOUT_MS * 1.5);
    expect(run.outcome()).toBeNull();
    // electron-updater emits update-downloaded only after verifyUpdateCodeSignature accepted the file.
    backend.emit('update-downloaded', { version: '0.1.1' });
    await run.done;
    expect(run.outcome()).toBe('installing');
    expect(run.steps.at(-1)).toEqual({ step: 'installing' });
    expect(backend.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(backend.quitAndInstall).toHaveBeenCalledWith(true, true);
    updater.dispose();
  });

  it('opens the app with the usual notice when the download fails the signature check', async () => {
    checkFinds(['update-available', { version: '0.1.1' }]);
    const updater = load();
    const run = openApp(updater);
    await vi.advanceTimersByTimeAsync(0);
    backend.emit('error', Object.assign(new Error('not signed by the application owner'), { code: 'ERR_UPDATER_INVALID_SIGNATURE' }));
    await run.done;
    expect(run.outcome()).toBe('continue');
    expect(updater.state()).toMatchObject({ status: 'rejected', version: '0.1.1' });
    expect(backend.quitAndInstall).not.toHaveBeenCalled();
    updater.dispose();
  });

  it('offers "Open without updating" after 20 s of download; the download goes on and nothing installs by itself', async () => {
    checkFinds(['update-available', { version: '0.1.1' }]);
    const updater = load();
    const run = openApp(updater);
    await vi.advanceTimersByTimeAsync(STARTUP_SKIP_AFTER_MS - 1);
    expect(run.steps.some((s) => s.step === 'downloading' && s.canSkip)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(run.steps.at(-1)).toEqual({ step: 'downloading', percent: 0, canSkip: true });
    backend.emit('download-progress', { percent: 30 });
    expect(run.steps.at(-1)).toEqual({ step: 'downloading', percent: 30, canSkip: true });

    run.skip.abort();
    await run.done;
    expect(run.outcome()).toBe('continue');
    const shown = run.steps.length;
    backend.emit('download-progress', { percent: 80 });
    expect(last()).toMatchObject({ status: 'downloading', percent: 80 });
    backend.emit('update-downloaded', { version: '0.1.1' });
    expect(last()).toMatchObject({ status: 'downloaded', version: '0.1.1' });
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(backend.quitAndInstall).not.toHaveBeenCalled();
    expect(run.steps).toHaveLength(shown); // the splash is gone: nothing more is reported to it
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(1); // the 6 h check skips a waiting update
    updater.dispose();
  });

  it('installs an update that was already downloaded, without checking again', async () => {
    const updater = load();
    updater.start();
    backend.emit('update-available', { version: '0.1.1' });
    backend.emit('update-downloaded', { version: '0.1.1' });
    const run = openApp(updater);
    await run.done;
    expect(run.outcome()).toBe('installing');
    expect(run.steps).toEqual([{ step: 'installing' }]);
    expect(backend.checkForUpdates).not.toHaveBeenCalled();
    expect(backend.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(backend.quitAndInstall).toHaveBeenCalledWith(true, true);
    updater.dispose();
  });

  it('turned off or unsupported: opens the app at once, without a splash or a check', async () => {
    const off = load();
    off.setAutoCheck(false);
    const offRun = openApp(off);
    await offRun.done;
    expect(offRun.outcome()).toBe('continue');
    expect(offRun.steps).toEqual([]);
    off.start();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(backend.checkForUpdates).not.toHaveBeenCalled();
    off.dispose();

    backend.setFeedURL.mockClear();
    const unsupported = load({ supported: false });
    const unsupportedRun = openApp(unsupported);
    await unsupportedRun.done;
    expect(unsupportedRun.outcome()).toBe('continue');
    expect(unsupportedRun.steps).toEqual([]);
    expect(backend.setFeedURL).not.toHaveBeenCalled();
    expect(backend.checkForUpdates).not.toHaveBeenCalled();
    unsupported.dispose();
  });

  it('replaces the delayed first check; the 6 h checks go on', async () => {
    checkFinds(['update-not-available', { version: '0.1.0' }]);
    const updater = load();
    await openApp(updater).done;
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(1);
    updater.start(); // index.ts still calls it once the window exists: a no-op by then
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS * 2);
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(backend.checkForUpdates).toHaveBeenCalledTimes(2);
    updater.dispose();
  });

  it('opens the app when the installer cannot be started (electron-updater then does not quit)', async () => {
    checkFinds(['update-available', { version: '0.1.1' }]);
    backend.quitAndInstall.mockImplementation(() => {
      backend.emit('error', new Error("No update filepath provided, can't quit and install"));
    });
    const updater = load();
    const run = openApp(updater);
    await vi.advanceTimersByTimeAsync(0);
    backend.emit('update-downloaded', { version: '0.1.1' });
    await run.done;
    expect(run.outcome()).toBe('continue');
    expect(backend.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(updater.state().status).toBe('downloaded'); // "Restart to update" stays available
    updater.dispose();
  });

  it('keeps updating when the splash fails to show a step', async () => {
    checkFinds(['update-available', { version: '0.1.1' }]);
    const updater = load();
    const run = openApp(updater, () => {
      throw new Error('Object has been destroyed');
    });
    await vi.advanceTimersByTimeAsync(0);
    backend.emit('update-downloaded', { version: '0.1.1' });
    await run.done;
    expect(run.outcome()).toBe('installing');
    expect(backend.quitAndInstall).toHaveBeenCalledTimes(1);
    updater.dispose();
  });
});

describe('createUpdaterBackend', () => {
  const env = { packaged: true, smoke: false, platform: 'win32' as const, log: () => {} };

  it('is off in development, in smoke mode and outside Windows', () => {
    writeFileSync(join(dir.path, 'app-update.yml'), 'provider: github\npublisherName:\n  - GhostLink contributors\n');
    expect(createUpdaterBackend({ ...env, packaged: false, resourcesPath: dir.path })).toBeNull();
    expect(createUpdaterBackend({ ...env, smoke: true, resourcesPath: dir.path })).toBeNull();
    expect(createUpdaterBackend({ ...env, platform: 'darwin', resourcesPath: dir.path })).toBeNull();
    expect(createUpdaterBackend({ ...env, platform: 'linux', resourcesPath: dir.path })).toBeNull();
  });

  it('fails closed when app-update.yml is missing or names no publisher', () => {
    expect(createUpdaterBackend({ ...env, resourcesPath: dir.path })).toBeNull();
    writeFileSync(join(dir.path, 'app-update.yml'), 'provider: github\nowner: gestao-in7eligente\nrepo: ghostlink\n');
    expect(createUpdaterBackend({ ...env, resourcesPath: dir.path })).toBeNull();
  });
});

describe('appUpdateConfigVerifies', () => {
  it('requires publisherName, without which electron-updater skips verifyUpdateCodeSignature', () => {
    expect(appUpdateConfigVerifies('owner: gestao-in7eligente\nrepo: ghostlink\nprovider: github\npublisherName:\n  - GhostLink contributors\n')).toBe(true);
    expect(appUpdateConfigVerifies('owner: gestao-in7eligente\nrepo: ghostlink\nprovider: github\n')).toBe(false);
    expect(appUpdateConfigVerifies('publisherName: null\n')).toBe(false);
    expect(appUpdateConfigVerifies(null)).toBe(false);
  });
});
