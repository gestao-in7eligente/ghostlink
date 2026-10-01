// Automatic updates (spec §15), Windows NSIS builds only in v0.1. electron-updater downloads a
// new release in the background; before it may install, the installer must be newer than the running
// app, carry a valid Ed25519 signature by the release key and match its line in the release's signed
// checksums-sha256.txt (updaterSignature.ts). The check runs at startup and every 6 h, can be turned
// off, and is the app's only contact with a third party (GitHub).
// "Atualizar ao abrir" (docs/superpowers/specs/2026-10-01-atualizar-ao-abrir-design.md): when the
// app opens, checkAtStartup runs the first check behind the splash and installs a verified update
// before the main window exists; once the app is open, an update still waits for "Restart to update".
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NsisUpdater } from 'electron-updater';
import { z } from 'zod';
import { RELEASE_REPO, isReleaseVersion } from '@ghostlink/shared';
import { AppError } from '../shared/appErrors.js';
import type { UpdateState, UpdateStatus } from '../shared/updates.js';
import { readJsonFile, writeJsonAtomic } from './files.js';
import { createInstallerVerifier, type ReleaseFileFetcher } from './updaterSignature.js';

export type { UpdateState, UpdateStatus } from '../shared/updates.js';

export const UPDATES_FILE = 'updates.json';
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Lets the window and the connection settle before the first network request (no startup check ran). */
export const FIRST_CHECK_DELAY_MS = 10_000;
/** At startup, a check that has not found an update by then lets the app open. */
export const STARTUP_CHECK_TIMEOUT_MS = 10_000;
/** At startup, how long a download runs before "Open without updating" appears. */
export const STARTUP_SKIP_AFTER_MS = 20_000;

/** What the splash shows while checkAtStartup runs. */
export type StartupStep =
  | { step: 'checking' }
  | { step: 'downloading'; percent: number; canSkip: boolean }
  | { step: 'installing' };

/** `continue`: open the app. `installing`: the installer runs and the app is quitting. */
export type StartupOutcome = 'continue' | 'installing';

