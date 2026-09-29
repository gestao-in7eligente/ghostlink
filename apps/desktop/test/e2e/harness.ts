// Shared plumbing of the end-to-end runs (npm run test:e2e): Electron instances driven by
// Playwright, each with its own profile, Chromium's fake microphone fed with a speech-like
// signal (--use-fake-device-for-media-stream, and deliberately NOT --use-fake-ui-for-media-stream:
// the app's own permission handler answers), and a cleanup that leaves no process behind.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { killStaleLivekit } from '../../../server/src/livekit/pidfile.js';

// No trailing separator: on Windows Playwright quotes each argument, and a final backslash would escape the quote.
const desktopDir = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

export interface Instance {
  name: string;
  app: ElectronApplication;
  page: Page;
  userData: string;
  /** The Electron main process. */
  pid: number | undefined;
  log: string[];
}

const RM = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 } as const;
const INHERITED_NOT = new Set([
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_RENDERER_URL',
  'GHOSTLINK_USER_DATA',
  'GHOSTLINK_HOST_BIND',
  'GHOSTLINK_SMOKE',
  'GHOSTLINK_REGISTER_PROTOCOL',
]);

/**
 * The Electron instances and scratch directories of one test file. `close()` quits every
 * app (a hosting app stops its server and LiveKit first), kills whatever is still alive,
 * and deletes the profiles — also when a launch or a step failed.
 */
export class E2eRun {
  readonly instances: Instance[] = [];
  readonly #dirs: string[] = [];
  readonly #stoppers: Array<() => Promise<unknown>> = [];
  #speechWav: string | null = null;

  /** Something to stop after the apps quit and before the directories go, e.g. a server using one of them. */
  onClose(stop: () => Promise<unknown>): void {
    this.#stoppers.push(stop);
  }

