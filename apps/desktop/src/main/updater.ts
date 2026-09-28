// Automatic updates (spec §15), Windows NSIS builds only in v0.1. electron-updater downloads a
// new release in the background; before it may install, the installer must carry a valid Ed25519
// signature by the release key (updaterSignature.ts). The check runs at startup and every 6 h, can
// be turned off, and is the app's only contact with a third party (GitHub).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NsisUpdater } from 'electron-updater';
import { z } from 'zod';
import { RELEASE_REPO, isReleaseVersion } from '@ghostlink/shared';
import { AppError } from '../shared/appErrors.js';
import type { UpdateState, UpdateStatus } from '../shared/updates.js';
import { readJsonFile, writeJsonAtomic } from './files.js';
import { createInstallerVerifier, type SignatureFetcher } from './updaterSignature.js';

export type { UpdateState, UpdateStatus } from '../shared/updates.js';

export const UPDATES_FILE = 'updates.json';
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Lets the window and the connection settle before the first network request. */
export const FIRST_CHECK_DELAY_MS = 10_000;

/** The part of electron-updater's NsisUpdater this module drives (a fake in tests). */
export interface UpdaterBackend {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  disableWebInstaller: boolean;
  verifyUpdateCodeSignature: (publisherNames: string[], path: string) => Promise<string | null>;
  setFeedURL(options: { provider: 'github'; owner: string; repo: string }): void;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: 'checking-for-update' | 'update-not-available', listener: () => void): unknown;
  on(event: 'update-available' | 'update-downloaded', listener: (info: { version?: unknown }) => void): unknown;
  on(event: 'download-progress', listener: (progress: { percent?: unknown }) => void): unknown;
  on(event: 'error', listener: (error: { code?: unknown; message?: unknown }) => void): unknown;
}

export interface UpdaterOptions {
  /** Null in development, in smoke mode and outside the installed Windows app: nothing runs. */
  backend: UpdaterBackend | null;
  userDataDir: string;
  currentVersion: string;
  fetchSignature: SignatureFetcher;
  emit(state: UpdateState): void;
  log?: (message: string) => void;
}

const fileSchema = z.object({ version: z.literal(1), autoCheck: z.boolean() });

/**
 * electron-updater calls verifyUpdateCodeSignature only when app-update.yml names a publisher
 * (NsisUpdater.verifySignature returns "valid" without it). The updater refuses to run unless
 * the packaged config has one, so the Ed25519 check can never be skipped silently.
 */
export function appUpdateConfigVerifies(appUpdateYml: string | null): boolean {
  if (appUpdateYml === null) return false;
  if (/^publisherName:[ \t]*\r?\n[ \t]+-[ \t]*\S/m.test(appUpdateYml)) return true;
  const inline = /^publisherName:[ \t]*(\S.*)$/m.exec(appUpdateYml)?.[1]?.trim();
  return inline !== undefined && !['null', '~', '[]', "''", '""'].includes(inline);
}

export class Updater {
  readonly #opts: UpdaterOptions;
  readonly #path: string;
  #autoCheck: boolean;
  #status: UpdateStatus;
  #version: string | null = null;
  #percent: number | null = null;
  /** The version announced by update-available: the only one whose signature is fetched. */
  #pendingVersion: string | null = null;
  #started = false;
  #firstCheck: ReturnType<typeof setTimeout> | null = null;
  #interval: ReturnType<typeof setInterval> | null = null;

  private constructor(opts: UpdaterOptions, path: string, autoCheck: boolean) {
    this.#opts = opts;
    this.#path = path;
    this.#autoCheck = autoCheck;
    this.#status = this.#restingStatus();
  }

  /** Reads `<userData>/updates.json` (automatic checks default to on). */
  static load(opts: UpdaterOptions): Updater {
    const path = join(opts.userDataDir, UPDATES_FILE);
    const file = readJsonFile(path, fileSchema, () => ({ version: 1 as const, autoCheck: true }));
    return new Updater(opts, path, file.autoCheck);
  }

