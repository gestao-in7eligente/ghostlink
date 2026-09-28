import { join } from 'node:path';
import { z } from 'zod';
import { ProtocolError, normalizeNickname } from '@ghostlink/shared';
import type { Locale, Settings } from '../shared/ipcTypes.js';
import { readJsonFile, writeJsonAtomic } from './files.js';

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
});

/** `<userData>/settings.json` — local preferences only; never secrets (the password is never stored). */
export class SettingsStore {
  readonly #path: string;
  #settings: Settings;

  private constructor(path: string, settings: Settings) {
    this.#path = path;
    this.#settings = settings;
  }

  static load(userDataDir: string, systemLocale: string): SettingsStore {
    const path = join(userDataDir, SETTINGS_FILE);
    const file = readJsonFile(path, fileSchema, () => ({ version: 1 as const, locale: localeFromSystem(systemLocale), nickname: '' }));
    return new SettingsStore(path, { locale: file.locale, nickname: file.nickname });
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
    writeJsonAtomic(this.#path, { version: 1, ...next });
    this.#settings = next;
    return this.get();
  }
}
