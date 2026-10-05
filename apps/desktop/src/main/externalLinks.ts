import { chat as chatEn } from '../renderer/i18n/chat.en.js';
import { chat as chatPt } from '../renderer/i18n/chat.pt-BR.js';
import type { Locale } from '../shared/ipcTypes.js';

const MAX_URL_LENGTH = 2048;

/**
 * Only plain http(s) links leave the app (spec §12). Links with credentials
 * ("https://bank.com@evil.example") are refused: the dialog could not show
 * them honestly. Returns the normalized URL, or null.
 */
export function safeExternalUrl(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '' || url.hostname === '') return null;
  return url.href;
}

export interface LinkDialog {
  title: string;
  message: string;
  detail: string;
  buttons: [open: string, cancel: string];
}

/** The confirmation texts, in the app language (from the chat i18n namespace). */
export function linkDialog(locale: Locale, url: string): LinkDialog {
  const t = locale === 'pt-BR' ? chatPt : chatEn;
  return {
    title: t['chat.link.title'],
    message: t['chat.link.message'],
    detail: url,
    buttons: [t['chat.link.open'], t['chat.link.cancel']],
  };
}

export interface ExternalLinkDeps {
  locale(): Locale;
  /** Shows the dialog; resolves with the index of the clicked button. */
  confirm(dialog: LinkDialog): Promise<number>;
  open(url: string): Promise<void>;
}

/** Opens `raw` in the default browser after the user confirms it (spec §11.1, §12). */
export async function openExternalWithConfirm(raw: string, deps: ExternalLinkDeps): Promise<boolean> {
  const url = safeExternalUrl(raw);
  if (url === null) return false;
  const choice = await deps.confirm(linkDialog(deps.locale(), url));
  if (choice !== 0) return false;
  await deps.open(url);
  return true;
}