  state(): UpdateState {
    return { status: this.#status, autoCheck: this.#autoCheck, currentVersion: this.#opts.currentVersion, version: this.#version, percent: this.#percent };
  }

  /** Configures electron-updater and schedules the checks. A no-op when unsupported. */
  start(): void {
    const backend = this.#opts.backend;
    if (backend === null || this.#started) return;
    this.#started = true;
    backend.autoDownload = true;
    backend.autoInstallOnAppQuit = this.#autoCheck;
    backend.allowPrerelease = false;
    backend.allowDowngrade = false;
    backend.disableWebInstaller = true;
    backend.setFeedURL({ provider: 'github', owner: RELEASE_REPO.owner, repo: RELEASE_REPO.repo });
    backend.verifyUpdateCodeSignature = createInstallerVerifier(() => this.#pendingVersion, { fetchSignature: this.#opts.fetchSignature });

    backend.on('checking-for-update', () => {
      if (this.#status !== 'downloading' && this.#status !== 'downloaded') this.#set('checking');
    });
    backend.on('update-available', (info: { version?: unknown }) => {
      this.#pendingVersion = isReleaseVersion(info?.version) ? info.version : null;
      this.#set('downloading', this.#pendingVersion, 0);
    });
    backend.on('download-progress', (progress: { percent?: unknown }) => {
      if (this.#status !== 'downloading' || typeof progress?.percent !== 'number') return;
      const percent = Math.max(0, Math.min(100, Math.round(progress.percent)));
      if (percent !== this.#percent) this.#set('downloading', this.#version, percent);
    });
    backend.on('update-not-available', () => {
      if (this.#status === 'checking') this.#set(this.#restingStatus());
    });
    backend.on('update-downloaded', (info: { version?: unknown }) => {
      this.#set('downloaded', isReleaseVersion(info?.version) ? info.version : this.#pendingVersion);
    });
    backend.on('error', (error: { code?: unknown; message?: unknown }) => {
      this.#log(`update error: ${typeof error?.message === 'string' ? error.message : 'unknown'}`);
      if (error?.code === 'ERR_UPDATER_INVALID_SIGNATURE') this.#set('rejected', this.#pendingVersion);
      else if (this.#status === 'checking' || this.#status === 'downloading') this.#set(this.#restingStatus());
    });

    this.#schedule();
  }

  /** Persists the setting; turning it on checks right away. */
  setAutoCheck(enabled: boolean): UpdateState {
    writeJsonAtomic(this.#path, { version: 1, autoCheck: enabled });
    this.#autoCheck = enabled;
    if (this.#started && this.#opts.backend) {
      this.#opts.backend.autoInstallOnAppQuit = enabled;
      this.#unschedule();
      this.#schedule(0);
    }
    if (this.#status === 'idle' || this.#status === 'disabled') this.#status = this.#restingStatus();
    this.#emit();
    return this.state();
  }

  /** One check; skipped while another runs or an update waits for a restart. Never throws. */
  async checkNow(): Promise<void> {
    const backend = this.#opts.backend;
    if (!this.#started || !backend || this.#status === 'checking' || this.#status === 'downloading' || this.#status === 'downloaded') return;
    try {
      await backend.checkForUpdates();
    } catch (e) {
      this.#log(`update check failed: ${e instanceof Error ? e.message : 'unknown error'}`);
      // The status may have changed while awaiting (the error event usually resets it first).
      if (this.state().status === 'checking') this.#set(this.#restingStatus());
    }
  }

  /** "Restart to update": quits and runs the verified installer silently, then reopens the app. */
  restart(): void {
    const backend = this.#opts.backend;
    if (!this.#started || !backend || this.#status !== 'downloaded') throw new AppError('BAD_REQUEST', 'no downloaded update');
    backend.quitAndInstall(true, true);
  }

  dispose(): void {
    this.#unschedule();
  }

  #schedule(firstDelay = FIRST_CHECK_DELAY_MS): void {
    if (!this.#autoCheck) return;
    this.#firstCheck = setTimeout(() => void this.checkNow(), firstDelay);
    this.#interval = setInterval(() => void this.checkNow(), CHECK_INTERVAL_MS);
  }

  #unschedule(): void {
    if (this.#firstCheck) clearTimeout(this.#firstCheck);
    if (this.#interval) clearInterval(this.#interval);
    this.#firstCheck = null;
    this.#interval = null;
  }

  #restingStatus(): UpdateStatus {
    if (this.#opts.backend === null) return 'unsupported';
    return this.#autoCheck ? 'idle' : 'disabled';
  }

  #set(status: UpdateStatus, version: string | null = null, percent: number | null = null): void {
    this.#status = status;
    this.#version = version;
    this.#percent = percent;
    this.#emit();
  }

  #emit(): void {
    this.#opts.emit(this.state());
  }

  #log(message: string): void {
    (this.#opts.log ?? console.warn)(`[updater] ${message}`);
  }
}

/**
 * The real electron-updater backend, or null where updates do not run: development builds
 * (`!app.isPackaged`), smoke mode, anything but Windows (v0.1), or a packaged app whose
 * app-update.yml would let electron-updater skip the signature check.
 */
export function createUpdaterBackend(env: {
  packaged: boolean;
  smoke: boolean;
  platform: NodeJS.Platform;
  resourcesPath: string;
  log?: (message: string) => void;
}): UpdaterBackend | null {
  if (!env.packaged || env.smoke || env.platform !== 'win32') return null;
  const log = env.log ?? console.warn;
  let config: string | null;
  try {
    config = readFileSync(join(env.resourcesPath, 'app-update.yml'), 'utf8');
  } catch {
    config = null;
  }
  if (!appUpdateConfigVerifies(config)) {
    log('[updater] app-update.yml has no publisherName, so signatures would not be checked: updates are off.');
    return null;
  }
  const updater = new NsisUpdater();
  updater.logger = { info: () => {}, warn: (m: unknown) => log(`[updater] ${String(m)}`), error: (m: unknown) => log(`[updater] ${String(m)}`) };
  return updater;
}
