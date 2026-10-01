import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ProtocolError, normalizeNickname } from '@ghostlink/shared';
import type { Locale, Settings } from '../shared/ipcTypes.js';
import { readJsonFile, writeJsonAtomic } from './files.js';
import { HOSTED_DIR, HOST_FILE } from './hostManager.js';

export type { Locale, Settings } from '../shared/ipcTypes.js';

export const SETTINGS_FILE = 'settings.json';
export const LOCALES = ['pt-BR', 'en'] as const satisfies readonly Locale[];

/** spec §11: the first locale comes from the system — `pt*` becomes pt-BR, anything else en. */
export function localeFromSystem(systemLocale: string): Locale {
  return /^pt(?:[-_]|$)/i.test(systemLocale) ? 'pt-BR' : 'en';
}

const fileSchema = z.object({
  version: z.literal(1),
  locale: z.enum(LOCALES),
  nickname: z.string().max(256),
  /** v0.3.2, optional: files written before have neither (and an older app drops them). */
  closeToTray: z.boolean().optional(),
  trayNoticeShown: z.boolean().optional(),
});
type SettingsFile = z.infer<typeof fileSchema>;

const legacyHostSchema = z.object({ trayNoticeShown: z.boolean() });

/**
 * Before v0.3.2 the "still running in the tray" notice was remembered in `hosted/host.json`.
 * Read only: that file belongs to HostManager, and a broken one is its business.
 */
function legacyTrayNoticeShown(userDataDir: string): boolean {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(userDataDir, HOSTED_DIR, HOST_FILE), 'utf8'));
    return legacyHostSchema.safeParse(raw).data?.trayNoticeShown === true;
  } catch {
    return false;
  }
}

/** `<userData>/settings.json` — local preferences only; never secrets (the password is never stored). */
export class SettingsStore {
  readonly #path: string;
  #settings: Settings;
  /** The tray notice is shown once ever; main's own state, never sent to the page. */
  #trayNoticeShown: boolean;

  private constructor(path: string, settings: Settings, trayNoticeShown: boolean) {
    this.#path = path;
    this.#settings = settings;
    this.#trayNoticeShown = trayNoticeShown;
  }

  static load(userDataDir: string, systemLocale: string): SettingsStore {
    const path = join(userDataDir, SETTINGS_FILE);
    const file = readJsonFile<SettingsFile>(path, fileSchema, () => ({ version: 1, locale: localeFromSystem(systemLocale), nickname: '' }));
    return new SettingsStore(
      path,
      { locale: file.locale, nickname: file.nickname, closeToTray: file.closeToTray ?? true },
      file.trayNoticeShown ?? legacyTrayNoticeShown(userDataDir),
    );
  }

  get(): Settings {
    return { ...this.#settings };
  }

  /**
   * Applies a validated patch and persists it. The nickname is stored in its
   * normalized display form (spec §7); an invalid one throws ProtocolError('BAD_REQUEST')
   * and leaves both the file and the in-memory settings untouched.
   */
  set(patch: Partial<Settings>): Settings {
    const next: Settings = { ...this.#settings };
    if (patch.locale !== undefined) {
      if (!LOCALES.includes(patch.locale)) throw new ProtocolError('BAD_REQUEST', 'unknown locale');
      next.locale = patch.locale;
    }
    if (patch.nickname !== undefined) next.nickname = normalizeNickname(patch.nickname).display;
    if (patch.closeToTray !== undefined) {
      if (typeof patch.closeToTray !== 'boolean') throw new ProtocolError('BAD_REQUEST', 'closeToTray must be a boolean');
      next.closeToTray = patch.closeToTray;
    }
    this.#write(next, this.#trayNoticeShown);
    this.#settings = next;
    return this.get();
  }

  trayNoticeShown(): boolean {
    return this.#trayNoticeShown;
  }

  /** Remembered at once in memory, so a failed write never shows the notice twice in one run. */
  markTrayNoticeShown(): void {
    this.#trayNoticeShown = true;
    this.#write(this.#settings, true);
  }

  #write(settings: Settings, trayNoticeShown: boolean): void {
    writeJsonAtomic(this.#path, { version: 1, ...settings, trayNoticeShown });
  }
}
