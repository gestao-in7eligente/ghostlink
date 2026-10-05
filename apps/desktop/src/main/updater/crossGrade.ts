// The one-time switch to a same-version build a server offers (plan 2026-10-05-v083-troca-automatica, Task 5).
// On seeing a server that advertises a signed update channel, the app fetches the channel's latest.yml, confirms the
// offered version EQUALS the running one, downloads the installer, verifies it against the pinned release key exactly
// as a normal update is verified (updaterSignature.ts: verifyCrossGradeInstaller), and only then runs it and quits.
//
// It runs only in the public build, only with automatic updates on, only over https, only for a release version, and
// only after the full signature chain passes. A malicious channel can install nothing unsigned; the normal GitHub
// update path is untouched, so a server can neither inject nor block updates. The switch happens at most once per
// session. The channel path is a member's secret like the download code it carries, so it never reaches a log.
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isReleaseVersion } from '@ghostlink/shared';
import type { ReleaseFileFetcher, ReleaseFileLocation } from '../updaterSignature.js';

/** latest.yml is a few short lines; the installer is bounded well above any real build. */
export const LATEST_YML_MAX_BYTES = 64 * 1024;
export const MAX_INSTALLER_BYTES = 300 * 1024 * 1024;

/** A release file name served next to latest.yml: a plain name, no path, no traversal. */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface CrossGradeDeps {
  /** True only in the public build; another build updates through its own feed and must never cross-grade. */
  enabled: boolean;
  /** The running app's version. */
  currentVersion: string;
  /** Automatic updates are on (the switch never runs when the user turned updates off). */
  autoCheck: () => boolean;
  /** A normal update is downloading or waiting to install: the switch stands aside. */
  updateInFlight: () => boolean;
  /** The most recently seen channel among saved servers, or null (ServerChannelStore.latest). */
  channel: () => { url: string } | null;
  /** Where the installer is downloaded (app.getPath('temp')). */
  tempDir: string;
  /** The bounded fetcher for small signed files (latest.yml here). */
  fetchReleaseFile: ReleaseFileFetcher;
  /** Streams the installer to `destPath` with a size cap; resolves the path on success. */
  fetchInstaller: (url: string, maxBytes: number, destPath: string) => Promise<string>;
  /** verifyCrossGradeInstaller bound to the release key; null means it may install. */
  verify: (path: string, version: string, location: ReleaseFileLocation) => Promise<string | null>;
  /** Runs the verified installer and quits the app (injected native effect). */
  run: (path: string) => void | Promise<void>;
  log: (message: string) => void;
  now?: () => number;
}

