// What the Updates page shows for an updater state: pure, so every state is tested without a DOM.
import type { Locale } from '../../../shared/ipcTypes.js';
import type { UpdateState } from '../../../shared/updates.js';
import type { Translate } from '../../i18n/index.js';

export type UpdateStatusView =
  /** Development build or not the installed Windows app: explained, nothing to check. */
  | { kind: 'unsupported' }
  /** Automatic checks off and no check by hand yet. */
  | { kind: 'disabled' }
  /** No check has answered yet this session. */
  | { kind: 'idle' }
  | { kind: 'checking' }
  /** The last "Procurar atualizações" got no answer (offline, GitHub down). */
  | { kind: 'checkFailed' }
  | { kind: 'upToDate'; checkedAt: number }
  | { kind: 'downloading'; version: string; percent: number }
  /** "Atualizar e reiniciar". */
  | { kind: 'downloaded'; version: string }
  /** The download failed the release-signature check and was deleted. */
  | { kind: 'rejected'; version: string };

export interface UpdatePageModel {
  status: UpdateStatusView;
  /** "Procurar atualizações" is shown (it never is where updates do not run). */
  showCheck: boolean;
  /** …and can be clicked: not while a check runs or an update downloads or waits. */
  canCheck: boolean;
  /** The found version whose "O que muda na <versão>" is shown. */
  newVersion: string | null;
}

/** `checkFailed`: the person's last "Procurar atualizações" ended without an answer (see checkFailed()). */
export function updatePageModel(state: UpdateState, checkFailed = false): UpdatePageModel {
  const version = state.version ?? '?';
  const found = state.version;
  switch (state.status) {
    case 'unsupported':
      return { status: { kind: 'unsupported' }, showCheck: false, canCheck: false, newVersion: null };
    case 'checking':
      return { status: { kind: 'checking' }, showCheck: true, canCheck: false, newVersion: null };
    case 'downloading':
      return { status: { kind: 'downloading', version, percent: Math.max(0, Math.min(100, state.percent ?? 0)) }, showCheck: true, canCheck: false, newVersion: found };
    case 'downloaded':
      return { status: { kind: 'downloaded', version }, showCheck: true, canCheck: false, newVersion: found };
    case 'rejected':
      return { status: { kind: 'rejected', version }, showCheck: true, canCheck: true, newVersion: null };
    case 'idle':
    case 'disabled': {
      const status: UpdateStatusView = checkFailed
        ? { kind: 'checkFailed' }
        : state.lastCheckedAt !== null
          ? { kind: 'upToDate', checkedAt: state.lastCheckedAt }
          : { kind: state.status };
      return { status, showCheck: true, canCheck: true, newVersion: null };
    }
  }
}

/**
 * Whether a "Procurar atualizações" got no answer: it ended at rest (no update found and none
 * downloading) without a newer `lastCheckedAt` than before the click.
 */
export function checkFailed(before: UpdateState, after: UpdateState): boolean {
  if (after.status !== 'idle' && after.status !== 'disabled') return false;
  return after.lastCheckedAt === null || (before.lastCheckedAt !== null && after.lastCheckedAt <= before.lastCheckedAt);
}

/** "Última verificação: hoje, às 14:02." — or with the date when it was not today. */
export function lastCheckedText(t: Translate, locale: Locale, checkedAt: number, now: number = Date.now()): string {
  const at = new Date(checkedAt);
  const time = new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(at);
  if (at.toDateString() === new Date(now).toDateString()) return t('updates.page.checkedToday', { time });
  const date = new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', year: 'numeric' }).format(at);
  return t('updates.page.checkedOn', { date, time });
}
