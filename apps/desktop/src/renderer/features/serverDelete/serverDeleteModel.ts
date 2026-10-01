// Leaving and deleting a server (spec 2026-10-01-sair-e-excluir-servidor-design.md), the pure part:
// which menu item shows, the delete modal's name check, the owner's band and the members' messages.
import { serverDeleteWelcomeSchemaClient } from '@ghostlink/shared';
import type { AppErrorCode } from '../../../shared/appErrors.js';
import type { Locale, ServerExitCheck } from '../../../shared/ipcTypes.js';
import type { MessageKey, Vars } from '../../i18n/index.js';

/** The one way out a server's menus offer. "Remover da lista" is gone (spec §1). */
export type ServerExitAction = 'leave' | 'delete';

export interface ServerExitView {
  /** It is the server open right now, so its owner and its features are known. */
  connected: boolean;
  owner: boolean;
  /** The server has the `serverDelete` feature. */
  canDelete: boolean;
}

/**
 * The item of the rail's right-click, the Home list's ⋮ and the server header's menu (spec §2, §3):
 * members "Sair do servidor", the owner "Excluir servidor" (only on a server that can delete itself;
 * the owner never sees "Sair", as in Discord). A server that is not open says who owns it only once
 * the app connects, so its menus offer "Sair" and the dialog connects first (ExitServerDialog).
 */
export function exitMenuItem(view: ServerExitView): ServerExitAction | null {
  if (!view.connected) return 'leave';
  if (!view.owner) return 'leave';
  return view.canDelete ? 'delete' : null;
}

/**
 * The delete modal's button unlocks only with the server's exact name (spec §3): the same letters,
 * accents and case. Only the spaces around it are forgiven (a copied name often brings one).
 */
export function confirmsServerName(typed: string, name: string): boolean {
  const want = name.normalize('NFC').trim();
  return want !== '' && typed.normalize('NFC').trim() === want;
}

/** The welcome's `serverDelete.deletingAt` (ms, the server's clock), or null (also from an old server). */
export function welcomeDeletingAt(welcome: unknown): number | null {
  if (typeof welcome !== 'object' || welcome === null) return null;
  const parsed = serverDeleteWelcomeSchemaClient.safeParse((welcome as Record<string, unknown>).serverDelete);
  return parsed.success ? parsed.data.deletingAt : null;
}

export interface Countdown {
  key: MessageKey;
  vars: Vars;
}

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

/** "47 h", "35 min" or "instantes": what is left before the erase (whole hours, rounded down). */
export function deletionCountdown(at: number, now: number): Countdown {
  const left = at - now;
  if (left >= HOUR) return { key: 'serverDelete.inHours', vars: { count: Math.floor(left / HOUR) } };
  if (left >= MINUTE) return { key: 'serverDelete.inMinutes', vars: { count: Math.floor(left / MINUTE) } };
  return { key: 'serverDelete.inMoments', vars: {} };
}

/** The owner's red band (spec §3): "{servidor} está fora do ar e será excluído em {tempo}", or nothing. */
export function deletionBanner(input: { owner: boolean; deletingAt: number | null; name: string; now: number }): { name: string; countdown: Countdown } | null {
  if (!input.owner || input.deletingAt === null) return null;
  return { name: input.name, countdown: deletionCountdown(input.deletingAt, input.now) };
}

/** The deadline as a date and time in the user's language, e.g. "03/10/2026, 15:40". */
export function formatDeadline(at: number, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(at));
}

export interface DeletionMessage {
  title: MessageKey;
  text: MessageKey;
  vars: Vars;
}

/**
 * What a member reads when the owner deleted the server (spec §3 "App dos membros"): disconnected
 * or refused with SERVER_DELETING ("… será excluído em {data}"), or SERVER_DELETED. The owner's
 * own session ends at the deadline too: "{servidor} foi excluído". Null for any other failure.
 */
export function deletionMessage(code: AppErrorCode | null, name: string, deletingAt: number | null, locale: Locale, owner = false): DeletionMessage | null {
  if (code === 'SERVER_DELETED') return { title: 'serverDelete.deletedTitle', text: owner ? 'serverDelete.deletedOwn' : 'serverDelete.deleted', vars: { name } };
  if (code !== 'SERVER_DELETING') return null;
  if (deletingAt === null) return { title: 'serverDelete.lostTitle', text: 'serverDelete.deletingSoon', vars: { name } };
  return { title: 'serverDelete.lostTitle', text: 'serverDelete.deleting', vars: { name, date: formatDeadline(deletingAt, locale) } };
}

/** What "Sair do servidor" shows for a server that is not open, once the app reached it (or not). */
export type ExitDialogStep =
  | { step: 'checking' }
  | { step: 'leave' }
  | { step: 'delete'; name: string }
  | { step: 'ownerCannot' }
  | { step: 'ownerDeleting'; at: number }
  | { step: 'deleting'; at: number | null }
  | { step: 'deleted' }
  | { step: 'unreachable'; code: AppErrorCode };

export function exitDialogStep(check: ServerExitCheck | null): ExitDialogStep {
  if (check === null) return { step: 'checking' };
  switch (check.kind) {
    case 'member':
      return { step: 'leave' };
    case 'owner':
      if (check.deletingAt !== null) return { step: 'ownerDeleting', at: check.deletingAt };
      return check.canDelete ? { step: 'delete', name: check.name } : { step: 'ownerCannot' };
    case 'deleting':
      return { step: 'deleting', at: check.at };
    case 'deleted':
      return { step: 'deleted' };
    case 'unreachable':
      return { step: 'unreachable', code: check.code };
  }
}

/**
 * A leave that failed because the server could not be reached (or no longer takes me): the dialog
 * offers "Tirar só da minha lista" (spec §2) instead of only showing the error.
 */
export function offersRemoveOnly(code: AppErrorCode): boolean {
  return !STAYS_IN_DIALOG.has(code);
}

/** Failures the server answered for this very request: the dialog shows them and stays as it is. */
const STAYS_IN_DIALOG: ReadonlySet<AppErrorCode> = new Set<AppErrorCode>(['RATE_LIMITED', 'OWNER_MUST_TRANSFER', 'FORBIDDEN', 'BAD_REQUEST', 'INTERNAL', 'IDENTITY_UNAVAILABLE']);
