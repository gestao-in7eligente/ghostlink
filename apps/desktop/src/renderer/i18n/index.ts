import { useCallback } from 'react';
import { isAppErrorCode, type AppErrorCode } from '../../shared/appErrors.js';
import type { Locale } from '../../shared/ipcTypes.js';
import { useSettingsStore } from '../stores/settings.js';
import { messages as en } from './en.js';
import { messages as ptBR } from './pt-BR.js';

export type MessageKey = keyof typeof ptBR;
export type Vars = Readonly<Record<string, string | number>>;
export type Translate = (key: MessageKey, vars?: Vars) => string;

export const CATALOGS: Readonly<Record<Locale, Readonly<Record<MessageKey, string>>>> = { 'pt-BR': ptBR, en };

/** Before settings load (a few ms), texts use the primary audience's language. */
export const DEFAULT_LOCALE: Locale = 'pt-BR';

// Compile-time guarantee: every server and client error code has a message (spec §5.1, §11).
export const ERROR_MESSAGE_KEYS: Readonly<Record<`errors.${AppErrorCode}`, string>> = ptBR;

/** Looks the key up and fills `{name}` placeholders; unknown placeholders are left as they are. */
export function translate(locale: Locale, key: MessageKey, vars?: Vars): string {
  const template = CATALOGS[locale][key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (Object.hasOwn(vars, name) ? String(vars[name]) : match));
}

/** The translated message for an error code; anything unknown reads as INTERNAL (spec §2.1: the client translates codes). */
export function errorMessage(t: Translate, code: string): string {
  return isAppErrorCode(code) ? t(`errors.${code}`) : t('errors.INTERNAL');
}

/** The code carried by a rejected window.ghostlink call (the preload sets the message to the code). */
export function errorCodeOf(e: unknown): AppErrorCode {
  const message = e instanceof Error ? e.message : '';
  return isAppErrorCode(message) ? message : 'INTERNAL';
}

export function useT(): Translate {
  const locale = useSettingsStore((s) => s.settings?.locale ?? DEFAULT_LOCALE);
  return useCallback((key: MessageKey, vars?: Vars) => translate(locale, key, vars), [locale]);
}
