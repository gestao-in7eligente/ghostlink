import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateState } from '../../src/shared/updates.js';
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  UPDATES_FILE,
  Updater,
  appUpdateConfigVerifies,
  createUpdaterBackend,
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
const fetchSignature = vi.fn(async () => new Uint8Array(64));

function load(opts: { supported?: boolean } = {}): Updater {
  return Updater.load({
    backend: opts.supported === false ? null : backend,
    userDataDir: dir.path,
    currentVersion: '0.1.0',
    fetchSignature,
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
    const updater = load();
    updater.start();
    // No update announced yet: whatever was downloaded is refused without a network call.
    await expect(backend.verifyUpdateCodeSignature(['x'], join(dir.path, 'a.exe'))).resolves.toMatch(/version/i);
    expect(fetchSignature).not.toHaveBeenCalled();
    backend.emit('update-available', { version: '0.1.1' });
    await expect(backend.verifyUpdateCodeSignature(['x'], join(dir.path, 'a.exe'))).resolves.toEqual(expect.any(String));
    expect(fetchSignature).toHaveBeenCalledWith(
      'https://github.com/gestao-in7eligente/ghostlink/releases/download/v0.1.1/GhostLink-Setup-0.1.1.exe.ed25519',
    );
    updater.dispose();
  });

  it('does nothing at all when unsupported (dev, smoke, not Windows)', async () => {
    const updater = load({ supported: false });
    updater.start();
    expect(updater.state()).toEqual({ status: 'unsupported', autoCheck: true, currentVersion: '0.1.0', version: null, percent: null });
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

describe('Updater state for the banner', () => {
  it('reports download progress and the downloaded version', () => {
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
    expect(last()).toEqual({ status: 'downloaded', autoCheck: true, currentVersion: '0.1.0', version: '0.1.1', percent: null });
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