  /** A fresh directory under the system temp dir, deleted by close(). */
  tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), `ghostlink-e2e-${prefix}-`));
    this.#dirs.push(dir);
    return dir;
  }

  /** The fake microphone's input, written once per run. */
  speechWav(): string {
    if (!this.#speechWav) {
      this.#speechWav = join(this.tempDir('media'), 'speech.wav');
      writeSpeechWav(this.#speechWav);
    }
    return this.#speechWav;
  }

  /** Starts the built app (out/) with its own profile. `env` adds variables, e.g. GHOSTLINK_HOST_BIND. */
  async launch(name: string, env: Record<string, string> = {}): Promise<Instance> {
    const userData = this.tempDir(name);
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      // VS Code's terminal exports ELECTRON_RUN_AS_NODE=1, which turns Electron into plain Node;
      // ELECTRON_RENDERER_URL would point the app at a dev server; the app's own test hooks
      // come only from `env` below. Windows variable names ignore case.
      const upper = key.toUpperCase();
      if (value === undefined || INHERITED_NOT.has(upper)) continue;
      childEnv[key] = value;
    }
    Object.assign(childEnv, env, { GHOSTLINK_USER_DATA: userData });
    // Playwright finds Electron itself and preloads its loader (it skips the loader with executablePath).
    const app = await electron.launch({
      args: [desktopDir, '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${this.speechWav()}`, '--lang=pt-BR'],
      env: childEnv,
      timeout: 60_000,
    });
    const log: string[] = [];
    const instance: Instance = { name, app, page: null as unknown as Page, userData, pid: app.process().pid, log };
    this.instances.push(instance);
    instance.page = await app.firstWindow();
    instance.page.on('console', (m) => log.push(`[${name}] ${m.type()}: ${m.text()}`));
    instance.page.on('pageerror', (e) => log.push(`[${name}] pageerror: ${e.message}`));
    return instance;
  }

  /** Console lines, the main-process log and a screenshot of every instance, for a failed step. */
  async report(step: string): Promise<void> {
    const label = step.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40);
    // The tail of each log is enough; LiveKit's signaling URLs are long, so lines are cut.
    const tail = (lines: string[]) => lines.slice(-60).map((l) => (l.length > 400 ? `${l.slice(0, 400)}…` : l)).join('\n');
    for (const i of this.instances) {
      console.log(`--- ${i.name}: renderer console\n${tail(i.log)}`);
      const mainLog = join(i.userData, 'logs', 'main.log');
      if (existsSync(mainLog)) console.log(`--- ${i.name}: main.log\n${tail(readFileSync(mainLog, 'utf8').split('\n'))}`);
      const hostLogs = await i.page.evaluate('window.ghostlink.host.logs()').catch(() => null);
      if (Array.isArray(hostLogs) && hostLogs.length > 0) console.log(`--- ${i.name}: hosted server\n${tail(hostLogs.map(String))}`);
      await i.page.screenshot({ path: join(tmpdir(), `ghostlink-e2e-fail-${label}-${i.name}.png`) }).catch(() => {});
    }
  }

  /**
   * Quitting must end everything by itself (spec §9: "Sair" stops the hosted server and
   * LiveKit): whatever had to be killed is reported as a failure, after the cleanup.
   */
  async close(): Promise<void> {
    const errors: unknown[] = [];
    for (const i of this.instances.splice(0)) {
      if (!(await closeInstance(i))) errors.push(new Error(`${i.name} did not quit within 45 s (its process tree was killed)`));
    }
    for (const stop of this.#stoppers.splice(0)) await stop().catch((e: unknown) => errors.push(e));
    for (const dir of this.#dirs.splice(0)) {
      if (await killLivekitOf(dir)) errors.push(new Error(`a livekit-server outlived its app (${dir}); it was killed`));
      try {
        rmSync(dir, RM);
      } catch (e) {
        errors.push(e);
      }
    }
    this.#speechWav = null;
    if (errors.length > 0) throw new AggregateError(errors, 'e2e cleanup failed');
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

/**
 * Quits the app like "Sair" (a hosted server stops first). A hung app is killed with its
 * children; returns false then.
 */
async function closeInstance(i: Instance): Promise<boolean> {
  await Promise.race([i.app.close().catch(() => {}), delay(45_000)]);
  if (i.pid === undefined) return true;
  for (let n = 0; n < 20 && isAlive(i.pid); n++) await delay(250);
  if (!isAlive(i.pid)) return true;
  killTree(i.pid);
  return false;
}

/**
 * Kills a LiveKit that outlived its server: a pidfile still names it, either at the top of
 * a server data dir or in a profile's `hosted/<server>/`. The server's own stale-process
 * check does it: only a running process whose executable is that livekit-server (a
 * recycled PID may belong to anything else). Returns whether one was killed.
 */
async function killLivekitOf(dir: string): Promise<boolean> {
  const pidfiles = [join(dir, 'livekit.pid')];
  const hosted = join(dir, 'hosted');
  if (existsSync(hosted)) {
    for (const entry of readdirSync(hosted, { withFileTypes: true })) {
      if (entry.isDirectory()) pidfiles.push(join(hosted, entry.name, 'livekit.pid'));
    }
  }
  let killed = false;
  for (const pidfile of pidfiles) {
    if (!existsSync(pidfile)) continue;
    let exe: unknown;
    try {
      exe = (JSON.parse(readFileSync(pidfile, 'utf8')) as { exe?: unknown }).exe;
    } catch {
      continue; // unreadable: nothing we can safely kill
    }
    if (typeof exe === 'string' && (await killStaleLivekit(pidfile, exe)) === 'killed') killed = true;
  }
  return killed;
}

/**
 * A speech-like signal for Chromium's fake microphone (48 kHz mono PCM, 12 s, looped):
 * "syllables" of 180–320 ms with a changing pitch and harmonics, then short pauses. Its
 * default fake input is a brief beep that LiveKit's speaker detection may or may not count,
 * and a steady tone is faded out by noise suppression (which the app keeps on, spec §8.2).
 */
export function writeSpeechWav(path: string): void {
  const rate = 48_000;
  const seconds = 12;
  const pcm = new Int16Array(rate * seconds);
  let t = 0;
  let syllable = 0;
  while (t < pcm.length) {
    const voiced = Math.floor(rate * (0.18 + ((syllable * 37) % 15) / 100));
    const pause = Math.floor(rate * (0.06 + ((syllable * 23) % 7) / 100));
    const f0 = 110 + ((syllable * 53) % 120);
    let phase = 0;
    for (let i = 0; i < voiced && t + i < pcm.length; i++) {
      const env = Math.min(1, i / (rate * 0.02), (voiced - i) / (rate * 0.04));
      const f = f0 * (1 + 0.15 * Math.sin((2 * Math.PI * i) / voiced));
      phase += (2 * Math.PI * f) / rate;
      let v = 0;
      for (let h = 1; h <= 12; h++) v += Math.sin(h * phase) / h;
      pcm[t + i] = Math.round(Math.max(-1, Math.min(1, v * 0.35 * env)) * 32767);
    }
    t += voiced + pause;
    syllable++;
  }
  const data = Buffer.from(pcm.buffer);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}

/** spec §11.1: welcome → nickname (the identity is created) → backup notice → "O que você quer fazer?". */
export async function onboard(page: Page, nickname: string, choice: 'Entrar num servidor' | 'Hospedar um servidor'): Promise<void> {
  await page.getByRole('button', { name: 'Começar' }).click();
  await page.getByRole('textbox').fill(nickname);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByRole('button', { name: 'Entendi' }).click();
  await page.getByRole('button', { name: choice }).click();
}

/** The Join screen, from the pasted invite to the main layout: paste → accept → nickname → connect. */
export async function joinWithInvite(page: Page, invite: string): Promise<void> {
  await page.getByRole('textbox').fill(invite);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.getByRole('button', { name: 'Aceitar convite' }).click();
  await page.getByRole('button', { name: 'Conectar' }).click();
}

/** A text channel's row in the sidebar (data-channel = its id). */
export const textChannel = (page: Page, name: string) => page.locator('[data-channel]', { hasText: name });
/** A voice channel's row in the sidebar (data-voice-channel = its id). */
export const voiceChannel = (page: Page, name: string) => page.locator('[data-voice-channel]', { hasText: name });
/** The tile of `nickname` in the open voice stage. */
export const tile = (page: Page, nickname: string) => page.locator('[data-voice-stage] [data-user]', { hasText: nickname });
/** The row of `nickname` under a voice channel in the sidebar. */
export const voiceRow = (page: Page, channelId: string, nickname: string) => page.locator(`[data-voice-participants="${channelId}"] [data-user]`, { hasText: nickname });

/**
 * The loudest level (dBFS) of `userId`'s audio as this app decodes it, over about 400 ms:
 * the remote element's stream through an analyser in the page. Proves audio arrives,
 * independently of LiveKit's speaker detection. (A string: the tests have no DOM types.)
 */
export function receivedLevelDb(page: Page, userId: string): Promise<number> {
  return page.evaluate(`(async (id) => {
    const el = document.querySelector('audio[data-voice-user="' + id + '"]');
    const stream = el && el.srcObject;
    if (!(stream instanceof MediaStream)) return -200;
    const ctx = new AudioContext();
    try {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      let peak = -200;
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 50));
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        const rms = Math.sqrt(sum / buf.length);
        peak = Math.max(peak, rms > 0 ? 20 * Math.log10(rms) : -200);
      }
      return peak;
    } finally {
      await ctx.close();
    }
  })(${JSON.stringify(userId)})`);
}

/** `window.ghostlink.server.request(type, payload)` in the page: "ok", or the error code it failed with. */
export function requestOutcome(page: Page, type: string, payload: unknown): Promise<string> {
  return page.evaluate(`(async () => {
    try {
      await window.ghostlink.server.request(${JSON.stringify(type)}, ${JSON.stringify(payload)});
      return 'ok';
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  })()`);
}