/** The two fields of electron-builder's latest.yml the switch uses: the version and the top-level installer path. */
export function readLatestYml(text: string): { version: string | null; installer: string | null } {
  const field = (name: string): string | null => {
    const match = new RegExp(`^${name}:[ \\t]*(\\S.*?)[ \\t]*$`, 'm').exec(text);
    return match ? match[1]!.replace(/^['"]|['"]$/g, '') : null;
  };
  return { version: field('version'), installer: field('path') };
}

export class CrossGrade {
  readonly #deps: CrossGradeDeps;
  /** The switch is attempted at most once per session, whatever the outcome. */
  #started = false;

  constructor(deps: CrossGradeDeps) {
    this.#deps = deps;
  }

  /** The channel's update manifest. */
  latestYmlUrl(channelUrl: string): string {
    return `${channelUrl}latest.yml`;
  }

  /**
   * Tries the switch once: fetch latest.yml, confirm the equal version, download and verify the installer, then run
   * it. Any failure logs once (channel-path-safe) and leaves the normal updater alone. Never throws.
   */
  async maybeCrossGrade(): Promise<void> {
    const d = this.#deps;
    if (this.#started || !d.enabled || !d.autoCheck() || d.updateInFlight()) return;
    const channel = d.channel();
    if (channel === null) return;
    this.#started = true;
    try {
      await this.#attempt(channel.url);
    } catch (e) {
      this.#log(`the cross-grade did not run: ${e instanceof Error ? e.message : 'unknown error'}`);
    }
  }

  async #attempt(base: string): Promise<void> {
    const d = this.#deps;
    let text: string;
    try {
      const bytes = await d.fetchReleaseFile(this.latestYmlUrl(base), LATEST_YML_MAX_BYTES);
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      this.#log(`the update manifest could not be read: ${this.#reason(e)}`);
      return;
    }
    const manifest = readLatestYml(text);
    if (!isReleaseVersion(manifest.version) || manifest.version !== d.currentVersion) {
      this.#log('the offered version is not the running one; nothing was downloaded');
      return;
    }
    const installer = manifest.installer;
    if (installer === null || !FILE_NAME.test(installer) || installer.includes('..')) {
      this.#log('the offered installer name is not a plain file name; nothing was downloaded');
      return;
    }
    // The installer and its signed files are served next to latest.yml; the name comes from latest.yml, never assumed.
    const location: ReleaseFileLocation = {
      installerName: () => installer,
      fileUrl: (_version, file) => {
        if (!FILE_NAME.test(file) || file.includes('..')) throw new Error('invalid release file name');
        return `${base}${file}`;
      },
    };
    const destPath = join(d.tempDir, `ghostlink-update-${this.#now()}-${installer}`);
    let path: string;
    try {
      path = await d.fetchInstaller(location.fileUrl(manifest.version, installer), MAX_INSTALLER_BYTES, destPath);
    } catch (e) {
      this.#log(`the offered installer could not be downloaded: ${this.#reason(e)}`);
      return;
    }
    // The installer runs ONLY when the full release-key chain passes.
    const refusal = await d.verify(path, manifest.version, location);
    if (refusal !== null) {
      this.#log(`the offered installer was refused: ${refusal}`);
      return;
    }
    await d.run(path);
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)();
  }

  #reason(e: unknown): string {
    return e instanceof Error ? e.message : 'unknown error';
  }

  /** Never leaks the channel path: the advertised URL and any `/updates/<code>` in the line are masked. */
  #log(message: string): void {
    const url = this.#deps.channel()?.url;
    let out = `[cross-grade] ${message}`.replace(/\/updates\/[^/\s?#"'<>]+/g, '/updates/[redacted]');
    if (url !== undefined && url !== '') out = out.split(url).join('[redacted]');
    this.#deps.log(out);
  }
}

// ---- the real native effects (injected into CrossGrade; kept out of the tested class) ----

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** What the runner needs of child_process.spawn: start detached, ignore the pipes, let the parent exit. */
interface SpawnLike {
  (command: string, args: readonly string[], options: { detached: boolean; stdio: 'ignore' }): { unref(): void };
}

/**
 * Runs the verified installer silently and quits (plan Task 6). On Windows the NSIS installer is started with `/S`,
 * detached and unref'd, then the app quits so the installer can replace it; off Windows (no cross-grade build) it is
 * a no-op with a note. `spawn` and `quit` are injected (child_process.spawn and app.quit in the app).
 */
export function createCrossGradeRunner(deps: {
  platform: NodeJS.Platform;
  spawn: SpawnLike;
  quit: () => void;
  log: (message: string) => void;
}): (path: string) => void {
  return (path) => {
    if (deps.platform !== 'win32') {
      deps.log('[cross-grade] the installer runs on Windows only; staying on the current build');
      return;
    }
    deps.spawn(path, ['/S'], { detached: true, stdio: 'ignore' }).unref();
    deps.quit();
  };
}

/**
 * Streams the installer to `destPath` with the same HTTPS/redirect guards as createReleaseFileFetcher, aborting past
 * `maxBytes` so a hostile channel cannot fill the disk. `fetchImpl` is Electron's net.fetch in the app. A failed
 * download leaves no partial file behind.
 */
export function createInstallerFetcher(fetchImpl: FetchLike, timeoutMs = 120_000): (url: string, maxBytes: number, destPath: string) => Promise<string> {
  return async (url, maxBytes, destPath) => {
    if (!url.startsWith('https://')) throw new Error('the installer is only fetched over https');
    const response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
    if (response.url !== '' && !response.url.startsWith('https://')) throw new Error('the installer redirected away from https');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('empty response');
    const handle = await open(destPath, 'w');
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) {
          await reader.cancel();
          throw new Error('the installer is too large');
        }
        await handle.write(value);
      }
    } catch (e) {
      await handle.close();
      await rm(destPath, { force: true }).catch(() => {});
      throw e;
    }
    await handle.close();
    return destPath;
  };
}