export interface StartupCheckOptions {
  checkTimeoutMs?: number;
  skipAfterMs?: number;
  /** Progress for the splash. Never called when no check runs (turned off, unsupported). */
  onStep?: (step: StartupStep) => void;
  /** "Open without updating": resolves `continue` while the download goes on in the background. */
  signal?: AbortSignal;
}

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
  /** Downloads the signatures and checksums of a release (createReleaseFileFetcher in the app). */
  fetchReleaseFile: ReleaseFileFetcher;
  emit(state: UpdateState): void;
  log?: (message: string) => void;
  /** The clock of `lastCheckedAt` (Date.now unless a test passes its own). */
  now?: () => number;
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
  /** When a check last got an answer ("Você está na versão mais recente" shows it). */
  #lastCheckedAt: number | null = null;
  /** The version announced by update-available: the only one whose signatures are fetched. */
  #pendingVersion: string | null = null;
  #started = false;
  #firstCheck: ReturnType<typeof setTimeout> | null = null;
  #interval: ReturnType<typeof setInterval> | null = null;
  /** checkAtStartup's reaction to each state change while it waits. */
  #startupWatch: (() => void) | null = null;
  /** True while quitAndInstall runs: electron-updater reports a failed install as an error event and does not quit. */
  #installing = false;
  #installFailed = false;

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
    return {
      status: this.#status,
      autoCheck: this.#autoCheck,
      currentVersion: this.#opts.currentVersion,
      version: this.#version,
      percent: this.#percent,
      lastCheckedAt: this.#lastCheckedAt,
    };
  }

  /**
   * Configures electron-updater and schedules the checks: the first one 10 s from now, then every
   * 6 h. A no-op when unsupported, or when checkAtStartup already started the updater.
   */
  start(): void {
    this.#begin(FIRST_CHECK_DELAY_MS);
  }

  /**
   * "Atualizar ao abrir": the first check, before the main window exists. Resolves `continue` when
   * there is no update, the check fails or takes longer than `checkTimeoutMs`, the download fails
   * the signature check, or the person chooses "Open without updating" (offered after `skipAfterMs`
   * of downloading; the download then goes on and installs only through "Restart to update" or on
   * quit, as before). Resolves `installing` once a verified update is downloaded (or already was) and
   * quitAndInstall has been called. Turned off or unsupported: `continue` at once, `onStep` never
   * called. The 10 s delayed first check of start() does not run after this; the 6 h one does.
   * Never rejects.
   */
  async checkAtStartup(opts: StartupCheckOptions = {}): Promise<StartupOutcome> {
    const { checkTimeoutMs = STARTUP_CHECK_TIMEOUT_MS, skipAfterMs = STARTUP_SKIP_AFTER_MS, signal } = opts;
    // The splash may be gone (closed by the person): a failing listener never breaks the update.
    const onStep = (step: StartupStep) => {
      try {
        opts.onStep?.(step);
      } catch {
        this.#log('the splash could not show the update progress');
      }
    };
    if (this.#opts.backend === null || !this.#autoCheck || this.#startupWatch !== null) return 'continue';
    if (this.#started) this.#cancelFirstCheck();
    else this.#begin(null);
    if (this.#status === 'downloaded') return this.#installAtStartup(onStep);

    return new Promise<StartupOutcome>((resolve) => {
      let settled = false;
      let checkTimer: ReturnType<typeof setTimeout> | null = null;
      let skipTimer: ReturnType<typeof setTimeout> | null = null;
      let canSkip = false;
      const finish = (outcome: () => StartupOutcome) => {
        if (settled) return;
        settled = true;
        this.#startupWatch = null;
        if (checkTimer) clearTimeout(checkTimer);
        if (skipTimer) clearTimeout(skipTimer);
        signal?.removeEventListener('abort', skip);
        resolve(outcome());
      };
      const skip = () => {
        this.#log('opening without updating; the download goes on in the background');
        finish(() => 'continue');
      };
      const watch = () => {
        switch (this.#status) {
          case 'checking':
            onStep({ step: 'checking' });
            return;
          case 'downloading':
            // The time limit covers the check only: a download runs until it ends or the person skips it.
            if (checkTimer) clearTimeout(checkTimer);
            checkTimer = null;
            skipTimer ??= setTimeout(() => {
              canSkip = true;
              watch();
            }, skipAfterMs);
            onStep({ step: 'downloading', percent: this.#percent ?? 0, canSkip });
            return;
          case 'downloaded':
            finish(() => this.#installAtStartup(onStep));
            return;
          default: // idle (no update, or the check failed), rejected (signature), disabled
            finish(() => 'continue');
        }
      };
      if (signal?.aborted) return finish(() => 'continue');
      this.#startupWatch = watch;
      signal?.addEventListener('abort', skip, { once: true });
      checkTimer = setTimeout(() => {
        this.#log('the startup check took too long; opening the app');
        finish(() => 'continue');
      }, checkTimeoutMs);
      if (this.#status === 'checking' || this.#status === 'downloading') {
        watch(); // a check is already running: follow it
        return;
      }
      onStep({ step: 'checking' });
      void this.checkNow().then(() => {
        // electron-updater announces an update before checkForUpdates resolves: no download by now means none.
        if (this.#status !== 'downloading' && this.#status !== 'downloaded') finish(() => 'continue');
      });
    });
  }

  #begin(firstCheckDelay: number | null): void {
    const backend = this.#opts.backend;
    if (backend === null || this.#started) return;
    this.#started = true;
    backend.autoDownload = true;
    backend.autoInstallOnAppQuit = this.#autoCheck;
    backend.allowPrerelease = false;
    backend.allowDowngrade = false;
    backend.disableWebInstaller = true;
    backend.setFeedURL({ provider: 'github', owner: RELEASE_REPO.owner, repo: RELEASE_REPO.repo });
    backend.verifyUpdateCodeSignature = createInstallerVerifier(() => this.#pendingVersion, {
      fetchReleaseFile: this.#opts.fetchReleaseFile,
      runningVersion: this.#opts.currentVersion,
    });

    backend.on('checking-for-update', () => {
      if (this.#status !== 'downloading' && this.#status !== 'downloaded') this.#set('checking');
    });
    backend.on('update-available', (info: { version?: unknown }) => {
      this.#lastCheckedAt = this.#now();
      this.#pendingVersion = isReleaseVersion(info?.version) ? info.version : null;
      this.#set('downloading', this.#pendingVersion, 0);
    });
    backend.on('download-progress', (progress: { percent?: unknown }) => {
      if (this.#status !== 'downloading' || typeof progress?.percent !== 'number') return;
      const percent = Math.max(0, Math.min(100, Math.round(progress.percent)));
      if (percent !== this.#percent) this.#set('downloading', this.#version, percent);
    });
    backend.on('update-not-available', () => {
      this.#lastCheckedAt = this.#now();
      if (this.#status === 'checking') this.#set(this.#restingStatus());
      else this.#emit();
    });
    backend.on('update-downloaded', (info: { version?: unknown }) => {
      this.#set('downloaded', isReleaseVersion(info?.version) ? info.version : this.#pendingVersion);
    });
    backend.on('error', (error: { code?: unknown; message?: unknown }) => {
      this.#log(`update error: ${typeof error?.message === 'string' ? error.message : 'unknown'}`);
      if (this.#installing) this.#installFailed = true;
      if (error?.code === 'ERR_UPDATER_INVALID_SIGNATURE') this.#set('rejected', this.#pendingVersion);
      else if (this.#status === 'checking' || this.#status === 'downloading') this.#set(this.#restingStatus());
    });

    this.#schedule(firstCheckDelay);
  }

  /**
   * quitAndInstall(silent, run after): the installer replaces the app and reopens it. electron-updater
   * reports an install it could not start as an error event, synchronously, and then does not quit:
   * the app opens normally instead of waiting forever on "Installing…".
   */
  #installAtStartup(onStep: (step: StartupStep) => void): StartupOutcome {
    onStep({ step: 'installing' });
    this.#installing = true;
    this.#installFailed = false;
    try {
      this.#opts.backend!.quitAndInstall(true, true);
    } catch {
      this.#installFailed = true;
    } finally {
      this.#installing = false;
    }
    if (!this.#installFailed) return 'installing';
    this.#log('the downloaded update could not be installed; opening the app');
    return 'continue';
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

  /** `firstDelay` null: the startup check already ran, only the 6 h checks remain. */
  #schedule(firstDelay: number | null): void {
    if (!this.#autoCheck) return;
    if (firstDelay !== null) this.#firstCheck = setTimeout(() => void this.checkNow(), firstDelay);
    this.#interval = setInterval(() => void this.checkNow(), CHECK_INTERVAL_MS);
  }

  #cancelFirstCheck(): void {
    if (this.#firstCheck) clearTimeout(this.#firstCheck);
    this.#firstCheck = null;
  }

  #unschedule(): void {
    this.#cancelFirstCheck();
    if (this.#interval) clearInterval(this.#interval);
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
    this.#startupWatch?.();
  }

  #now(): number {
    return (this.#opts.now ?? Date.now)();
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
